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

class ProvisioningAdapter implements ComputeProviderAdapter {
  readonly provider = 'venice' as const;

  async provision(_request: ProvisionRequest): Promise<ProvisionResult> {
    return {
      status: 'ok',
      provider: this.provider,
      providerResourceId: `venice-resource-${_request.agreementId}`,
      connection: {
        apiKey: 'venice-connection-key',
        baseUrl: 'https://api.venice.ai/api/v1',
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

describe('activation -> provider payload publication wiring', () => {
  const adminAuthToken = 'test-admin-token';
  const adminHeaders = { authorization: `Bearer ${adminAuthToken}` };

  const store = new InMemoryMessageStore();
  const registry = new ComputeAdapterRegistry();
  registry.register(new ProvisioningAdapter());

  const txSubmitter = {
    publishProviderPayload: vi.fn(async () => ({ txHash: '0xabc123' })),
    status: vi.fn(async () => ({
      walletAddress: '0x5555555555555555555555555555555555555555',
      walletBalance: '1.0',
      pendingNonce: 1,
      isEnabled: true,
    })),
  };

  const app = buildApp(store, registry, undefined, undefined, undefined, undefined, undefined, undefined, {
    adminAuthToken,
    txSubmitter: txSubmitter as unknown as any,
  });

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('publishes provider payload after successful activation when borrower address is available', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/events/onchain',
      headers: adminHeaders,
      payload: {
        chainId: 84532,
        blockNumber: 1500,
        logIndex: 1,
        eventType: 'activation',
        agreementId: 'agreement-publish-1',
        provider: 'venice',
        payload: {
          borrowerAddress: '0x4444444444444444444444444444444444444444',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.results[0].action).toBe('activation_processed');
    expect(body.results[0].meta.providerPayloadPublish.status).toBe('published');

    expect(txSubmitter.publishProviderPayload).toHaveBeenCalledTimes(1);
    expect(txSubmitter.publishProviderPayload).toHaveBeenCalledWith(
      'agreement-publish-1',
      {
        apiKey: 'venice-connection-key',
        baseUrl: 'https://api.venice.ai/api/v1',
      },
      '0x4444444444444444444444444444444444444444'
    );
  });

  it('skips provider payload publication when borrower address is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/events/onchain',
      headers: adminHeaders,
      payload: {
        chainId: 84532,
        blockNumber: 1500,
        logIndex: 2,
        eventType: 'activation',
        agreementId: 'agreement-publish-2',
        provider: 'venice',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.results[0].action).toBe('activation_processed');
    expect(body.results[0].meta.providerPayloadPublish.status).toBe('skipped');
    expect(body.results[0].meta.providerPayloadPublish.reason).toBe('missing_borrower_address');

    expect(txSubmitter.publishProviderPayload).toHaveBeenCalledTimes(1);
  });
});
