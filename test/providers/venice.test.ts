import { describe, expect, it } from 'vitest';
import { VeniceComputeAdapter } from '../../src/providers/venice';

type MockResponseInit = {
  ok: boolean;
  status: number;
  json: unknown;
};

function makeResponse(init: MockResponseInit): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: async () => init.json,
  } as unknown as Response;
}

describe('VeniceComputeAdapter', () => {
  it('returns config error when api key is missing', async () => {
    const adapter = new VeniceComputeAdapter({ apiKey: '' });
    const result = await adapter.provision({ agreementId: 'a-1' });

    expect(result.status).toBe('error');
    expect(result.message).toMatch(/not configured/i);
  });

  it('creates scoped key on provision', async () => {
    const mockFetch: typeof fetch = async () =>
      makeResponse({
        ok: true,
        status: 200,
        json: {
          data: {
            id: 'key_123',
            apiKey: 'venice-secret-key',
          },
        },
      });

    const adapter = new VeniceComputeAdapter({
      apiKey: 'admin-key',
      fetchFn: mockFetch,
      baseUrl: 'https://api.venice.ai/api/v1',
    });

    const result = await adapter.provision({ agreementId: 'agreement-1', traceId: 'trace-1' });

    expect(result.status).toBe('ok');
    expect(result.providerResourceId).toBe('key_123');
    expect(result.connection?.apiKey).toBe('venice-secret-key');
  });

  it('maps usage rows into canonical unit records', async () => {
    const mockFetch: typeof fetch = async () =>
      makeResponse({
        ok: true,
        status: 200,
        json: {
          data: [
            { sku: 'prompt_tokens', amount: 123, timestamp: '2026-03-10T20:00:00.000Z', requestId: 'r1' },
            { sku: 'completion_tokens', amount: '45', timestamp: '2026-03-10T20:01:00.000Z', requestId: 'r2' },
          ],
        },
      });

    const adapter = new VeniceComputeAdapter({ apiKey: 'admin-key', fetchFn: mockFetch });
    const result = await adapter.usage({ agreementId: 'agreement-1' });

    expect(result.status).toBe('ok');
    expect(result.usage).toHaveLength(2);
    expect(result.usage[0]).toMatchObject({ unitType: 'VENICE_TEXT_TOKEN_IN', amount: '123' });
    expect(result.usage[1]).toMatchObject({ unitType: 'VENICE_TEXT_TOKEN_OUT', amount: '45' });
  });

  it('terminates key when delete endpoint succeeds', async () => {
    const calls: Array<{ url: string; method: string }> = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });

      if (method === 'PATCH') {
        return makeResponse({ ok: false, status: 404, json: { error: 'not found' } });
      }

      if (method === 'DELETE' && url.endsWith('/api_keys/key_123')) {
        return makeResponse({ ok: true, status: 200, json: { ok: true } });
      }

      return makeResponse({ ok: false, status: 400, json: { error: 'bad request' } });
    };

    const adapter = new VeniceComputeAdapter({ apiKey: 'admin-key', fetchFn: mockFetch });
    const result = await adapter.terminate({ agreementId: 'agreement-1', providerResourceId: 'key_123' });

    expect(result.status).toBe('ok');
    expect(result.terminated).toBe(true);
    expect(calls.find((c) => c.method === 'PATCH')).toBeTruthy();
    expect(calls.find((c) => c.method === 'DELETE')).toBeTruthy();
  });
});
