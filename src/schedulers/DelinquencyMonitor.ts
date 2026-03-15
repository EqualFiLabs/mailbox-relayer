import { Interface, JsonRpcProvider, Signer } from 'ethers';

const AGREEMENT_IFACE = new Interface([
  'function getAgreementsByStatus(uint8 status) view returns (uint256[] agreementIds)',
]);

const RISK_IFACE = new Interface([
  'function detectDelinquency(uint256 agreementId)',
  'function triggerDefault(uint256 agreementId)',
]);

const AGREEMENT_STATUS_ACTIVE = 0;
const AGREEMENT_STATUS_DELINQUENT = 2;

type RiskTransitionFn = 'detectDelinquency' | 'triggerDefault';

export class DelinquencyMonitor {
  private timer: NodeJS.Timeout | undefined;
  private isRunning = false;

  constructor(
    private readonly provider: JsonRpcProvider,
    private readonly signer: Signer,
    private readonly riskFacetAddress: string,
    private readonly agreementFacetAddress: string,
    private readonly intervalMs: number = 900_000,
    private readonly onError: (error: unknown) => void = (error) => {
      // eslint-disable-next-line no-console
      console.error('[delinquency-monitor] loop error', error);
    }
  ) {}

  start(): boolean {
    if (this.timer) return false;

    this.timer = setInterval(() => {
      void this.runCycle();
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

  async runCycle(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      await this.runDetectionPhase();
      await this.runDefaultPhase();
    } catch (error) {
      this.reportError(error, 'delinquency-monitor: cycle failed');
    } finally {
      this.isRunning = false;
    }
  }

  private async runDetectionPhase(): Promise<void> {
    const activeAgreementIds = await this.getAgreementIdsByStatus(AGREEMENT_STATUS_ACTIVE);
    for (const agreementId of activeAgreementIds) {
      await this.sendRiskTransition('detectDelinquency', agreementId, ['NotDelinquent', 'InvalidStatusTransition']);
    }
  }

  private async runDefaultPhase(): Promise<void> {
    const delinquentAgreementIds = await this.getAgreementIdsByStatus(AGREEMENT_STATUS_DELINQUENT);
    for (const agreementId of delinquentAgreementIds) {
      await this.sendRiskTransition('triggerDefault', agreementId, ['CurePeriodNotExpired']);
    }
  }

  private async getAgreementIdsByStatus(status: number): Promise<bigint[]> {
    const raw = await this.provider.call({
      to: this.agreementFacetAddress,
      data: AGREEMENT_IFACE.encodeFunctionData('getAgreementsByStatus', [status]),
    });
    const decoded = AGREEMENT_IFACE.decodeFunctionResult('getAgreementsByStatus', raw);
    const ids = decoded[0] as bigint[];
    return ids.map((id) => BigInt(id));
  }

  private async sendRiskTransition(
    fn: RiskTransitionFn,
    agreementId: bigint,
    expectedErrors: string[]
  ): Promise<void> {
    try {
      const tx = await this.signer.sendTransaction({
        to: this.riskFacetAddress,
        data: RISK_IFACE.encodeFunctionData(fn, [agreementId]),
      });

      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error('tx_reverted');
      }
    } catch (error) {
      if (this.isExpectedError(error, expectedErrors)) {
        return;
      }
      this.reportError(error, `delinquency-monitor: ${fn} failed`);
    }
  }

  private isExpectedError(error: unknown, expectedTokens: string[]): boolean {
    const normalized = this.errorText(error).toLowerCase();
    return expectedTokens.some((token) => normalized.includes(token.toLowerCase()));
  }

  private errorText(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error !== 'object' || error === null) return String(error);

    const record = error as Record<string, unknown>;
    const fields = ['shortMessage', 'reason', 'message', 'errorName']
      .map((key) => record[key])
      .filter((value): value is string => typeof value === 'string');

    if (typeof record.error === 'object' && record.error !== null) {
      const nested = record.error as Record<string, unknown>;
      const nestedFields = ['shortMessage', 'reason', 'message', 'errorName']
        .map((key) => nested[key])
        .filter((value): value is string => typeof value === 'string');
      fields.push(...nestedFields);
    }

    if (fields.length > 0) {
      return fields.join(' | ');
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private reportError(error: unknown, message: string): void {
    // eslint-disable-next-line no-console
    console.error(message, error);
    try {
      this.onError(error);
    } catch {
      // Never throw from error reporting.
    }
  }
}
