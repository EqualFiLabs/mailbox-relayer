import { randomUUID } from 'node:crypto';
import { AdapterResultStatus } from './providers';
import {
  MessageStore,
  UsageSettlementAttemptRecord,
  UsageSubmissionRecord,
} from './store';

export interface UsageSettlementSenderResult {
  status: AdapterResultStatus;
  txHash?: string;
  message?: string;
}

export interface UsageSettlementSender {
  send(submission: UsageSubmissionRecord): Promise<UsageSettlementSenderResult>;
}

export class DisabledUsageSettlementSender implements UsageSettlementSender {
  async send(): Promise<UsageSettlementSenderResult> {
    return {
      status: 'error',
      message: 'Usage settlement sender not configured.',
    };
  }
}

export class WebhookUsageSettlementSender implements UsageSettlementSender {
  constructor(
    private readonly webhookUrl: string,
    private readonly token?: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  async send(submission: UsageSubmissionRecord): Promise<UsageSettlementSenderResult> {
    try {
      const response = await this.fetchFn(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({
          kind: 'register_usage',
          submission,
        }),
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }

      if (!response.ok) {
        const message =
          (body && typeof body === 'object' && body && 'error' in body && typeof (body as Record<string, unknown>).error === 'string'
            ? ((body as Record<string, unknown>).error as string)
            : undefined) ?? `HTTP ${response.status}`;

        return {
          status: 'error',
          message,
        };
      }

      const txHash =
        body && typeof body === 'object' && body && 'txHash' in body && typeof (body as Record<string, unknown>).txHash === 'string'
          ? ((body as Record<string, unknown>).txHash as string)
          : undefined;

      return {
        status: 'ok',
        ...(txHash ? { txHash } : {}),
      };
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown settlement error',
      };
    }
  }
}

interface UsageSettlementServiceOptions {
  now?: () => string;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxAttempts?: number;
}

export interface UsageSettlementRunResult {
  processed: number;
  settled: number;
  failed: number;
  results: UsageSettlementAttemptRecord[];
}

export class UsageSettlementService {
  private readonly now: () => string;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly store: MessageStore,
    private readonly sender: UsageSettlementSender,
    options: UsageSettlementServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.baseBackoffMs = options.baseBackoffMs ?? 30_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 15 * 60_000;
    this.maxAttempts = options.maxAttempts ?? 8;
  }

  async run(limitUnattempted = 20, limitRetries = 20): Promise<UsageSettlementRunResult> {
    const out: UsageSettlementAttemptRecord[] = [];

    const unattempted = this.store.listUnattemptedUsageSubmissions(limitUnattempted);
    for (const submission of unattempted) {
      out.push(await this.runAttempt(submission));
    }

    const dueRetries = this.store.listDueUsageSettlementRetries(this.now(), limitRetries);
    for (const retry of dueRetries) {
      const submission = this.store.getUsageSubmission(retry.submissionId);
      if (!submission) continue;
      out.push(await this.runAttempt(submission));
    }

    return {
      processed: out.length,
      settled: out.filter((a) => a.settled).length,
      failed: out.filter((a) => !a.settled).length,
      results: out,
    };
  }

  async runForSubmission(submissionId: string): Promise<UsageSettlementAttemptRecord | undefined> {
    const submission = this.store.getUsageSubmission(submissionId);
    if (!submission) return undefined;

    return this.runAttempt(submission);
  }

  private async runAttempt(submission: UsageSubmissionRecord): Promise<UsageSettlementAttemptRecord> {
    const latest = this.store.getLatestUsageSettlementAttempt(submission.id);
    const attemptNumber = (latest?.attempt ?? 0) + 1;

    const send = await this.sender.send(submission);
    const settled = send.status === 'ok';

    const shouldRetry = !settled && attemptNumber < this.maxAttempts;
    const nextRetryAt = shouldRetry
      ? new Date(Date.parse(this.now()) + this.computeBackoffMs(attemptNumber)).toISOString()
      : undefined;

    const attempt: UsageSettlementAttemptRecord = {
      id: randomUUID(),
      submissionId: submission.id,
      agreementId: submission.agreementId,
      provider: submission.provider,
      attempt: attemptNumber,
      status: send.status,
      settled,
      ...(send.txHash ? { txHash: send.txHash } : {}),
      ...(send.message ? { message: send.message } : {}),
      ...(nextRetryAt ? { nextRetryAt } : {}),
      at: this.now(),
    };

    this.store.addUsageSettlementAttempt(attempt);

    return attempt;
  }

  private computeBackoffMs(attemptNumber: number): number {
    const raw = this.baseBackoffMs * 2 ** Math.max(0, attemptNumber - 1);
    return Math.min(raw, this.maxBackoffMs);
  }
}

export class UsageSettlementScheduler {
  private timer: NodeJS.Timeout | undefined;
  private isRunning = false;

  constructor(
    private readonly service: UsageSettlementService,
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void = (error) => {
      // eslint-disable-next-line no-console
      console.error('[usage-settlement] loop error', error);
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

  status(): { enabled: boolean; intervalMs: number } {
    return {
      enabled: Boolean(this.timer),
      intervalMs: this.intervalMs,
    };
  }
}
