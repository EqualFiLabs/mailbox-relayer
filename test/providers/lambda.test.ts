import { describe, expect, it, vi } from 'vitest';
import { LambdaComputeAdapter } from '../../src/providers/lambda';

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

describe('LambdaComputeAdapter provisioning', () => {
  it('provisions successfully with SSH key creation and ready connection details', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });

      if (url.endsWith('/ssh-keys') && method === 'GET') {
        return makeResponse({
          ok: true,
          status: 200,
          headers: { 'x-request-id': 'req-keys-list' },
          json: { data: [] },
        });
      }

      if (url.endsWith('/ssh-keys') && method === 'POST') {
        return makeResponse({
          ok: true,
          status: 200,
          headers: { 'x-request-id': 'req-keys-create' },
          json: { data: { id: 'key-1', name: body?.name } },
        });
      }

      if (url.endsWith('/instance-operations/launch') && method === 'POST') {
        return makeResponse({
          ok: true,
          status: 200,
          headers: { 'x-request-id': 'req-launch' },
          json: { data: { instance_ids: ['i-123'] } },
        });
      }

      if (url.endsWith('/instances/i-123') && method === 'GET') {
        return makeResponse({
          ok: true,
          status: 200,
          headers: { 'x-request-id': 'req-instance' },
          json: { data: { id: 'i-123', status: 'active', ip: '203.0.113.10' } },
        });
      }

      return makeResponse({ ok: false, status: 404, json: { error: { message: 'unexpected request' } } });
    };

    const adapter = new LambdaComputeAdapter({
      apiKey: 'lambda-key',
      fetchFn: mockFetch,
      sleepFn: async () => undefined,
    });

    const result = await adapter.provision({
      agreementId: 'agreement-1',
      traceId: 'trace-1',
      policy: { instanceType: 'h100_80gb', region: 'us-west-1' },
      payload: { sshPublicKey: 'ssh-ed25519 AAAA' },
    });

    expect(result.status).toBe('ok');
    expect(result.providerResourceId).toBe('i-123');
    expect(result.connection).toMatchObject({
      ssh_host: '203.0.113.10',
      ssh_port: 22,
      ssh_user: 'ubuntu',
    });
    expect(result.meta).toMatchObject({
      agreementId: 'agreement-1',
      traceId: 'trace-1',
      launchRequestId: 'req-launch',
      requestId: 'req-instance',
    });

    const launchCall = calls.find((call) => call.url.endsWith('/instance-operations/launch'));
    expect(launchCall?.body).toMatchObject({
      region_name: 'us-west-1',
      instance_type_name: 'gpu_1x_h100_pcie',
      ssh_key_names: ['equalfi-agreement-1'],
      name: 'equalfi-agreement-1-trace-1',
      quantity: 1,
    });
  });

  it('reuses an existing SSH key and skips key creation', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });

      if (url.endsWith('/ssh-keys') && method === 'GET') {
        return makeResponse({
          ok: true,
          status: 200,
          json: { data: [{ id: 'k1', name: 'equalfi-agreement-2', public_key: 'ssh-ed25519 AAAA' }] },
        });
      }
      if (url.endsWith('/instance-operations/launch') && method === 'POST') {
        return makeResponse({ ok: true, status: 200, json: { data: { instance_ids: ['i-234'] } } });
      }
      if (url.endsWith('/instances/i-234') && method === 'GET') {
        return makeResponse({ ok: true, status: 200, json: { data: { status: 'active', ip: '203.0.113.20' } } });
      }
      return makeResponse({ ok: false, status: 404, json: { error: { message: 'unexpected request' } } });
    };

    const adapter = new LambdaComputeAdapter({ apiKey: 'lambda-key', fetchFn: mockFetch });
    const result = await adapter.provision({
      agreementId: 'agreement-2',
      policy: { instanceType: 'a100_40gb' },
      payload: { sshPublicKey: 'ssh-ed25519 AAAA' },
    });

    expect(result.status).toBe('ok');
    expect(calls.some((call) => call.url.endsWith('/ssh-keys') && call.method === 'POST')).toBe(false);
  });

  it('returns config error when LAMBDA_API_KEY is missing', async () => {
    const adapter = new LambdaComputeAdapter({ apiKey: '' });
    const result = await adapter.provision({
      agreementId: 'agreement-3',
      policy: { instanceType: 'a100_40gb' },
      payload: { sshPublicKey: 'ssh-ed25519 AAAA' },
    });

    expect(result.status).toBe('error');
    expect(result.message).toBe('LAMBDA_API_KEY not configured');
  });

  it('returns unsupported_instance_type when policy instance type cannot be mapped', async () => {
    const mockFetch = vi.fn<typeof fetch>();
    const adapter = new LambdaComputeAdapter({ apiKey: 'lambda-key', fetchFn: mockFetch });

    const result = await adapter.provision({
      agreementId: 'agreement-4',
      policy: { instanceType: 'unknown_type' },
      payload: { sshPublicKey: 'ssh-ed25519 AAAA' },
    });

    expect(result.status).toBe('error');
    expect(result.message).toBe('unsupported_instance_type');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns error when SSH key creation fails and does not attempt launch', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });

      if (url.endsWith('/ssh-keys') && method === 'GET') {
        return makeResponse({ ok: true, status: 200, json: { data: [] } });
      }
      if (url.endsWith('/ssh-keys') && method === 'POST') {
        return makeResponse({ ok: false, status: 400, json: { error: { message: 'invalid ssh key' } } });
      }

      return makeResponse({ ok: false, status: 404, json: { error: { message: 'unexpected request' } } });
    };

    const adapter = new LambdaComputeAdapter({ apiKey: 'lambda-key', fetchFn: mockFetch });
    const result = await adapter.provision({
      agreementId: 'agreement-5',
      policy: { instanceType: 'a10_24gb' },
      payload: { sshPublicKey: 'ssh-ed25519 AAAA' },
    });

    expect(result.status).toBe('error');
    expect(result.message).toMatch(/invalid ssh key/i);
    expect(calls.some((call) => call.url.endsWith('/instance-operations/launch'))).toBe(false);
  });

  it('returns launch API error details', async () => {
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/ssh-keys') && method === 'GET') {
        return makeResponse({
          ok: true,
          status: 200,
          json: { data: [{ id: 'k1', name: 'equalfi-agreement-6', public_key: 'ssh-ed25519 AAAA' }] },
        });
      }
      if (url.endsWith('/instance-operations/launch') && method === 'POST') {
        return makeResponse({
          ok: false,
          status: 400,
          headers: { 'x-request-id': 'req-launch-err' },
          json: { error: { message: 'insufficient capacity' } },
        });
      }

      return makeResponse({ ok: false, status: 404, json: { error: { message: 'unexpected request' } } });
    };

    const adapter = new LambdaComputeAdapter({ apiKey: 'lambda-key', fetchFn: mockFetch });
    const result = await adapter.provision({
      agreementId: 'agreement-6',
      traceId: 'trace-6',
      policy: { instanceType: 'h100_80gb' },
      payload: { sshPublicKey: 'ssh-ed25519 AAAA' },
    });

    expect(result.status).toBe('error');
    expect(result.message).toMatch(/insufficient capacity/i);
    expect(result.meta).toMatchObject({ statusCode: 400, requestId: 'req-launch-err' });
  });

  it('retries on HTTP 429 respecting Retry-After header', async () => {
    let launchAttempts = 0;
    const sleepCalls: number[] = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/ssh-keys') && method === 'GET') {
        return makeResponse({
          ok: true,
          status: 200,
          json: { data: [{ id: 'k1', name: 'equalfi-agreement-7', public_key: 'ssh-ed25519 AAAA' }] },
        });
      }

      if (url.endsWith('/instance-operations/launch') && method === 'POST') {
        launchAttempts += 1;
        if (launchAttempts === 1) {
          return makeResponse({
            ok: false,
            status: 429,
            headers: { 'Retry-After': '0' },
            json: { error: { message: 'rate limited' } },
          });
        }
        return makeResponse({ ok: true, status: 200, json: { data: { instance_ids: ['i-777'] } } });
      }

      if (url.endsWith('/instances/i-777') && method === 'GET') {
        return makeResponse({ ok: true, status: 200, json: { data: { status: 'active', ip: '203.0.113.77' } } });
      }

      return makeResponse({ ok: false, status: 404, json: { error: { message: 'unexpected request' } } });
    };

    const adapter = new LambdaComputeAdapter({
      apiKey: 'lambda-key',
      fetchFn: mockFetch,
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    const result = await adapter.provision({
      agreementId: 'agreement-7',
      policy: { instanceType: 'a100_40gb' },
      payload: { sshPublicKey: 'ssh-ed25519 AAAA' },
    });

    expect(result.status).toBe('ok');
    expect(launchAttempts).toBe(2);
    expect(sleepCalls).toEqual([0]);
  });

  it('retries on HTTP 5xx with exponential backoff', async () => {
    let launchAttempts = 0;
    const sleepCalls: number[] = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/ssh-keys') && method === 'GET') {
        return makeResponse({
          ok: true,
          status: 200,
          json: { data: [{ id: 'k1', name: 'equalfi-agreement-8', public_key: 'ssh-ed25519 AAAA' }] },
        });
      }

      if (url.endsWith('/instance-operations/launch') && method === 'POST') {
        launchAttempts += 1;
        if (launchAttempts === 1) {
          return makeResponse({ ok: false, status: 503, json: { error: { message: 'provider unavailable' } } });
        }
        return makeResponse({ ok: true, status: 200, json: { data: { instance_ids: ['i-888'] } } });
      }

      if (url.endsWith('/instances/i-888') && method === 'GET') {
        return makeResponse({ ok: true, status: 200, json: { data: { status: 'active', ip: '203.0.113.88' } } });
      }

      return makeResponse({ ok: false, status: 404, json: { error: { message: 'unexpected request' } } });
    };

    const adapter = new LambdaComputeAdapter({
      apiKey: 'lambda-key',
      fetchFn: mockFetch,
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    const result = await adapter.provision({
      agreementId: 'agreement-8',
      policy: { instanceType: 'a100_40gb' },
      payload: { sshPublicKey: 'ssh-ed25519 AAAA' },
    });

    expect(result.status).toBe('ok');
    expect(launchAttempts).toBe(2);
    expect(sleepCalls).toEqual([1000]);
  });

  it('returns connectionPending when launched instance is not SSH-ready', async () => {
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/ssh-keys') && method === 'GET') {
        return makeResponse({
          ok: true,
          status: 200,
          json: { data: [{ id: 'k1', name: 'equalfi-agreement-9', public_key: 'ssh-ed25519 AAAA' }] },
        });
      }
      if (url.endsWith('/instance-operations/launch') && method === 'POST') {
        return makeResponse({ ok: true, status: 200, json: { data: { instance_ids: ['i-999'] } } });
      }
      if (url.endsWith('/instances/i-999') && method === 'GET') {
        return makeResponse({ ok: true, status: 200, json: { data: { status: 'booting' } } });
      }

      return makeResponse({ ok: false, status: 404, json: { error: { message: 'unexpected request' } } });
    };

    const adapter = new LambdaComputeAdapter({ apiKey: 'lambda-key', fetchFn: mockFetch });
    const result = await adapter.provision({
      agreementId: 'agreement-9',
      traceId: 'trace-9',
      policy: { instanceType: 'h100_80gb' },
      payload: { sshPublicKey: 'ssh-ed25519 AAAA' },
    });

    expect(result.status).toBe('ok');
    expect(result.providerResourceId).toBe('i-999');
    expect(result.connectionPending).toBe(true);
    expect(result.connection).toBeUndefined();
  });

  it('includes agreementId in launched instance name', async () => {
    const launchBodies: Record<string, unknown>[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/ssh-keys') && method === 'GET') {
        return makeResponse({
          ok: true,
          status: 200,
          json: { data: [{ id: 'k1', name: 'equalfi-agreement-name-1', public_key: 'ssh-ed25519 AAAA' }] },
        });
      }
      if (url.endsWith('/instance-operations/launch') && method === 'POST') {
        if (init?.body) {
          launchBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        }
        return makeResponse({ ok: true, status: 200, json: { data: { instance_ids: ['i-name-1'] } } });
      }
      if (url.endsWith('/instances/i-name-1') && method === 'GET') {
        return makeResponse({ ok: true, status: 200, json: { data: { status: 'active', ip: '203.0.113.99' } } });
      }

      return makeResponse({ ok: false, status: 404, json: { error: { message: 'unexpected request' } } });
    };

    const adapter = new LambdaComputeAdapter({ apiKey: 'lambda-key', fetchFn: mockFetch });
    const agreementId = 'agreement-name-1';
    const result = await adapter.provision({
      agreementId,
      policy: { instanceType: 'a10_24gb' },
      payload: { sshPublicKey: 'ssh-ed25519 AAAA' },
    });

    expect(result.status).toBe('ok');
    expect(launchBodies).toHaveLength(1);
    expect(launchBodies[0].name).toBe(`equalfi-${agreementId}`);
  });
});

describe('LambdaComputeAdapter usage metering', () => {
  it('computes usage for a running instance over a bounded window', async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);

      if (url.endsWith('/instances/i-run-1')) {
        return makeResponse({
          ok: true,
          status: 200,
          headers: { 'x-request-id': 'req-usage-running' },
          json: {
            data: {
              id: 'i-run-1',
              status: 'active',
              launch_time: '2026-03-12T10:00:00.000Z',
              instance_type_name: 'gpu_1x_a100',
            },
          },
        });
      }

      return makeResponse({ ok: false, status: 404, json: { error: { message: 'unexpected request' } } });
    };

    const adapter = new LambdaComputeAdapter({ apiKey: 'lambda-key', fetchFn: mockFetch });
    const result = await adapter.usage({
      agreementId: 'agreement-usage-1',
      providerResourceId: 'i-run-1',
      from: '2026-03-12T10:30:00.000Z',
      to: '2026-03-12T12:00:00.000Z',
    });

    expect(result.status).toBe('ok');
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]).toMatchObject({
      unitType: 'GPU_HOUR_A100',
      amount: '1.500000000000000000',
      observedAt: '2026-03-12T12:00:00.000Z',
    });
  });

  it('computes usage up to termination time for terminated instances', async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);

      if (url.endsWith('/instances/i-term-1')) {
        return makeResponse({
          ok: true,
          status: 200,
          json: {
            data: {
              id: 'i-term-1',
              status: 'terminated',
              launch_time: '2026-03-12T10:00:00.000Z',
              terminated_at: '2026-03-12T11:00:00.000Z',
              instance_type_name: 'gpu_1x_h100_pcie',
            },
          },
        });
      }

      return makeResponse({ ok: false, status: 404, json: { error: { message: 'unexpected request' } } });
    };

    const adapter = new LambdaComputeAdapter({ apiKey: 'lambda-key', fetchFn: mockFetch });
    const result = await adapter.usage({
      agreementId: 'agreement-usage-2',
      providerResourceId: 'i-term-1',
      from: '2026-03-12T09:00:00.000Z',
      to: '2026-03-12T12:00:00.000Z',
    });

    expect(result.status).toBe('ok');
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]).toMatchObject({
      unitType: 'GPU_HOUR_H100',
      amount: '1.000000000000000000',
      observedAt: '2026-03-12T11:00:00.000Z',
    });
    expect(result.meta?.instanceStatus).toBe('terminated');
  });

  it('returns error when instance lookup fails', async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/instances/i-missing-1')) {
        return makeResponse({
          ok: false,
          status: 404,
          json: { error: { message: 'object does not exist' } },
        });
      }
      return makeResponse({ ok: false, status: 404, json: { error: { message: 'unexpected request' } } });
    };

    const adapter = new LambdaComputeAdapter({ apiKey: 'lambda-key', fetchFn: mockFetch });
    const result = await adapter.usage({
      agreementId: 'agreement-usage-3',
      providerResourceId: 'i-missing-1',
    });

    expect(result.status).toBe('error');
    expect(result.usage).toEqual([]);
    expect(result.message).toMatch(/does not exist|http 404/i);
  });

  it('maps instance type to canonical unit type in usage output', async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);

      if (url.endsWith('/instances/i-map-1')) {
        return makeResponse({
          ok: true,
          status: 200,
          json: {
            data: {
              id: 'i-map-1',
              status: 'active',
              launch_time: '2026-03-12T10:00:00.000Z',
              instance_type: { name: 'gpu_1x_a10' },
            },
          },
        });
      }

      return makeResponse({ ok: false, status: 404, json: { error: { message: 'unexpected request' } } });
    };

    const adapter = new LambdaComputeAdapter({ apiKey: 'lambda-key', fetchFn: mockFetch });
    const result = await adapter.usage({
      agreementId: 'agreement-usage-4',
      providerResourceId: 'i-map-1',
      from: '2026-03-12T10:00:00.000Z',
      to: '2026-03-12T11:00:00.000Z',
    });

    expect(result.status).toBe('ok');
    expect(result.usage[0].unitType).toBe('GPU_HOUR_A10');
  });
});

describe('LambdaComputeAdapter termination', () => {
  it('terminates instance successfully', async () => {
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/instance-operations/terminate') && method === 'POST') {
        return makeResponse({
          ok: true,
          status: 200,
          headers: { 'x-request-id': 'req-terminate-ok' },
          json: { data: { terminated_instances: [{ id: 'i-term-ok-1' }] } },
        });
      }
      return makeResponse({ ok: false, status: 404, json: { error: { message: 'unexpected request' } } });
    };

    const adapter = new LambdaComputeAdapter({ apiKey: 'lambda-key', fetchFn: mockFetch });
    const result = await adapter.terminate({
      agreementId: 'agreement-term-1',
      providerResourceId: 'i-term-ok-1',
      reason: 'breach',
    });

    expect(result.status).toBe('ok');
    expect(result.terminated).toBe(true);
    expect(result.meta).toMatchObject({
      agreementId: 'agreement-term-1',
      providerResourceId: 'i-term-ok-1',
      reason: 'breach',
      requestId: 'req-terminate-ok',
    });
  });

  it('returns idempotent success when instance is already terminated or not found', async () => {
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/instance-operations/terminate') && method === 'POST') {
        return makeResponse({
          ok: false,
          status: 404,
          json: { error: { message: 'object does not exist' } },
        });
      }
      return makeResponse({ ok: false, status: 404, json: { error: { message: 'unexpected request' } } });
    };

    const adapter = new LambdaComputeAdapter({ apiKey: 'lambda-key', fetchFn: mockFetch });
    const result = await adapter.terminate({
      agreementId: 'agreement-term-2',
      providerResourceId: 'i-term-ok-2',
      reason: 'default',
    });

    expect(result.status).toBe('ok');
    expect(result.terminated).toBe(true);
  });

  it('returns error when terminate API call fails', async () => {
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/instance-operations/terminate') && method === 'POST') {
        return makeResponse({
          ok: false,
          status: 400,
          json: { error: { message: 'invalid parameters' } },
        });
      }
      return makeResponse({ ok: false, status: 404, json: { error: { message: 'unexpected request' } } });
    };

    const adapter = new LambdaComputeAdapter({ apiKey: 'lambda-key', fetchFn: mockFetch });
    const result = await adapter.terminate({
      agreementId: 'agreement-term-3',
      providerResourceId: 'i-term-fail-1',
      reason: 'breach',
    });

    expect(result.status).toBe('error');
    expect(result.terminated).toBe(false);
    expect(result.message).toMatch(/invalid parameters/i);
  });
});
