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

class FakeVeniceAdapter implements ComputeProviderAdapter {
  readonly provider = 'venice' as const;

  usageCalls: UsageRequest[] = [];

  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    return {
      status: 'ok',
      provider: this.provider,
      providerResourceId: `key-${request.agreementId}`,
    };
  }

  async usage(request: UsageRequest): Promise<UsageResult> {
    this.usageCalls.push(request);
    const call = this.usageCalls.length;

    const usageRows =
      call === 1
        ? [
            {
              unitType: 'VENICE_TEXT_TOKEN_IN',
              amount: '100.5',
              observedAt: '2026-03-10T21:00:01.000Z',
              requestId: 'r-1',
            },
            {
              unitType: 'VENICE_TEXT_TOKEN_IN',
              amount: '20.25',
              observedAt: '2026-03-10T21:00:03.000Z',
              requestId: 'r-2',
            },
            {
              unitType: 'VENICE_TEXT_TOKEN_OUT',
              amount: '10',
              observedAt: '2026-03-10T21:00:05.000Z',
              requestId: 'r-3',
            },
          ]
        : [
            {
              unitType: 'VENICE_TEXT_TOKEN_IN',
              amount: '1',
              observedAt: '2026-03-10T21:01:10.000Z',
              requestId: `r-${call}`,
            },
          ];

    return {
      status: 'ok',
      provider: this.provider,
      usage: usageRows,
    };
  }

  async terminate(_request: TerminateRequest): Promise<TerminateResult> {
    return {
      status: 'ok',
      provider: this.provider,
      terminated: true,
    };
  }
}

describe('deterministic metering loop', () => {
  const adminAuthToken = 'test-admin-token';
  const adminHeaders = { authorization: `Bearer ${adminAuthToken}` };
  const store = new InMemoryMessageStore();
  const registry = new ComputeAdapterRegistry();
  const adapter = new FakeVeniceAdapter();
  registry.register(adapter);

  const app = buildApp(store, registry, undefined, undefined, undefined, undefined, undefined, undefined, {
    adminAuthToken,
  });

  beforeAll(async () => {
    await app.ready();

    store.setProviderLink({
      agreementId: 'agreement-meter-1',
      provider: 'venice',
      providerResourceId: 'key_123',
      updatedAt: '2026-03-10T20:59:00.000Z',
    });

    store.setUsageCheckpoint({
      agreementId: 'agreement-meter-1',
      provider: 'venice',
      lastUsageTimestamp: '2026-03-10T21:00:00.000Z',
      lastUsageDigest: 'old',
      updatedAt: '2026-03-10T21:00:00.000Z',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('aggregates usage by canonical unit type and prepares submissions', async () => {
    const run = await app.inject({
      method: 'POST',
      url: '/metering/run',
      headers: adminHeaders,
      payload: {
        to: '2026-03-10T21:01:00.000Z',
      },
    });

    expect(run.statusCode).toBe(200);
    const body = run.json();
    expect(body.preparedCount).toBe(1);
    expect(body.results[0].status).toBe('prepared');
    expect(body.results[0].aggregatedItems).toEqual([
      { unitType: 'VENICE_TEXT_TOKEN_IN', amount: '120.75' },
      { unitType: 'VENICE_TEXT_TOKEN_OUT', amount: '10' },
    ]);

    const submissions = await app.inject({ method: 'GET', url: '/metering/submissions?limit=5' });
    expect(submissions.statusCode).toBe(200);
    const submissionsBody = submissions.json();
    expect(submissionsBody.submissions).toHaveLength(1);
    expect(submissionsBody.submissions[0].items).toEqual([
      { unitType: 'VENICE_TEXT_TOKEN_IN', amount: '120.75' },
      { unitType: 'VENICE_TEXT_TOKEN_OUT', amount: '10' },
    ]);

    const checkpoint = store.getUsageCheckpoint('agreement-meter-1');
    expect(checkpoint?.lastUsageTimestamp).toBe('2026-03-10T21:01:00.000Z');
  });

  it('runs final metering pass before breach termination path', async () => {
    const ingest = await app.inject({
      method: 'POST',
      url: '/events/onchain',
      headers: adminHeaders,
      payload: {
        chainId: 84532,
        blockNumber: 900,
        logIndex: 1,
        eventType: 'breach',
        agreementId: 'agreement-meter-1',
      },
    });

    expect(ingest.statusCode).toBe(200);
    const body = ingest.json();
    expect(body.results[0].action).toBe('termination_attempted');
    expect(body.results[0].meta.finalMetering.status).toBe('prepared');

    const submissions = store.listUsageSubmissions(5);
    expect(submissions.some((s) => s.finalPass)).toBe(true);
  });
});
