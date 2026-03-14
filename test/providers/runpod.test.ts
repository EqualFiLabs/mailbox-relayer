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

describe('RunPodComputeAdapter dedicated pod provisioning', () => {
  it('creates a pod and polls until running, then returns pod connection', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    let podStatusReads = 0;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });

      if (url.endsWith('/pods') && method === 'POST') {
        return makeResponse({
          ok: true,
          status: 200,
          headers: { 'x-request-id': 'req-pod-create-1' },
          json: { data: { id: 'pod_123' } },
        });
      }

      if (url.endsWith('/pods/pod_123') && method === 'GET') {
        podStatusReads += 1;
        if (podStatusReads === 1) {
          return makeResponse({
            ok: true,
            status: 200,
            json: { data: { id: 'pod_123', desiredStatus: 'PENDING' } },
          });
        }

        return makeResponse({
          ok: true,
          status: 200,
          headers: { 'x-request-id': 'req-pod-get-2' },
          json: {
            data: {
              id: 'pod_123',
              desiredStatus: 'RUNNING',
              podUrl: 'https://pod.runpod.example/pod_123',
              publicIp: '100.65.0.119',
              portMappings: { '22': 10341 },
            },
          },
        });
      }

      return makeResponse({ ok: false, status: 404, json: { error: 'unexpected request' } });
    };

    const sleepCalls: number[] = [];
    const adapter = new RunPodComputeAdapter({
      apiKey: 'runpod-key',
      fetchFn: mockFetch,
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
      },
      podPollIntervalMs: 1,
      podPollMaxAttempts: 5,
    });

    const result = await adapter.provision({
      agreementId: 'agreement-rp-pod-1',
      policy: {
        computeMode: 'dedicated',
        gpuTypeIds: ['NVIDIA GeForce RTX 4090'],
        gpuCount: 1,
        volumeInGb: 40,
        imageName: 'runpod/pytorch:latest',
      },
    });

    expect(result.status).toBe('ok');
    expect(result.providerResourceId).toBe('pod_123');
    expect(result.connection).toMatchObject({
      pod_url: 'https://pod.runpod.example/pod_123',
      ssh_host: '100.65.0.119',
      ssh_port: 10341,
    });
    expect(result.connectionPending).toBeUndefined();
    expect(sleepCalls).toEqual([1]);

    const createPodCall = calls.find((call) => call.url.endsWith('/pods') && call.method === 'POST');
    expect(createPodCall?.body).toMatchObject({
      name: 'equalfi-agreement-rp-pod-1',
      gpuTypeIds: ['NVIDIA GeForce RTX 4090'],
      gpuCount: 1,
      volumeInGb: 40,
      imageName: 'runpod/pytorch:latest',
    });
  });

  it('dispatches dedicated mode to pod flow and does not call /endpoints', async () => {
    const urls: string[] = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      urls.push(url);

      if (url.endsWith('/pods') && method === 'POST') {
        return makeResponse({ ok: true, status: 200, json: { data: { id: 'pod_dispatch_1' } } });
      }

      if (url.endsWith('/pods/pod_dispatch_1') && method === 'GET') {
        return makeResponse({ ok: true, status: 200, json: { data: { id: 'pod_dispatch_1', desiredStatus: 'RUNNING' } } });
      }

      return makeResponse({ ok: false, status: 404, json: { error: 'unexpected request' } });
    };

    const adapter = new RunPodComputeAdapter({ apiKey: 'runpod-key', fetchFn: mockFetch, podPollMaxAttempts: 1 });
    const result = await adapter.provision({
      agreementId: 'agreement-rp-dedicated-dispatch',
      policy: { computeMode: 'dedicated' },
    });

    expect(result.status).toBe('ok');
    expect(result.providerResourceId).toBe('pod_dispatch_1');
    expect(urls.some((url) => url.endsWith('/endpoints'))).toBe(false);
  });

  it('returns REST error detail when pod creation fails', async () => {
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/pods') && method === 'POST') {
        return makeResponse({
          ok: false,
          status: 400,
          headers: { 'x-request-id': 'req-pod-err-1' },
          json: { error: 'invalid gpuTypeIds' },
        });
      }
      return makeResponse({ ok: false, status: 404, json: { error: 'unexpected request' } });
    };

    const adapter = new RunPodComputeAdapter({ apiKey: 'runpod-key', fetchFn: mockFetch });
    const result = await adapter.provision({
      agreementId: 'agreement-rp-pod-err-1',
      policy: { computeMode: 'dedicated', gpuTypeIds: ['bad-gpu'] },
    });

    expect(result.status).toBe('error');
    expect(result.message).toMatch(/invalid gpuTypeIds/i);
    expect(result.meta).toMatchObject({ statusCode: 400, requestId: 'req-pod-err-1' });
  });
});
