import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { InMemoryMessageStore } from '../src/store';
import { ComputeAdapterRegistry } from '../src/providers';
import {
  UsageSettlementSender,
  UsageSettlementSenderResult,
  UsageSettlementService,
} from '../src/settlement';

class FlakySettlementSender implements UsageSettlementSender {
  private readonly attemptsBySubmission = new Map<string, number>();

  async send(submission: {
    id: string;
    agreementId: string;
  }): Promise<UsageSettlementSenderResult> {
    const attempts = (this.attemptsBySubmission.get(submission.id) ?? 0) + 1;
    this.attemptsBySubmission.set(submission.id, attempts);

    if (attempts === 1) {
      return {
        status: 'error',
        message: 'temporary rpc timeout',
      };
    }

    return {
      status: 'ok',
      txHash: `0xtx-${submission.agreementId}-${attempts}`,
    };
  }
}

describe('usage settlement pipeline', () => {
  let nowMs = Date.parse('2026-03-10T22:30:00.000Z');
  const now = () => new Date(nowMs).toISOString();

  const store = new InMemoryMessageStore();
  const providerRegistry = new ComputeAdapterRegistry();
  const sender = new FlakySettlementSender();
  const settlementService = new UsageSettlementService(store, sender, {
    now,
    baseBackoffMs: 1000,
    maxBackoffMs: 4000,
    maxAttempts: 4,
  });

  const app = buildApp(store, providerRegistry, undefined, undefined, undefined, undefined, settlementService);

  beforeAll(async () => {
    await app.ready();

    store.addUsageSubmission({
      id: 'submission-1',
      agreementId: 'agreement-1',
      provider: 'venice',
      from: '2026-03-10T22:00:00.000Z',
      to: '2026-03-10T22:10:00.000Z',
      usageDigest: 'digest-1',
      items: [{ unitType: 'VENICE_TEXT_TOKEN_IN', amount: '123' }],
      finalPass: false,
      createdAt: '2026-03-10T22:10:01.000Z',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('records failed settlement attempts with retry schedule', async () => {
    const run = await app.inject({ method: 'POST', url: '/settlement/run' });

    expect(run.statusCode).toBe(200);
    const body = run.json();
    expect(body.processed).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results[0].settled).toBe(false);
    expect(body.results[0].nextRetryAt).toBeTypeOf('string');

    const submissions = await app.inject({ method: 'GET', url: '/metering/submissions?limit=5' });
    expect(submissions.statusCode).toBe(200);
    expect(submissions.json().submissions[0].settlement.status).toBe('error');
  });

  it('retries due settlement and records tx hash on success', async () => {
    nowMs += 5000;

    const run = await app.inject({ method: 'POST', url: '/settlement/run' });

    expect(run.statusCode).toBe(200);
    const body = run.json();
    expect(body.processed).toBe(1);
    expect(body.settled).toBe(1);
    expect(body.results[0].settled).toBe(true);
    expect(body.results[0].txHash).toMatch(/^0xtx-/);

    const attempts = await app.inject({ method: 'GET', url: '/settlement/attempts?submissionId=submission-1' });
    expect(attempts.statusCode).toBe(200);
    expect(attempts.json().attempts[0].attempt).toBe(2);
    expect(attempts.json().attempts[0].settled).toBe(true);
  });
});
