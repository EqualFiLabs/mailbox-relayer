import { randomUUID } from 'node:crypto';
import { ComputeAdapterRegistry } from './providers';
import { ComputeProvider } from './providers/types';
import { AdapterResultStatus } from './providers';
import { KillSwitchRecord, MessageStore, TerminationAttemptRecord } from './store';

interface KillSwitchServiceOptions {
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxAttempts?: number;
  now?: () => string;
}

export interface KillSwitchEnforceRequest {
  agreementId: string;
  eventType: 'breach' | 'default';
  reason?: string;
  provider?: ComputeProvider;
  sourceEventKey?: string;
}

export interface KillSwitchEnforceResult {
  agreementId: string;
  provider?: ComputeProvider;
  drawFrozen: boolean;
  action: 'frozen_no_provider' | 'provider_not_supported' | 'termination_attempted';
  attempt?: TerminationAttemptRecord;
}

export class KillSwitchEnforcementService {
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => string;

  constructor(
    private readonly store: MessageStore,
    private readonly providers: ComputeAdapterRegistry,
    options: KillSwitchServiceOptions = {}
  ) {
    this.baseBackoffMs = options.baseBackoffMs ?? 30_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 15 * 60_000;
    this.maxAttempts = options.maxAttempts ?? 6;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async enforce(request: KillSwitchEnforceRequest): Promise<KillSwitchEnforceResult> {
    const nowIso = this.now();
    const existing = this.store.getKillSwitch(request.agreementId);
    const provider = request.provider ?? this.store.getProviderLink(request.agreementId)?.provider;

    this.store.setKillSwitch({
      agreementId: request.agreementId,
      active: true,
      reason: request.reason ?? request.eventType,
      triggeredBy: request.eventType,
      activatedAt: existing?.activatedAt ?? nowIso,
      updatedAt: nowIso,
      ...(provider ? { provider } : {}),
      ...(request.sourceEventKey ? { sourceEventKey: request.sourceEventKey } : {}),
      ...(existing?.lastTerminationStatus ? { lastTerminationStatus: existing.lastTerminationStatus } : {}),
    });

    if (!provider) {
      return {
        agreementId: request.agreementId,
        drawFrozen: true,
        action: 'frozen_no_provider',
      };
    }

    const adapter = this.providers.get(provider);
    if (!adapter) {
      this.updateKillSwitchTerminationStatus(request.agreementId, provider, 'error');

      return {
        agreementId: request.agreementId,
        provider,
        drawFrozen: true,
        action: 'provider_not_supported',
      };
    }

    const attempt = await this.runAttempt({
      agreementId: request.agreementId,
      provider,
      reason: request.reason ?? request.eventType,
    });

    return {
      agreementId: request.agreementId,
      provider,
      drawFrozen: true,
      action: 'termination_attempted',
      attempt,
    };
  }

  async runDueRetries(limit = 20): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    results: TerminationAttemptRecord[];
  }> {
    const due = this.store.listDueTerminationRetries(this.now(), limit);
    const results: TerminationAttemptRecord[] = [];

    for (const attempt of due) {
      results.push(
        await this.runAttempt({
          agreementId: attempt.agreementId,
          provider: attempt.provider,
          reason: attempt.reason,
        })
      );
    }

    return {
      processed: due.length,
      succeeded: results.filter((r) => r.terminated).length,
      failed: results.filter((r) => !r.terminated).length,
      results,
    };
  }

  isDrawAllowed(agreementId: string): boolean {
    const killSwitch = this.store.getKillSwitch(agreementId);
    return !killSwitch?.active;
  }

  private async runAttempt(input: {
    agreementId: string;
    provider: ComputeProvider;
    reason: string;
  }): Promise<TerminationAttemptRecord> {
    const latest = this.store.getLatestTerminationAttempt(input.agreementId);
    const attemptNumber = (latest?.attempt ?? 0) + 1;

    const adapter = this.providers.get(input.provider);
    const providerResourceId = this.store.getProviderLink(input.agreementId)?.providerResourceId;

    let status: AdapterResultStatus = 'error';
    let terminated = false;
    let message: string | undefined;

    if (!adapter) {
      status = 'error';
      message = 'provider_not_supported';
    } else {
      const result = await adapter.terminate({
        agreementId: input.agreementId,
        ...(providerResourceId ? { providerResourceId } : {}),
        reason: input.reason,
      });

      status = result.status;
      terminated = result.terminated;
      message = result.message;
    }

    const shouldRetry = !terminated && attemptNumber < this.maxAttempts;
    const nextRetryAt = shouldRetry
      ? new Date(Date.parse(this.now()) + this.computeBackoffMs(attemptNumber)).toISOString()
      : undefined;

    const record: TerminationAttemptRecord = {
      id: randomUUID(),
      agreementId: input.agreementId,
      provider: input.provider,
      ...(providerResourceId ? { providerResourceId } : {}),
      attempt: attemptNumber,
      status,
      terminated,
      reason: input.reason,
      ...(message ? { message } : {}),
      ...(nextRetryAt ? { nextRetryAt } : {}),
      at: this.now(),
    };

    this.store.addTerminationAttempt(record);
    this.updateKillSwitchTerminationStatus(input.agreementId, input.provider, status);

    return record;
  }

  private updateKillSwitchTerminationStatus(
    agreementId: string,
    provider: ComputeProvider,
    status: AdapterResultStatus
  ): void {
    const existing = this.store.getKillSwitch(agreementId);
    const nowIso = this.now();

    const record: KillSwitchRecord = {
      agreementId,
      active: true,
      reason: existing?.reason ?? 'kill_switch',
      triggeredBy: existing?.triggeredBy ?? 'manual',
      activatedAt: existing?.activatedAt ?? nowIso,
      updatedAt: nowIso,
      ...(existing?.sourceEventKey ? { sourceEventKey: existing.sourceEventKey } : {}),
      provider,
      lastTerminationStatus: status,
    };

    this.store.setKillSwitch(record);
  }

  private computeBackoffMs(attemptNumber: number): number {
    const raw = this.baseBackoffMs * 2 ** Math.max(0, attemptNumber - 1);
    return Math.min(raw, this.maxBackoffMs);
  }
}

export class KillSwitchRetryScheduler {
  private timer: NodeJS.Timeout | undefined;
  private isRunning = false;

  constructor(
    private readonly service: KillSwitchEnforcementService,
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void = (error) => {
      // eslint-disable-next-line no-console
      console.error('[killswitch-retry] loop error', error);
    }
  ) {}

  start(): boolean {
    if (this.timer) return false;

    this.timer = setInterval(() => {
      if (this.isRunning) return;
      this.isRunning = true;
      this.service
        .runDueRetries()
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
