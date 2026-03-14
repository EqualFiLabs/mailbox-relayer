import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';

describe('buildApp phase2 readiness integration', () => {
  const eventListener = {
    status: vi.fn(() => ({
      lastConfirmedBlock: 100,
      chainHead: 110,
      blocksBehind: 10,
      isPolling: true,
    })),
  };

  const txSubmitter = {
    status: vi.fn(async () => ({
      walletAddress: '0x6666666666666666666666666666666666666666',
      walletBalance: '2.5',
      pendingNonce: 9,
      isEnabled: true,
    })),
  };

  const providerEventIngress = {
    register: vi.fn(async () => undefined),
    status: vi.fn(() => ({
      enabled: true,
      lastAcceptedAt: '2026-03-13T19:00:00.000Z',
    })),
  };

  const app = buildApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
    eventListener: eventListener as unknown as any,
    txSubmitter: txSubmitter as unknown as any,
    providerEventIngress: providerEventIngress as unknown as any,
  });

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('includes eventListener/txSubmitter/providerEventIngress status in /health/ready', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.ready).toBe(true);
    expect(body.integrations.eventListener.isPolling).toBe(true);
    expect(body.integrations.txSubmitter.walletAddress).toBe('0x6666666666666666666666666666666666666666');
    expect(body.integrations.providerEventIngress.enabled).toBe(true);

    expect(providerEventIngress.register).toHaveBeenCalledTimes(1);
    expect(txSubmitter.status).toHaveBeenCalledTimes(1);
  });
});
