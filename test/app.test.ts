import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';

const validEnvelope = {
  version: 'equalfi.mailbox.ecies.eth-crypto.v1',
  recipient: 'agent:base:0xabc123',
  cipher: {
    iv: '45ec7da7123f5562935ecd4cf0f3139e',
    ephemPublicKey: '045ea7b6221a026bafa1adcf2c727d8ebaf5395b40a932bf85c1e991467113ba8867fbcca8e242864e0ea02342deb475e17f384095208dd7e34b1a9162ac647323',
    mac: '0957308398294e8c9f03482c7c0ba49c9aa7d3252dabe4af8224279d9be220c1',
    ciphertext: '9971dc361b6cd776ffc3fdb0a7d74149',
  },
  createdAt: '2026-03-10T20:00:00.000Z',
  traceId: 'trace-123',
};

describe('mailbox-relayer API', () => {
  const app = buildApp();

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('exposes scaffolded compute provider adapters', async () => {
    const providers = await app.inject({
      method: 'GET',
      url: '/providers',
    });

    expect(providers.statusCode).toBe(200);
    expect(providers.json().providers).toEqual(['lambda', 'runpod', 'venice', 'bankr']);
  });

  it('accepts canonical mailbox envelopes', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/messages',
      payload: validEnvelope,
    });

    expect(create.statusCode).toBe(201);
    const created = create.json();
    expect(created.id).toBeTypeOf('string');
    expect(created.envelope.version).toBe(validEnvelope.version);

    const read = await app.inject({
      method: 'GET',
      url: `/messages/${created.id}`,
    });

    expect(read.statusCode).toBe(200);
    expect(read.json().status).toBe('queued');
  });

  it('rejects malformed envelope payloads', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/messages',
      payload: {
        ...validEnvelope,
        cipher: {
          ...validEnvelope.cipher,
          mac: 'deadbeef',
        },
      },
    });

    expect(bad.statusCode).toBe(400);
  });

  it('acknowledges delivery for an existing message', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/messages',
      payload: validEnvelope,
    });
    const created = create.json();

    const ack = await app.inject({
      method: 'POST',
      url: `/deliveries/${created.id}/ack`,
      payload: { provider: 'venice', meta: { requestId: 'r-1' } },
    });

    expect(ack.statusCode).toBe(200);
    const acked = ack.json();
    expect(acked.status).toBe('delivered');
    expect(acked.ack.provider).toBe('venice');
  });

  it('runs mocked vertical flow end-to-end', async () => {
    const run = await app.inject({
      method: 'POST',
      url: '/demo/vertical-flow',
      payload: { provider: 'venice', agreementId: 'agreement-123', traceId: 'trace-xyz' },
    });

    expect(run.statusCode).toBe(200);
    const result = run.json();
    expect(result.agreementId).toBe('agreement-123');
    expect(result.provider).toBe('venice');
    expect(['ok', 'error', 'not_implemented']).toContain(result.providerResultStatus);
    expect(result.callbackRecorded).toBe(true);

    const callbackMessage = await app.inject({
      method: 'GET',
      url: `/messages/${result.callbackMessageId}`,
    });

    expect(callbackMessage.statusCode).toBe(200);
    expect(callbackMessage.json().status).toBe('delivered');
  });
});
