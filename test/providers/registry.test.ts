import { describe, expect, it } from 'vitest';
import { ComputeAdapterRegistry, createDefaultComputeAdapterRegistry } from '../../src/providers/registry';
import { ComputePolicy } from '../../src/providers/policy';
import {
  ComputeProvider,
  ComputeProviderAdapter,
  ProvisionRequest,
  ProvisionResult,
  TerminateRequest,
  TerminateResult,
  UsageRequest,
  UsageResult,
} from '../../src/providers/types';

class StubAdapter implements ComputeProviderAdapter {
  constructor(readonly provider: ComputeProvider) {}

  async provision(_request: ProvisionRequest): Promise<ProvisionResult> {
    return { status: 'ok', provider: this.provider, providerResourceId: `${this.provider}-resource` };
  }

  async usage(_request: UsageRequest): Promise<UsageResult> {
    return { status: 'ok', provider: this.provider, usage: [] };
  }

  async terminate(_request: TerminateRequest): Promise<TerminateResult> {
    return { status: 'ok', provider: this.provider, terminated: true };
  }
}

class StubLogger {
  readonly entries: Array<{ payload: Record<string, unknown>; message?: string }> = [];

  info = (payload: Record<string, unknown>, message?: string): void => {
    this.entries.push({ payload, message });
  };
}

function newRegistry(logger: StubLogger): ComputeAdapterRegistry {
  const registry = new ComputeAdapterRegistry(logger);
  registry.register(new StubAdapter('lambda'));
  registry.register(new StubAdapter('runpod'));
  registry.register(new StubAdapter('venice'));
  registry.register(new StubAdapter('bankr'));
  return registry;
}

describe('ComputeAdapterRegistry routing and circuit-breaker', () => {
  it('resolves all 12 provider×computeMode combinations using explicit provider first', () => {
    const logger = new StubLogger();
    const registry = newRegistry(logger);
    const providers: ComputeProvider[] = ['lambda', 'runpod', 'venice', 'bankr'];
    const computeModes: Array<NonNullable<ComputePolicy['computeMode']>> = ['dedicated', 'burst', 'api_inference'];

    for (const provider of providers) {
      for (const computeMode of computeModes) {
        const resolved = registry.resolve({ provider, computeMode });
        expect(resolved?.provider).toBe(provider);
      }
    }
  });

  it('falls back to computeMode routing when provider is not set', () => {
    const logger = new StubLogger();
    const registry = newRegistry(logger);

    expect(registry.resolve({ computeMode: 'dedicated' })?.provider).toBe('lambda');
    expect(registry.resolve({ computeMode: 'burst' })?.provider).toBe('runpod');
    expect(registry.resolve({ computeMode: 'api_inference' })?.provider).toBe('venice');
    expect(registry.resolve({})).toBeUndefined();
  });

  it('returns undefined for disabled providers and supports disable/enable state', () => {
    const logger = new StubLogger();
    const registry = newRegistry(logger);

    expect(registry.isEnabled('runpod')).toBe(true);

    registry.disable('runpod');
    expect(registry.isEnabled('runpod')).toBe(false);
    expect(registry.resolve({ provider: 'runpod' })).toBeUndefined();
    expect(registry.resolve({ computeMode: 'burst' })).toBeUndefined();

    registry.enable('runpod');
    expect(registry.isEnabled('runpod')).toBe(true);
    expect(registry.resolve({ provider: 'runpod' })?.provider).toBe('runpod');
    expect(registry.resolve({ computeMode: 'burst' })?.provider).toBe('runpod');
  });

  it('logs routing decisions with agreementId, resolved provider, and policy fields', () => {
    const logger = new StubLogger();
    const registry = newRegistry(logger);

    const resolved = registry.resolve({
      provider: 'bankr',
      computeMode: 'api_inference',
      agreementId: 'agreement-routing-1',
    } as unknown as ComputePolicy);

    expect(resolved?.provider).toBe('bankr');
    expect(logger.entries.length).toBeGreaterThan(0);

    const last = logger.entries[logger.entries.length - 1];
    expect(last).toBeDefined();
    if (!last) return;

    expect(last.message).toBe('compute adapter routing decision');
    expect(last.payload).toMatchObject({
      agreementId: 'agreement-routing-1',
      provider: 'bankr',
      computeMode: 'api_inference',
      resolvedProvider: 'bankr',
      routeSource: 'provider',
    });
  });
});

describe('createDefaultComputeAdapterRegistry env wiring', () => {
  it('passes Lambda and RunPod env config into default adapter construction', () => {
    const previousEnv = {
      LAMBDA_API_KEY: process.env.LAMBDA_API_KEY,
      LAMBDA_BASE_URL: process.env.LAMBDA_BASE_URL,
      RUNPOD_API_KEY: process.env.RUNPOD_API_KEY,
      RUNPOD_SERVERLESS_BASE_URL: process.env.RUNPOD_SERVERLESS_BASE_URL,
      RUNPOD_INFRA_BASE_URL: process.env.RUNPOD_INFRA_BASE_URL,
    };

    process.env.LAMBDA_API_KEY = 'lambda-env-key';
    process.env.LAMBDA_BASE_URL = 'https://lambda.env.local/v1';
    process.env.RUNPOD_API_KEY = 'runpod-env-key';
    process.env.RUNPOD_SERVERLESS_BASE_URL = 'https://serverless.env.local/v2';
    process.env.RUNPOD_INFRA_BASE_URL = 'https://infra.env.local/v1';

    try {
      const registry = createDefaultComputeAdapterRegistry();

      const lambdaAdapter = registry.get('lambda') as unknown as Record<string, unknown> | undefined;
      const runpodAdapter = registry.get('runpod') as unknown as Record<string, unknown> | undefined;

      expect(lambdaAdapter?.apiKey).toBe('lambda-env-key');
      expect(lambdaAdapter?.baseUrl).toBe('https://lambda.env.local/v1');
      expect(runpodAdapter?.apiKey).toBe('runpod-env-key');
      expect(runpodAdapter?.serverlessBaseUrl).toBe('https://serverless.env.local/v2');
      expect(runpodAdapter?.infraBaseUrl).toBe('https://infra.env.local/v1');
    } finally {
      process.env.LAMBDA_API_KEY = previousEnv.LAMBDA_API_KEY;
      process.env.LAMBDA_BASE_URL = previousEnv.LAMBDA_BASE_URL;
      process.env.RUNPOD_API_KEY = previousEnv.RUNPOD_API_KEY;
      process.env.RUNPOD_SERVERLESS_BASE_URL = previousEnv.RUNPOD_SERVERLESS_BASE_URL;
      process.env.RUNPOD_INFRA_BASE_URL = previousEnv.RUNPOD_INFRA_BASE_URL;
    }
  });
});
