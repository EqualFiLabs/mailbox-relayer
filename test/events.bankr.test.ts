import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { ComputeAdapterRegistry } from '../src/providers';
import {
  ComputeProviderAdapter,
  ProvisionRequest,
  ProvisionResult,
  TerminateRequest,
  TerminateResult,
  UsageRequest,
  UsageResult,
} from '../src/providers/types';
import { InMemoryMessageStore } from '../src/store';

class FixedBankrAdapter implements ComputeProviderAdapter {
  readonly provider = 'bankr' as const;

  async provision(_request: ProvisionRequest): Promise<ProvisionResult> {
    return {
      status: 'ok',
      provider: this.provider,
      providerResourceId: 'bankr-shared-credential',
      connection: { baseUrl: 'https://llm.bankr.bot', apiKey: 'agreement-key' },
    };
  }

  async usage(_request: UsageRequest): Promise<UsageResult> {
    return { status: 'ok', provider: this.provider, usage: [] };
  }

  async terminate(_request: TerminateRequest): Promise<TerminateResult> {
    return { status: 'ok', provider: this.provider, terminated: true };
  }
}

describe('onchain activation duplicate Bankr credential guard', () => {
  const adminAuthToken = 'test-admin-token';
  const adminHeaders = { authorization: `Bearer ${adminAuthToken}` };

  const store = new InMemoryMessageStore();
  const registry = new ComputeAdapterRegistry();
  registry.register(new FixedBankrAdapter());
  const app = buildApp(store, registry, undefined, undefined, undefined, undefined, undefined, undefined, {
    adminAuthToken,
  });

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects duplicate providerResourceId assignment across active agreements', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/events/onchain',
      headers: adminHeaders,
      payload: {
        chainId: 84532,
        blockNumber: 1200,
        logIndex: 1,
        eventType: 'activation',
        agreementId: 'agreement-bankr-1',
        provider: 'bankr',
      },
    });

    expect(first.statusCode).toBe(200);
    expect(first.json().results[0].action).toBe('activation_processed');

    const second = await app.inject({
      method: 'POST',
      url: '/events/onchain',
      headers: adminHeaders,
      payload: {
        chainId: 84532,
        blockNumber: 1200,
        logIndex: 2,
        eventType: 'activation',
        agreementId: 'agreement-bankr-2',
        provider: 'bankr',
      },
    });

    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody.results[0].action).toBe('activation_rejected_duplicate_provider_resource');
    expect(secondBody.results[0].meta.conflictingAgreementId).toBe('agreement-bankr-1');

    expect(store.getProviderLink('agreement-bankr-1')?.providerResourceId).toBe('bankr-shared-credential');
    expect(store.getProviderLink('agreement-bankr-2')).toBeUndefined();
    expect(store.getAgreementState('agreement-bankr-2')?.state).toBe('activation_failed');
  });
});
