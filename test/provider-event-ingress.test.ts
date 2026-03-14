import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderEventIngress } from '../src/provider-event-ingress';
import { InMemoryMessageStore } from '../src/store';

const authToken = 'provider-event-auth-token';

function buildPayload() {
  return {
    provider: 'bankr' as const,
    providerResourceId: 'bankr-resource-1',
    externalEventId: 'evt-1',
    payload: {
      usage: {
        inputTokens: 123,
        outputTokens: 456,
      },
    },
    observedAt: '2026-03-13T18:00:00.000Z',
    traceId: 'trace-provider-1',
  };
}

describe('ProviderEventIngress', () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) {
        await app.close();
      }
    }
  });

  it('persists a valid authenticated callback exactly once', async () => {
    const store = new InMemoryMessageStore();
    const ingress = new ProviderEventIngress(store, { authToken, now: () => '2026-03-13T18:05:00.000Z' });

    const app = Fastify({ logger: false });
    apps.push(app);
    await ingress.register(app);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/events/provider',
      headers: {
        authorization: `Bearer ${authToken}`,
      },
      payload: buildPayload(),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ ok: true, deduped: false });

    const rows = store.listProviderEvents('bankr', 'bankr-resource-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalEventId).toBe('evt-1');
    expect(rows[0]?.observedAt).toBe('2026-03-13T18:00:00.000Z');

    const status = ingress.status();
    expect(status.enabled).toBe(true);
    expect(status.lastAcceptedAt).toBe('2026-03-13T18:05:00.000Z');
  });

  it('acknowledges duplicate callback idempotently without second row', async () => {
    const store = new InMemoryMessageStore();
    const ingress = new ProviderEventIngress(store, { authToken, now: () => '2026-03-13T18:05:00.000Z' });

    const app = Fastify({ logger: false });
    apps.push(app);
    await ingress.register(app);
    await app.ready();

    const payload = buildPayload();

    const first = await app.inject({
      method: 'POST',
      url: '/events/provider',
      headers: {
        authorization: `Bearer ${authToken}`,
      },
      payload,
    });

    const second = await app.inject({
      method: 'POST',
      url: '/events/provider',
      headers: {
        authorization: `Bearer ${authToken}`,
      },
      payload,
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({ ok: true, deduped: true });

    const rows = store.listProviderEvents('bankr', 'bankr-resource-1');
    expect(rows).toHaveLength(1);
  });

  it('rejects invalid auth and does not persist callback', async () => {
    const store = new InMemoryMessageStore();
    const ingress = new ProviderEventIngress(store, { authToken, now: () => '2026-03-13T18:05:00.000Z' });

    const app = Fastify({ logger: false });
    apps.push(app);
    await ingress.register(app);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/events/provider',
      headers: {
        authorization: 'Bearer wrong-token',
      },
      payload: buildPayload(),
    });

    expect(response.statusCode).toBe(401);
    expect(store.listProviderEvents('bankr', 'bankr-resource-1')).toHaveLength(0);
  });

  it('returns validation error on malformed payload', async () => {
    const store = new InMemoryMessageStore();
    const ingress = new ProviderEventIngress(store, { authToken, now: () => '2026-03-13T18:05:00.000Z' });

    const app = Fastify({ logger: false });
    apps.push(app);
    await ingress.register(app);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/events/provider',
      headers: {
        authorization: `Bearer ${authToken}`,
      },
      payload: {
        provider: 'bankr',
        providerResourceId: 'bankr-resource-1',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_provider_event_payload');
    expect(store.listProviderEvents('bankr', 'bankr-resource-1')).toHaveLength(0);
  });
});
