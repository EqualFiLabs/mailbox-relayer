import { Interface, JsonRpcProvider, Signer } from 'ethers';
import { agreementIdToUint256 } from './conversion';
import { MessageStore } from './store';

const COVENANT_IFACE = new Interface([
  'function checkCovenant(uint256 agreementId,uint256 periodId) view returns (bool breached,uint256 requiredPayment,uint256 actualPayment,uint256 netDraw)',
  'function detectBreach(uint256 agreementId)',
  'function terminateForBreach(uint256 agreementId)',
]);

export interface CovenantMonitorRunItem {
  agreementId: string;
  status: 'skipped' | 'detected' | 'terminated' | 'failed';
  breached: boolean;
  reason?: string;
  detectTxHash?: string;
  terminateTxHash?: string;
}

export interface CovenantMonitorRunResult {
  processed: number;
  breached: number;
  detected: number;
  terminated: number;
  skipped: number;
  failed: number;
  results: CovenantMonitorRunItem[];
}

interface LoggerLike {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}

export interface CovenantMonitorServiceOptions {
  maxAgreementsPerCycle?: number;
  logger?: LoggerLike;
}

export class CovenantMonitorService {
  private readonly maxAgreementsPerCycle: number;
  private readonly logger: LoggerLike;
  private signerAddress: string | undefined;

  constructor(
    private readonly store: MessageStore,
    private readonly provider: JsonRpcProvider,
    private readonly signer: Signer,
    private readonly covenantFacetAddress: string,
    options: CovenantMonitorServiceOptions = {}
  ) {
    this.maxAgreementsPerCycle = options.maxAgreementsPerCycle ?? 200;
    this.logger = options.logger ?? console;
  }

  async run(): Promise<CovenantMonitorRunResult> {
    const activeAgreements = this.store.listAgreementStates('active', this.maxAgreementsPerCycle);
    const results: CovenantMonitorRunItem[] = [];

    for (const state of activeAgreements) {
      const agreementId = state.agreementId;
      let agreementIdUint: bigint;
      try {
        agreementIdUint = agreementIdToUint256(agreementId);
      } catch {
        results.push({ agreementId, status: 'failed', breached: false, reason: 'invalid_agreement_id' });
        continue;
      }

      try {
        const breached = await this.readBreachStatus(agreementIdUint);
        if (!breached) {
          results.push({ agreementId, status: 'skipped', breached: false, reason: 'not_breached' });
          continue;
        }

        const detectTx = await this.sendTx('detectBreach', agreementIdUint);
        if (!detectTx.ok) {
          results.push({
            agreementId,
            status: 'failed',
            breached: true,
            reason: detectTx.reason,
            ...(detectTx.txHash ? { detectTxHash: detectTx.txHash } : {}),
          });
          continue;
        }

        const terminateReady = await this.canTerminate(agreementIdUint);
        if (!terminateReady.ready) {
          results.push({
            agreementId,
            status: 'detected',
            breached: true,
            reason: terminateReady.reason,
            ...(detectTx.txHash ? { detectTxHash: detectTx.txHash } : {}),
          });
          continue;
        }

        const terminateTx = await this.sendTx('terminateForBreach', agreementIdUint);
        if (!terminateTx.ok) {
          results.push({
            agreementId,
            status: 'failed',
            breached: true,
            reason: terminateTx.reason,
            ...(detectTx.txHash ? { detectTxHash: detectTx.txHash } : {}),
            ...(terminateTx.txHash ? { terminateTxHash: terminateTx.txHash } : {}),
          });
          continue;
        }

        results.push({
          agreementId,
          status: 'terminated',
          breached: true,
          ...(detectTx.txHash ? { detectTxHash: detectTx.txHash } : {}),
          ...(terminateTx.txHash ? { terminateTxHash: terminateTx.txHash } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ agreementId, status: 'failed', breached: false, reason: message });
        this.logger.error?.({ agreementId, error: message }, 'covenant-monitor: cycle item failed');
      }
    }

    return {
      processed: results.length,
      breached: results.filter((item) => item.breached).length,
      detected: results.filter((item) => item.status === 'detected' || item.status === 'terminated').length,
      terminated: results.filter((item) => item.status === 'terminated').length,
      skipped: results.filter((item) => item.status === 'skipped').length,
      failed: results.filter((item) => item.status === 'failed').length,
      results,
    };
  }

  private async readBreachStatus(agreementId: bigint): Promise<boolean> {
    const callData = COVENANT_IFACE.encodeFunctionData('checkCovenant', [agreementId, 0n]);
    const raw = await this.provider.call({
      to: this.covenantFacetAddress,
      data: callData,
    });
    const decoded = COVENANT_IFACE.decodeFunctionResult('checkCovenant', raw);
    return Boolean(decoded.breached);
  }

  private async canTerminate(agreementId: bigint): Promise<{ ready: boolean; reason?: string }> {
    const callData = COVENANT_IFACE.encodeFunctionData('terminateForBreach', [agreementId]);
    try {
      const from = await this.getSignerAddress();
      await this.provider.call({
        from,
        to: this.covenantFacetAddress,
        data: callData,
      });
      return { ready: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.info?.({ agreementId: agreementId.toString(), error: message }, 'covenant-monitor: terminate not ready');
      return { ready: false, reason: message };
    }
  }

  private async sendTx(
    fn: 'detectBreach' | 'terminateForBreach',
    agreementId: bigint
  ): Promise<{ ok: boolean; txHash?: string; reason?: string }> {
    try {
      const tx = await this.signer.sendTransaction({
        to: this.covenantFacetAddress,
        data: COVENANT_IFACE.encodeFunctionData(fn, [agreementId]),
      });
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        this.logger.error?.({ agreementId: agreementId.toString(), fn, txHash: tx.hash }, 'covenant-monitor: tx reverted');
        return { ok: false, txHash: tx.hash, reason: 'tx_reverted' };
      }
      return { ok: true, txHash: tx.hash };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error?.({ agreementId: agreementId.toString(), fn, error: message }, 'covenant-monitor: tx failed');
      return { ok: false, reason: message };
    }
  }

  private async getSignerAddress(): Promise<string> {
    if (!this.signerAddress) {
      this.signerAddress = await this.signer.getAddress();
    }
    return this.signerAddress;
  }
}

export class CovenantMonitorScheduler {
  private timer: NodeJS.Timeout | undefined;
  private isRunning = false;

  constructor(
    private readonly service: CovenantMonitorService,
    private readonly intervalMs: number = 900_000,
    private readonly onError: (error: unknown) => void = (error) => {
      // eslint-disable-next-line no-console
      console.error('[covenant-monitor] loop error', error);
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
