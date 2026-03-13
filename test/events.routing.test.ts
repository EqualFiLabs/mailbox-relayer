import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { ComputeAdapterRegistry } from '../src/providers';
import {
  ComputeProvider,
  ComputeProviderAdapter,
  ProvisionRequest,
  ProvisionResult,
  TerminateRequest,
  TerminateResult,
  UsageRequest,
  UsageResult,
} from '../src/providers/types';
import { InMemoryMessageStore } from '../src/store';

class SpyAdapter implements ComputeProviderAdapter {
  readonly provider: ComputeProvider;
  readonly provisionCalls: ProvisionRequest[] = [];

  constructor(provider: ComputeProvider) {
    this.provider = provider;
  }

  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    this.provisionCalls.push(request);
    return {
      status: 'ok',
      provider: this.provider,
      providerResourceId: `${this.provider}-resource-${request.agreementId}`,
      connection: { baseUrl: `https://${this.provider}.example` },
    };
  }

  async usage(_request: UsageRequest): Promise<UsageResult> {
    return { status: 'ok', provider: this.provider, usage: [] };
  }

  async terminate(_request: TerminateRequest): Promise<TerminateResult> {
    return { status: 'ok', provider: this.provider, terminated: true };
  }
}

describe('activation provider routing', () => {
  const adminAuthToken = 'test-admin-token';
  const adminHeaders = { authorization: `Bearer ${adminAuthToken}` };

  const store = new InMemoryMessageStore();
  const registry = new ComputeAdapterRegistry();
  const veniceAdapter = new SpyAdapter('venice');
  const bankrAdapter = new SpyAdapter('bankr');

  registry.register(veniceAdapter);
  registry.register(bankrAdapter);

  const app = buildApp(store, registry, undefined, undefined, undefined, undefined, undefined, undefined, {
    adminAuthToken,
  });

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('fails closed when off-chain override provider mismatches canonical on-chain provider', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/events/onchain',
      headers: adminHeaders,
      payload: {
        chainId: 84532,
        blockNumber: 1400,
        logIndex: 1,
        eventType: 'activation',
        agreementId: 'agreement-provider-mismatch-1',
        provider: 'venice',
        policy: {
          provider: 'bankr',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.results[0].action).toBe('activation_rejected_provider_mismatch');
    expect(body.results[0].message).toBe('provider_override_mismatch');
    expect(body.results[0].meta.canonicalProvider).toBe('venice');
    expect(body.results[0].meta.overrideProvider).toBe('bankr');

    expect(store.getAgreementState('agreement-provider-mismatch-1')?.state).toBe('activation_failed');
    expect(store.getProviderLink('agreement-provider-mismatch-1')).toBeUndefined();
    expect(veniceAdapter.provisionCalls).toHaveLength(0);
    expect(bankrAdapter.provisionCalls).toHaveLength(0);
  });

  it('keeps Venice activation flow unchanged when canonical provider is venice', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/events/onchain',
      headers: adminHeaders,
      payload: {
        chainId: 84532,
        blockNumber: 1400,
        logIndex: 2,
        eventType: 'activation',
        agreementId: 'agreement-venice-canonical-1',
        provider: 'venice',
        payload: {
          provider: 'venice',
          bankrCredentialId: 'ignored-by-venice-routing',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.results[0].action).toBe('activation_processed');
    expect(body.results[0].provider).toBe('venice');
    expect(body.results[0].meta.providerResultStatus).toBe('ok');

    const link = store.getProviderLink('agreement-venice-canonical-1');
    expect(link?.provider).toBe('venice');
    expect(link?.providerResourceId).toBe('venice-resource-agreement-venice-canonical-1');
    expect(store.getAgreementState('agreement-venice-canonical-1')?.state).toBe('active');

    expect(veniceAdapter.provisionCalls).toHaveLength(1);
    expect(bankrAdapter.provisionCalls).toHaveLength(0);
  });
});
