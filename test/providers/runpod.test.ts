import { describe, expect, it } from 'vitest';
import { RunPodComputeAdapter } from '../../src/providers/runpod';

type MockResponseInit = {
  ok: boolean;
  status: number;
  json: unknown;
  headers?: Record<string, string>;
};

function makeResponse(init: MockResponseInit): Response {
  return {
    ok: init.ok,
    status: init.status,
    headers: new Headers(init.headers ?? {}),
    json: async () => init.json,
  } as unknown as Response;
}

describe('RunPodComputeAdapter serverless provisioning', () => {
  it('creates serverless endpoint successfully and returns endpoint connection', async () => {
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/endpoints') && method === 'POST') {
        return makeResponse({
          ok: true,
          status: 200,
          headers: { 'x-request-id': 'req-runpod-create-1' },
          json: { data: { id: 'ep_123' } },
        });
      }

      return makeResponse({ ok: false, status: 404, json: { error: 'unexpected request' } });
    };

    const adapter = new RunPodComputeAdapter({
      apiKey: 'runpod-key',
      fetchFn: mockFetch,
      serverlessBaseUrl: 'https://api.runpod.ai/v2',
      infraBaseUrl: 'https://rest.runpod.io/v1',
    });

    const result = await adapter.provision({
      agreementId: 'agreement-rp-1',
      policy: { computeMode: 'burst' },
    });

    expect(result.status).toBe('ok');
    expect(result.providerResourceId).toBe('ep_123');
    expect(result.connection).toMatchObject({
      endpoint_url: 'https://api.runpod.ai/v2/ep_123',
      api_key: 'runpod-key',
    });
    expect(result.meta).toMatchObject({ requestId: 'req-runpod-create-1' });
  });

  it('returns config error when RUNPOD_API_KEY is missing', async () => {
    const adapter = new RunPodComputeAdapter({ apiKey: '' });
    const result = await adapter.provision({ agreementId: 'agreement-rp-2' });

    expect(result.status).toBe('error');
    expect(result.message).toBe('RUNPOD_API_KEY not configured');
  });

  it('returns API error detail when endpoint creation fails', async () => {
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/endpoints') && method === 'POST') {
        return makeResponse({
          ok: false,
          status: 400,
          headers: { 'x-request-id': 'req-runpod-err-1' },
          json: { error: 'invalid templateId' },
        });
      }

      return makeResponse({ ok: false, status: 404, json: { error: 'unexpected request' } });
    };

    const adapter = new RunPodComputeAdapter({ apiKey: 'runpod-key', fetchFn: mockFetch });
    const result = await adapter.provision({
      agreementId: 'agreement-rp-3',
      policy: { computeMode: 'burst' },
    });

    expect(result.status).toBe('error');
    expect(result.message).toMatch(/invalid templateId/i);
    expect(result.meta).toMatchObject({ requestId: 'req-runpod-err-1', statusCode: 400 });
  });

  it('includes agreementId in endpoint name', async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/endpoints') && method === 'POST') {
        if (init?.body) {
          requestBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        }
        return makeResponse({
          ok: true,
          status: 200,
          json: { data: { endpoint_id: 'ep_name_1' } },
        });
      }

      return makeResponse({ ok: false, status: 404, json: { error: 'unexpected request' } });
    };

    const agreementId = 'agreement-rp-name-1';
    const adapter = new RunPodComputeAdapter({ apiKey: 'runpod-key', fetchFn: mockFetch });
    const result = await adapter.provision({
      agreementId,
      policy: { computeMode: 'burst' },
    });

    expect(result.status).toBe('ok');
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0].name).toBe(`equalfi-${agreementId}`);
  });

  it('applies serverless policy defaults when omitted', async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/endpoints') && method === 'POST') {
        if (init?.body) {
          requestBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        }
        return makeResponse({
          ok: true,
          status: 200,
          json: { data: { id: 'ep_defaults_1' } },
        });
      }

      return makeResponse({ ok: false, status: 404, json: { error: 'unexpected request' } });
    };

    const adapter = new RunPodComputeAdapter({ apiKey: 'runpod-key', fetchFn: mockFetch });
    const result = await adapter.provision({
      agreementId: 'agreement-rp-defaults-1',
      policy: {},
    });

    expect(result.status).toBe('ok');
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toMatchObject({
      minWorkers: 0,
      maxWorkers: 1,
      idleTimeout: 60,
      executionTimeoutMs: 600000,
      jobTtlMs: 86400000,
    });
  });

  it('wires webhook URL when provided', async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/endpoints') && method === 'POST') {
        if (init?.body) {
          requestBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        }
        return makeResponse({
          ok: true,
          status: 200,
          json: { data: { id: 'ep_webhook_1' } },
        });
      }

      return makeResponse({ ok: false, status: 404, json: { error: 'unexpected request' } });
    };

    const adapter = new RunPodComputeAdapter({ apiKey: 'runpod-key', fetchFn: mockFetch });
    const result = await adapter.provision({
      agreementId: 'agreement-rp-webhook-1',
      policy: {
        webhookUrl: 'https://example.com/hooks/runpod',
      },
    });

    expect(result.status).toBe('ok');
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0].webhookUrl).toBe('https://example.com/hooks/runpod');
  });
});
