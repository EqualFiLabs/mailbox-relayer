import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { AlertPayload, AlertSender, AlertingService } from '../src/alerting';
import { KillSwitchEnforcementService } from '../src/killswitch';
import { ComputeAdapterRegistry } from '../src/providers';
import { BankrComputeAdapter } from '../src/providers/bankr';
import { InMemoryMessageStore } from '../src/store';

class CaptureAlertSender implements AlertSender {
  readonly sent: AlertPayload[] = [];

  async send(payload: AlertPayload): Promise<void> {
    this.sent.push(payload);
  }
}

describe('bankr soft-kill behavior', () => {
  const adminAuthToken = 'test-admin-token';
  const adminHeaders = { authorization: `Bearer ${adminAuthToken}` };
  const store = new InMemoryMessageStore();
  const registry = new ComputeAdapterRegistry();
  registry.register(
    new BankrComputeAdapter({
      keyPool: [{ id: 'pool-1', apiKey: 'bankr-key-1' }],
    })
  );

  const captureSender = new CaptureAlertSender();
  const alerting = new AlertingService(captureSender);
  const killSwitchService = new KillSwitchEnforcementService(store, registry, {}, alerting);
  const app = buildApp(store, registry, undefined, undefined, killSwitchService, undefined, undefined, undefined, {
    adminAuthToken,
  });

  beforeAll(async () => {
    await app.ready();
    store.setProviderLink({
      agreementId: 'agreement-bankr-kill-1',
      provider: 'bankr',
      providerResourceId: 'pool-1',
      updatedAt: '2026-03-10T21:59:00.000Z',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('disables bankr provider link and blocks future metering after soft kill', async () => {
    const ingest = await app.inject({
      method: 'POST',
      url: '/events/onchain',
      headers: adminHeaders,
      payload: {
        chainId: 84532,
        blockNumber: 1300,
        logIndex: 1,
        eventType: 'breach',
        agreementId: 'agreement-bankr-kill-1',
        provider: 'bankr',
      },
    });

    expect(ingest.statusCode).toBe(200);
    const body = ingest.json();
    expect(body.results[0].action).toBe('termination_attempted');
    expect(body.results[0].meta.terminationAttempt.terminated).toBe(true);
    expect(store.getProviderLink('agreement-bankr-kill-1')).toBeUndefined();

    const metering = await app.inject({
      method: 'POST',
      url: '/metering/run',
      headers: adminHeaders,
      payload: { agreementId: 'agreement-bankr-kill-1' },
    });

    expect(metering.statusCode).toBe(200);
    const meteringBody = metering.json();
    expect(meteringBody.results[0].status).toBe('skipped');
    expect(meteringBody.results[0].message).toMatch(/no provider link found/i);

    expect(captureSender.sent.some((a) => a.kind === 'termination_followup_required')).toBe(true);
  });
});
