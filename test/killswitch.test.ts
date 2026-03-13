import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { InMemoryMessageStore } from '../src/store';
import { ComputeAdapterRegistry } from '../src/providers';
import {
  ComputeProviderAdapter,
  ProvisionRequest,
  ProvisionResult,
  TerminateRequest,
  TerminateResult,
  UsageRequest,
  UsageResult,
} from '../src/providers/types';
import { KillSwitchEnforcementService } from '../src/killswitch';

class FlakyVeniceAdapter implements ComputeProviderAdapter {
  readonly provider = 'venice' as const;

  terminateCalls = 0;

  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    return {
      status: 'ok',
      provider: this.provider,
      providerResourceId: `key-${request.agreementId}`,
    };
  }

  async usage(_request: UsageRequest): Promise<UsageResult> {
    return {
      status: 'ok',
      provider: this.provider,
      usage: [],
    };
  }

  async terminate(_request: TerminateRequest): Promise<TerminateResult> {
    this.terminateCalls += 1;

    if (this.terminateCalls === 1) {
      return {
        status: 'error',
        provider: this.provider,
        terminated: false,
        message: 'temporary provider timeout',
      };
    }

    return {
      status: 'ok',
      provider: this.provider,
      terminated: true,
      message: 'revoked',
    };
  }
}

describe('kill-switch enforcement + retries', () => {
  let nowMs = Date.parse('2026-03-10T22:00:00.000Z');
  const now = () => new Date(nowMs).toISOString();

  const store = new InMemoryMessageStore();
  const registry = new ComputeAdapterRegistry();
  const adapter = new FlakyVeniceAdapter();
  registry.register(adapter);

  const killSwitchService = new KillSwitchEnforcementService(store, registry, {
    now,
    baseBackoffMs: 1000,
    maxBackoffMs: 4000,
    maxAttempts: 4,
  });

  const app = buildApp(store, registry, undefined, undefined, killSwitchService);

  beforeAll(async () => {
    await app.ready();

    store.setProviderLink({
      agreementId: 'agreement-kill-1',
      provider: 'venice',
      providerResourceId: 'key_123',
      updatedAt: now(),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('freezes draw and records retry metadata on failed termination', async () => {
    const ingest = await app.inject({
      method: 'POST',
      url: '/events/onchain',
      payload: {
        chainId: 84532,
        blockNumber: 500,
        logIndex: 1,
        eventType: 'breach',
        agreementId: 'agreement-kill-1',
        provider: 'venice',
      },
    });

    expect(ingest.statusCode).toBe(200);
    const body = ingest.json();
    expect(body.results[0].meta.drawFrozen).toBe(true);
    expect(body.results[0].meta.terminationAttempt.status).toBe('error');
    expect(body.results[0].meta.terminationAttempt.nextRetryAt).toBeTypeOf('string');

    const draw = await app.inject({
      method: 'GET',
      url: '/agreements/agreement-kill-1/draw-eligibility',
    });

    expect(draw.statusCode).toBe(200);
    expect(draw.json().drawAllowed).toBe(false);

    const attempts = await app.inject({
      method: 'GET',
      url: '/killswitch/attempts?agreementId=agreement-kill-1',
    });

    expect(attempts.statusCode).toBe(200);
    expect(attempts.json().attempts[0].attempt).toBe(1);
    expect(attempts.json().attempts[0].nextRetryAt).toBeTypeOf('string');
  });

  it('retries due terminations with backoff runner', async () => {
    nowMs += 5_000;

    const retryRun = await app.inject({
      method: 'POST',
      url: '/killswitch/retries/run',
      payload: { limit: 10 },
    });

    expect(retryRun.statusCode).toBe(200);
    const body = retryRun.json();
    expect(body.processed).toBe(1);
    expect(body.succeeded).toBe(1);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.terminated).toBe(true);

    const attempts = store.listTerminationAttempts('agreement-kill-1', 10);
    expect(attempts.length).toBeGreaterThan(0);
    const latest = attempts[0];
    expect(latest?.attempt).toBe(2);
    expect(latest?.status).toBe('ok');
    expect(latest?.terminated).toBe(true);
  });
});
