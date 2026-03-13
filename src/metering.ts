import { createHash, randomUUID } from 'node:crypto';
import { ComputeAdapterRegistry } from './providers';
import { ComputeProvider } from './providers/types';
import { MessageStore, ProviderResourceLink, UsageSubmissionRecord } from './store';

export interface MeteringAgreementResult {
  agreementId: string;
  provider: ComputeProvider;
  status: 'prepared' | 'no_usage' | 'error' | 'skipped';
  from?: string;
  to: string;
  usageRows: number;
  aggregatedItems: Array<{ unitType: string; amount: string }>;
  finalPass: boolean;
  submissionId?: string;
  message?: string;
}

export interface MeteringRunResult {
  startedAt: string;
  finishedAt: string;
  agreementsScanned: number;
  preparedCount: number;
  results: MeteringAgreementResult[];
}

interface MeterAgreementOptions {
  to?: string;
  finalPass?: boolean;
}

export class DeterministicMeteringWorker {
  constructor(
    private readonly store: MessageStore,
    private readonly providers: ComputeAdapterRegistry,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async runOnce(options: MeterAgreementOptions = {}): Promise<MeteringRunResult> {
    const startedAt = this.now();
    const links = this.store.listProviderLinks();

    const results: MeteringAgreementResult[] = [];
    for (const link of links) {
      results.push(await this.runForLink(link, options));
    }

    return {
      startedAt,
      finishedAt: this.now(),
      agreementsScanned: links.length,
      preparedCount: results.filter((r) => r.status === 'prepared').length,
      results,
    };
  }

  async runForAgreement(agreementId: string, options: MeterAgreementOptions = {}): Promise<MeteringAgreementResult> {
    const link = this.store.getProviderLink(agreementId);

    if (!link) {
      return {
        agreementId,
        provider: 'venice',
        status: 'skipped',
        to: options.to ?? this.now(),
        usageRows: 0,
        aggregatedItems: [],
        finalPass: Boolean(options.finalPass),
        message: 'no provider link found for agreement',
      };
    }

    return this.runForLink(link, options);
  }

  private async runForLink(link: ProviderResourceLink, options: MeterAgreementOptions): Promise<MeteringAgreementResult> {
    const checkpoint = this.store.getUsageCheckpoint(link.agreementId);
    const to = options.to ?? this.now();
    const from = checkpoint?.lastUsageTimestamp;
    const finalPass = Boolean(options.finalPass);

    const adapter = this.providers.get(link.provider);
    if (!adapter) {
      return {
        agreementId: link.agreementId,
        provider: link.provider,
        status: 'error',
        ...(from ? { from } : {}),
        to,
        usageRows: 0,
        aggregatedItems: [],
        finalPass,
        message: 'provider_not_supported',
      };
    }

    const usageResult = await adapter.usage({
      agreementId: link.agreementId,
      providerResourceId: link.providerResourceId,
      ...(from ? { from } : {}),
      to,
    });

    if (usageResult.status !== 'ok') {
      return {
        agreementId: link.agreementId,
        provider: link.provider,
        status: 'error',
        ...(from ? { from } : {}),
        to,
        usageRows: 0,
        aggregatedItems: [],
        finalPass,
        message: usageResult.message ?? 'usage_poll_failed',
      };
    }

    const rows = usageResult.usage
      .filter((row) => {
        const observed = Date.parse(row.observedAt);
        if (Number.isNaN(observed)) return false;
        if (from && observed <= Date.parse(from)) return false;
        return observed <= Date.parse(to);
      })
      .sort((a, b) => {
        const t = Date.parse(a.observedAt) - Date.parse(b.observedAt);
        if (t !== 0) return t;

        const requestCompare = (a.requestId ?? '').localeCompare(b.requestId ?? '');
        if (requestCompare !== 0) return requestCompare;

        const unitCompare = a.unitType.localeCompare(b.unitType);
        if (unitCompare !== 0) return unitCompare;

        return a.amount.localeCompare(b.amount);
      });

    const usageDigest = createHash('sha256')
      .update(
        JSON.stringify(
          rows.map((row) => ({
            unitType: row.unitType,
            amount: row.amount,
            observedAt: row.observedAt,
            ...(row.requestId ? { requestId: row.requestId } : {}),
          }))
        )
      )
      .digest('hex');

    const aggregatedItems = aggregateUsageRows(rows);

    let submissionId: string | undefined;

    if (aggregatedItems.length > 0) {
      const submission: UsageSubmissionRecord = {
        id: randomUUID(),
        agreementId: link.agreementId,
        provider: link.provider,
        ...(from ? { from } : {}),
        to,
        usageDigest,
        items: aggregatedItems,
        finalPass,
        createdAt: this.now(),
      };

      this.store.addUsageSubmission(submission);
      submissionId = submission.id;
    }

    this.store.setUsageCheckpoint({
      agreementId: link.agreementId,
      provider: link.provider,
      lastUsageTimestamp: to,
      lastUsageDigest: usageDigest,
      updatedAt: this.now(),
    });

    return {
      agreementId: link.agreementId,
      provider: link.provider,
      status: aggregatedItems.length > 0 ? 'prepared' : 'no_usage',
      ...(from ? { from } : {}),
      to,
      usageRows: rows.length,
      aggregatedItems,
      finalPass,
      ...(submissionId ? { submissionId } : {}),
    };
  }
}

export class MeteringScheduler {
  private timer: NodeJS.Timeout | undefined;
  private isRunning = false;

  constructor(
    private readonly worker: DeterministicMeteringWorker,
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void = (error) => {
      // eslint-disable-next-line no-console
      console.error('[metering] loop error', error);
    }
  ) {}

  start(): boolean {
    if (this.timer) return false;

    this.timer = setInterval(() => {
      if (this.isRunning) return;
      this.isRunning = true;
      this.worker
        .runOnce()
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

function aggregateUsageRows(
  rows: Array<{ unitType: string; amount: string }>
): Array<{ unitType: string; amount: string }> {
  const map = new Map<string, string>();

  for (const row of rows) {
    const prev = map.get(row.unitType) ?? '0';
    map.set(row.unitType, addDecimalStrings(prev, row.amount));
  }

  return [...map.entries()]
    .map(([unitType, amount]) => ({ unitType, amount }))
    .sort((a, b) => a.unitType.localeCompare(b.unitType));
}

function addDecimalStrings(a: string, b: string): string {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  const scale = Math.max(pa.scale, pb.scale);

  const ai = pa.value * 10n ** BigInt(scale - pa.scale);
  const bi = pb.value * 10n ** BigInt(scale - pb.scale);
  const sum = ai + bi;

  if (scale === 0) return sum.toString();

  const sign = sum < 0n ? '-' : '';
  const abs = sum < 0n ? -sum : sum;
  const padded = abs.toString().padStart(scale + 1, '0');
  const intPart = padded.slice(0, -scale) || '0';
  const fracPart = padded.slice(-scale).replace(/0+$/, '');

  return fracPart.length > 0 ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}

function parseDecimal(input: string): { value: bigint; scale: number } {
  const trimmed = input.trim();
  if (!/^[-+]?\d+(\.\d+)?$/.test(trimmed)) {
    return { value: 0n, scale: 0 };
  }

  const sign = trimmed.startsWith('-') ? -1n : 1n;
  const normalized = trimmed.replace(/^[-+]/, '');
  const [i, f = ''] = normalized.split('.');
  const digits = `${i}${f}`;

  return {
    value: sign * BigInt(digits),
    scale: f.length,
  };
}
