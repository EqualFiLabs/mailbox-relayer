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

  it('paginates usage rows when provider signals additional pages', async () => {
    const calls: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);

      if (url.includes('page=2')) {
        return makeResponse({
          ok: true,
          status: 200,
          json: {
            data: [{ sku: 'completion_tokens', amount: 7, timestamp: '2026-03-10T20:02:00.000Z', requestId: 'r2' }],
            pagination: { page: 2, totalPages: 2 },
          },
        });
      }

      return makeResponse({
        ok: true,
        status: 200,
        json: {
          data: [{ sku: 'prompt_tokens', amount: 11, timestamp: '2026-03-10T20:01:00.000Z', requestId: 'r1' }],
          pagination: { page: 1, totalPages: 2 },
        },
      });
    };

    const adapter = new VeniceComputeAdapter({ apiKey: 'admin-key', fetchFn: mockFetch });
    const result = await adapter.usage({ agreementId: 'agreement-1' });

    expect(result.status).toBe('ok');
    expect(calls.length).toBe(2);
    expect(result.usage).toHaveLength(2);
    expect(result.usage[0]).toMatchObject({ unitType: 'VENICE_TEXT_TOKEN_IN', amount: '11' });
    expect(result.usage[1]).toMatchObject({ unitType: 'VENICE_TEXT_TOKEN_OUT', amount: '7' });
  });

  it('quarantines unmappable/invalid rows instead of silently dropping', async () => {
    const mockFetch: typeof fetch = async () =>
      makeResponse({
        ok: true,
        status: 200,
        json: {
          data: [
            { sku: 'custom_unknown_metric', amount: 10, timestamp: '2026-03-10T20:00:00.000Z' },
            { sku: 'prompt_tokens', amount: 'nan', timestamp: '2026-03-10T20:01:00.000Z' },
          ],
        },
      });

    const adapter = new VeniceComputeAdapter({ apiKey: 'admin-key', fetchFn: mockFetch });
    const result = await adapter.usage({ agreementId: 'agreement-1' });

    expect(result.status).toBe('error');
    expect(result.usage).toHaveLength(0);
    expect(result.message).toMatch(/quarantined/i);
    expect(result.meta?.quarantinedCount).toBe(2);
  });

  it('terminates key when delete endpoint succeeds', async () => {
    const calls: Array<{ url: string; method: string }> = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });

      if (method === 'PATCH') {
        return makeResponse({ ok: true, status: 200, json: { ok: true } });
      }

      if (method === 'DELETE' && url.includes('/api_keys?id=key_123')) {
        return makeResponse({ ok: true, status: 200, json: { ok: true } });
      }

      return makeResponse({ ok: false, status: 400, json: { error: 'bad request' } });
    };

    const adapter = new VeniceComputeAdapter({ apiKey: 'admin-key', fetchFn: mockFetch });
    const result = await adapter.terminate({ agreementId: 'agreement-1', providerResourceId: 'key_123' });

    expect(result.status).toBe('ok');
    expect(result.terminated).toBe(true);
    expect(calls.find((c) => c.method === 'PATCH')).toBeTruthy();
    expect(calls.find((c) => c.method === 'DELETE' && c.url.includes('/api_keys?id=key_123'))).toBeTruthy();
  });

  it('treats not-found delete as already-terminated', async () => {
    const mockFetch: typeof fetch = async (_input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();

      if (method === 'PATCH') {
        return makeResponse({ ok: true, status: 200, json: { ok: true } });
      }

      if (method === 'DELETE') {
        return makeResponse({ ok: false, status: 400, json: { error: 'API key could not be found' } });
      }

      return makeResponse({ ok: false, status: 400, json: { error: 'bad request' } });
    };

    const adapter = new VeniceComputeAdapter({ apiKey: 'admin-key', fetchFn: mockFetch });
    const result = await adapter.terminate({ agreementId: 'agreement-1', providerResourceId: 'key_404' });

    expect(result.status).toBe('ok');
    expect(result.terminated).toBe(true);
  });
});
