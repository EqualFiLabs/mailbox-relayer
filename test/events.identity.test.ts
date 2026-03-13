import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
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
    };
  }

  async usage(_request: UsageRequest): Promise<UsageResult> {
    return { status: 'ok', provider: this.provider, usage: [] };
  }

  async terminate(_request: TerminateRequest): Promise<TerminateResult> {
    return { status: 'ok', provider: this.provider, terminated: true };
  }
}

describe('identity proof gating for activation', () => {
  const adminAuthToken = 'test-admin-token';
  const adminHeaders = { authorization: `Bearer ${adminAuthToken}` };
  const store = new InMemoryMessageStore();
  const registry = new ComputeAdapterRegistry();
  const veniceAdapter = new SpyAdapter('venice');
  registry.register(veniceAdapter);
  const wallet = Wallet.createRandom();
  const diamondAddress = '0x1111111111111111111111111111111111111111';

  const app = buildApp(store, registry, undefined, undefined, undefined, undefined, undefined, undefined, {
    adminAuthToken,
    identityGate: {
      mode: 'erc8004_offchain',
      targetChainId: 84532,
      diamondAddress,
      erc8004ChainId: 8453,
      proofMaxSkewSeconds: 0,
      resolveWallet: async () => wallet.address,
    },
  });

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function makeProof(agreementId: string, expiresAt: number) {
    return {
      mode: 'erc8004_offchain_v1',
      chainId: 8453,
      agentRegistry: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
      agentId: '25070',
      authorizedAddress: wallet.address,
      targetChainId: 84532,
      agreementId,
      expiresAt,
      signatureType: 'eip712' as const,
      signature: await wallet.signTypedData(
        {
          name: 'EqualFiIdentityProof',
          version: '1',
          chainId: 84532,
          verifyingContract: diamondAddress,
        },
        {
          IdentityProof: [
            { name: 'agentRegistry', type: 'string' },
            { name: 'agentId', type: 'uint256' },
            { name: 'authorizedAddress', type: 'address' },
            { name: 'targetChainId', type: 'uint256' },
            { name: 'agreementId', type: 'uint256' },
            { name: 'expiresAt', type: 'uint256' },
          ],
        },
        {
          agentRegistry: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
          agentId: 25070n,
          authorizedAddress: wallet.address,
          targetChainId: 84532n,
          agreementId: BigInt(agreementId),
          expiresAt: BigInt(expiresAt),
        }
      ),
    };
  }

  it('rejects activation when identity proof is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/events/onchain',
      headers: adminHeaders,
      payload: {
        chainId: 84532,
        blockNumber: 1800,
        logIndex: 1,
        eventType: 'activation',
        agreementId: '1001',
        provider: 'venice',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accepted).toBe(0);
    expect(body.rejected).toBe(1);
    expect(body.results[0].message).toBe('identity_verification_failed');
    expect(body.results[0].meta.reason).toBe('missing_identity_proof');
    expect(veniceAdapter.provisionCalls).toHaveLength(0);
  });

  it('rejects activation when identity proof agreementId is wrong', async () => {
    const proof = await makeProof('9999', 2000000000);
    const response = await app.inject({
      method: 'POST',
      url: '/events/onchain',
      headers: adminHeaders,
      payload: {
        chainId: 84532,
        blockNumber: 1800,
        logIndex: 2,
        eventType: 'activation',
        agreementId: '1002',
        provider: 'venice',
        payload: { identity: proof },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accepted).toBe(0);
    expect(body.rejected).toBe(1);
    expect(body.results[0].meta.reason).toBe('agreement_id_mismatch');
    expect(veniceAdapter.provisionCalls).toHaveLength(0);
  });

  it('accepts activation with valid identity proof', async () => {
    const proof = await makeProof('1003', 2000000000);
    const response = await app.inject({
      method: 'POST',
      url: '/events/onchain',
      headers: adminHeaders,
      payload: {
        chainId: 84532,
        blockNumber: 1800,
        logIndex: 3,
        eventType: 'activation',
        agreementId: '1003',
        provider: 'venice',
        payload: { identity: proof },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(0);
    expect(body.results[0].action).toBe('activation_processed');
    expect(veniceAdapter.provisionCalls).toHaveLength(1);
    expect(store.getAgreementState('1003')?.state).toBe('active');
  });
});
