import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';

const validEnvelope = {
  version: 'equalfi.mailbox.ecies.eth-crypto.v1',
  recipient: 'agent:base:0xabc123',
  cipher: {
    iv: '45ec7da7123f5562935ecd4cf0f3139e',
    ephemPublicKey:
      '045ea7b6221a026bafa1adcf2c727d8ebaf5395b40a932bf85c1e991467113ba8867fbcca8e242864e0ea02342deb475e17f384095208dd7e34b1a9162ac647323',
    mac: '0957308398294e8c9f03482c7c0ba49c9aa7d3252dabe4af8224279d9be220c1',
    ciphertext: '9971dc361b6cd776ffc3fdb0a7d74149',
  },
  createdAt: '2026-03-10T20:00:00.000Z',
  traceId: 'trace-123',
};

describe('onchain event ingestion', () => {
  const adminAuthToken = 'test-admin-token';
  const adminHeaders = { authorization: `Bearer ${adminAuthToken}` };
  const app = buildApp(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { adminAuthToken }
  );

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires admin auth for onchain ingestion', async () => {
    const ingest = await app.inject({
      method: 'POST',
      url: '/events/onchain',
      payload: {
        chainId: 84532,
        blockNumber: 99,
        logIndex: 1,
        eventType: 'activation',
        agreementId: 'agreement-auth-1',
        provider: 'venice',
      },
    });

    expect(ingest.statusCode).toBe(401);
  });

  it('processes mailbox events and persists agreement state', async () => {
    const ingest = await app.inject({
      method: 'POST',
      url: '/events/onchain',
      headers: adminHeaders,
      payload: {
        chainId: 84532,
        blockNumber: 100,
        logIndex: 1,
        eventType: 'mailbox',
        agreementId: 'agreement-mailbox-1',
        traceId: 'trace-mailbox-1',
        envelope: validEnvelope,
      },
    });

    expect(ingest.statusCode).toBe(200);
    const result = ingest.json();
    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.results[0].action).toBe('mailbox_queued');

    const state = await app.inject({
      method: 'GET',
      url: '/agreements/agreement-mailbox-1/state',
    });

    expect(state.statusCode).toBe(200);
    expect(state.json().state).toBe('mailbox_received');
  });

  it('dedupes duplicate block/log events', async () => {
    const payload = {
      chainId: 84532,
      blockNumber: 200,
      logIndex: 3,
      eventType: 'activation',
      agreementId: 'agreement-dup-1',
      provider: 'lambda',
      traceId: 'trace-dup-1',
    };

    const first = await app.inject({ method: 'POST', url: '/events/onchain', headers: adminHeaders, payload });
    const second = await app.inject({ method: 'POST', url: '/events/onchain', headers: adminHeaders, payload });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    
    const firstBody = first.json();
    expect(firstBody.accepted).toBe(1);

    const secondBody = second.json();
    expect(secondBody.deduped).toBe(1);
    expect(secondBody.results[0].action).toBe('dedupe_skip');
  });

  it('routes breach/default events through adapter terminate path', async () => {
    const ingest = await app.inject({
      method: 'POST',
      url: '/events/onchain',
      headers: adminHeaders,
      payload: {
        chainId: 84532,
        blockNumber: 300,
        logIndex: 0,
        eventType: 'breach',
        agreementId: 'agreement-breach-1',
        provider: 'lambda',
        reason: 'health_factor_breach',
      },
    });

    expect(ingest.statusCode).toBe(200);
    const body = ingest.json();
    expect(body.results[0].action).toBe('termination_attempted');

    const state = await app.inject({
      method: 'GET',
      url: '/agreements/agreement-breach-1/state',
    });

    expect(state.statusCode).toBe(200);
    expect(state.json().state).toBe('breach_detected');
  });

  it('accepts bankr activation routing with canonical provider', async () => {
    const ingest = await app.inject({
      method: 'POST',
      url: '/events/onchain',
      headers: adminHeaders,
      payload: {
        chainId: 84532,
        blockNumber: 301,
        logIndex: 0,
        eventType: 'activation',
        agreementId: 'agreement-bankr-activation-1',
        provider: 'bankr',
      },
    });

    expect(ingest.statusCode).toBe(200);
    const body = ingest.json();
    expect(body.results[0].action).toBe('activation_processed');
    expect(body.results[0].provider).toBe('bankr');
    expect(['ok', 'error', 'not_implemented']).toContain(body.results[0].meta.providerResultStatus);
  });
});
