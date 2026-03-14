import { Interface, JsonRpcProvider, Signer } from 'ethers';
import { agreementIdToUint256 } from './conversion';
import { MessageStore } from './store';

const AGREEMENT_IFACE = new Interface([
  'function getAgreement(uint256 agreementId) view returns (uint256 id,uint256 proposalId,string agentRegistry,uint256 agentId,uint256 lenderPositionId,bytes32 lenderPositionKey,address settlementAsset,uint8 mode,uint8 status,uint256 creditLimit,uint256 unitLimit,uint256 principalDrawn,uint256 principalRepaid,uint256 interestAccrued,uint256 feesAccrued,uint256 principalEncumbered,uint256 unitsEncumbered,address borrower,address lender,bytes32 providerId)',
]);

const INTEREST_IFACE = new Interface([
  'function getInterestConfig(uint256 agreementId) view returns (uint16 annualRateBps,uint16 originationFeeBps,uint16 serviceFeeBps,uint16 lateFeeBps,uint40 lastAccrualAt)',
  'function accrueInterest(uint256 agreementId)',
]);

export interface InterestAccrualRunItem {
  agreementId: string;
  status: 'accrued' | 'skipped' | 'failed';
  reason?: string;
  txHash?: string;
}

export interface InterestAccrualRunResult {
  processed: number;
  accrued: number;
  skipped: number;
  failed: number;
  results: InterestAccrualRunItem[];
}

interface LoggerLike {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}

export interface InterestAccrualServiceOptions {
  accrualThresholdSeconds?: number;
  maxAgreementsPerCycle?: number;
  logger?: LoggerLike;
}

export class InterestAccrualService {
  private readonly accrualThresholdSeconds: number;
  private readonly maxAgreementsPerCycle: number;
  private readonly logger: LoggerLike;

  constructor(
    private readonly store: MessageStore,
    private readonly provider: JsonRpcProvider,
    private readonly signer: Signer,
    private readonly interestFacetAddress: string,
    options: InterestAccrualServiceOptions = {}
  ) {
    this.accrualThresholdSeconds = options.accrualThresholdSeconds ?? 3600;
    this.maxAgreementsPerCycle = options.maxAgreementsPerCycle ?? 200;
    this.logger = options.logger ?? console;
  }

  async run(): Promise<InterestAccrualRunResult> {
    const activeAgreements = this.store.listAgreementStates('active', this.maxAgreementsPerCycle);
    const results: InterestAccrualRunItem[] = [];

    let chainTimestamp = Math.floor(Date.now() / 1000);
    try {
      const latest = await this.provider.getBlock('latest');
      if (latest?.timestamp) {
        chainTimestamp = Number(latest.timestamp);
      }
    } catch (error) {
      this.logger.warn?.({ error }, 'interest-accrual: failed to read chain timestamp, using system time');
    }

    for (const state of activeAgreements) {
      const agreementId = state.agreementId;
      let agreementIdUint: bigint;
      try {
        agreementIdUint = agreementIdToUint256(agreementId);
      } catch {
        results.push({ agreementId, status: 'failed', reason: 'invalid_agreement_id' });
        continue;
      }

      try {
        const agreement = await this.readAgreement(agreementIdUint);
        const principalOutstanding =
          agreement.principalDrawn > agreement.principalRepaid
            ? agreement.principalDrawn - agreement.principalRepaid
            : 0n;

        if (principalOutstanding === 0n) {
          results.push({ agreementId, status: 'skipped', reason: 'no_principal_outstanding' });
          continue;
        }

        const config = await this.readInterestConfig(agreementIdUint);
        if (config.annualRateBps === 0n && config.serviceFeeBps === 0n && config.lateFeeBps === 0n) {
          results.push({ agreementId, status: 'skipped', reason: 'zero_interest_and_fee_rates' });
          continue;
        }

        const lastAccrual = Number(config.lastAccrualAt);
        if (lastAccrual > 0 && chainTimestamp - lastAccrual < this.accrualThresholdSeconds) {
          results.push({ agreementId, status: 'skipped', reason: 'below_threshold' });
          continue;
        }

        const tx = await this.signer.sendTransaction({
          to: this.interestFacetAddress,
          data: INTEREST_IFACE.encodeFunctionData('accrueInterest', [agreementIdUint]),
        });
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          results.push({ agreementId, status: 'failed', reason: 'tx_reverted', txHash: tx.hash });
          this.logger.error?.({ agreementId, txHash: tx.hash }, 'interest-accrual: transaction reverted');
          continue;
        }

        results.push({ agreementId, status: 'accrued', txHash: tx.hash });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ agreementId, status: 'failed', reason: message });
        this.logger.error?.({ agreementId, error: message }, 'interest-accrual: cycle item failed');
      }
    }

    return {
      processed: results.length,
      accrued: results.filter((item) => item.status === 'accrued').length,
      skipped: results.filter((item) => item.status === 'skipped').length,
      failed: results.filter((item) => item.status === 'failed').length,
      results,
    };
  }

  private async readAgreement(agreementId: bigint): Promise<{ principalDrawn: bigint; principalRepaid: bigint }> {
    const callData = AGREEMENT_IFACE.encodeFunctionData('getAgreement', [agreementId]);
    const raw = await this.provider.call({
      to: this.interestFacetAddress,
      data: callData,
    });
    const decoded = AGREEMENT_IFACE.decodeFunctionResult('getAgreement', raw);

    return {
      principalDrawn: BigInt(decoded.principalDrawn),
      principalRepaid: BigInt(decoded.principalRepaid),
    };
  }

  private async readInterestConfig(
    agreementId: bigint
  ): Promise<{ annualRateBps: bigint; serviceFeeBps: bigint; lateFeeBps: bigint; lastAccrualAt: bigint }> {
    const callData = INTEREST_IFACE.encodeFunctionData('getInterestConfig', [agreementId]);
    const raw = await this.provider.call({
      to: this.interestFacetAddress,
      data: callData,
    });
    const decoded = INTEREST_IFACE.decodeFunctionResult('getInterestConfig', raw);

    return {
      annualRateBps: BigInt(decoded.annualRateBps),
      serviceFeeBps: BigInt(decoded.serviceFeeBps),
      lateFeeBps: BigInt(decoded.lateFeeBps),
      lastAccrualAt: BigInt(decoded.lastAccrualAt),
    };
  }
}

export class InterestAccrualScheduler {
  private timer: NodeJS.Timeout | undefined;
  private isRunning = false;

  constructor(
    private readonly service: InterestAccrualService,
    private readonly intervalMs: number = 3_600_000,
    private readonly onError: (error: unknown) => void = (error) => {
      // eslint-disable-next-line no-console
      console.error('[interest-accrual] loop error', error);
    }
  ) {}

  start(): boolean {
    if (this.timer) return false;

    this.timer = setInterval(() => {
      if (this.isRunning) return;
      this.isRunning = true;
      this.service
        .run()
        .catch(this.onError)
        .finally(() => {
          this.isRunning = false;
        });
    }, this.intervalMs);

    return true;
  }

  stop(): boolean {
    if (!this.timer) return false;
    clearInterval(this.timer);
    this.timer = undefined;
    return true;
  }

  status(): { enabled: boolean; running: boolean; intervalMs: number } {
    return {
      enabled: Boolean(this.timer),
      running: this.isRunning,
      intervalMs: this.intervalMs,
    };
  }
}
