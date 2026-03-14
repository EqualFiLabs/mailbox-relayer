import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

class ProvisioningBankrAdapter implements ComputeProviderAdapter {
  readonly provider = 'bankr' as const;

  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    return {
      status: 'ok',
      provider: this.provider,
      providerResourceId: `bankr-resource-${request.agreementId}`,
      connection: {
        apiKey: 'bankr-connection-key',
      },
    };
  }

  async usage(_request: UsageRequest): Promise<UsageResult> {
    return { status: 'ok', provider: this.provider, usage: [] };
  }

  async terminate(_request: TerminateRequest): Promise<TerminateResult> {
    return { status: 'ok', provider: this.provider, terminated: true };
  }
}

describe('activation auto context resolver', () => {
  const adminAuthToken = 'test-admin-token';
  const adminHeaders = { authorization: `Bearer ${adminAuthToken}` };

  const store = new InMemoryMessageStore();
  const registry = new ComputeAdapterRegistry();
  registry.register(new ProvisioningBankrAdapter());

  const txSubmitter = {
    publishProviderPayload: vi.fn(async () => ({ txHash: '0xabc123' })),
    status: vi.fn(async () => ({
      walletAddress: '0x5555555555555555555555555555555555555555',
      walletBalance: '1.0',
      pendingNonce: 1,
      isEnabled: true,
    })),
  };

  const activationContextResolver = {
    resolveActivationContext: vi.fn(async () => ({
      provider: 'bankr' as const,
      borrowerAddress: '0x4444444444444444444444444444444444444444',
    })),
  };

  const app = buildApp(store, registry, undefined, undefined, undefined, undefined, undefined, undefined, {
    adminAuthToken,
    txSubmitter: txSubmitter as unknown as any,
    activationContextResolver,
  });

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('processes activation without provider payload by resolving on-chain context', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/events/onchain',
      headers: adminHeaders,
      payload: {
        chainId: 84532,
        blockNumber: 1700,
        logIndex: 1,
        eventType: 'activation',
        agreementId: 'agreement-auto-context-1',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.results[0].action).toBe('activation_processed');
    expect(body.results[0].provider).toBe('bankr');

    expect(activationContextResolver.resolveActivationContext).toHaveBeenCalledWith('agreement-auto-context-1');
    expect(txSubmitter.publishProviderPayload).toHaveBeenCalledWith(
      'agreement-auto-context-1',
      { apiKey: 'bankr-connection-key' },
      '0x4444444444444444444444444444444444444444'
    );

    const providerLink = store.getProviderLink('agreement-auto-context-1');
    expect(providerLink?.provider).toBe('bankr');
  });
});
