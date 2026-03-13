import { describe, expect, it } from 'vitest';
import { Interface, Wallet, getAddress } from 'ethers';
import {
  buildPersonalSignMessage,
  resolveErc8004Wallet,
  verifyIdentityProof,
  type OffchainIdentityProof,
} from '../src/identity-resolver';

const diamondAddress = '0x1111111111111111111111111111111111111111';
const targetChainId = 84532;

async function signTypedProof(
  wallet: Wallet,
  overrides: Partial<OffchainIdentityProof> = {}
): Promise<OffchainIdentityProof> {
  const proof: OffchainIdentityProof = {
    mode: 'erc8004_offchain_v1',
    chainId: 8453,
    agentRegistry: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
    agentId: '25070',
    authorizedAddress: wallet.address,
    targetChainId,
    agreementId: '42',
    expiresAt: 2000000000,
    signatureType: 'eip712',
    signature: '0x',
    ...overrides,
  };

  const signature = await wallet.signTypedData(
    {
      name: 'EqualFiIdentityProof',
      version: '1',
      chainId: targetChainId,
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
      agentRegistry: proof.agentRegistry,
      agentId: BigInt(proof.agentId),
      authorizedAddress: proof.authorizedAddress,
      targetChainId: BigInt(proof.targetChainId),
      agreementId: BigInt(proof.agreementId),
      expiresAt: BigInt(proof.expiresAt),
    }
  );

  return { ...proof, signature };
}

describe('identity-resolver', () => {
  it('verifyIdentityProof succeeds for valid typed proof', async () => {
    const wallet = Wallet.createRandom();
    const proof = await signTypedProof(wallet);

    const result = await verifyIdentityProof(proof as unknown as Record<string, unknown>, {
      agreementId: '42',
      targetChainId,
      diamondAddress,
      erc8004ChainId: 8453,
      nowMs: 1700000000000,
      resolveWallet: async () => wallet.address,
    });

    expect(result.ok).toBe(true);
    expect(result.resolvedWallet).toBe(wallet.address);
  });

  it('verifyIdentityProof rejects expired proof', async () => {
    const wallet = Wallet.createRandom();
    const proof = await signTypedProof(wallet, { expiresAt: 1700000000 });

    const result = await verifyIdentityProof(proof as unknown as Record<string, unknown>, {
      agreementId: '42',
      targetChainId,
      diamondAddress,
      erc8004ChainId: 8453,
      nowMs: 1700000100000,
      maxSkewSeconds: 0,
      resolveWallet: async () => wallet.address,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('proof_expired');
  });

  it('verifyIdentityProof rejects wrong target chain and wrong agreement id', async () => {
    const wallet = Wallet.createRandom();
    const proof = await signTypedProof(wallet, {
      targetChainId: 42161,
      agreementId: '99',
      signatureType: 'personal_sign',
      signature: await wallet.signMessage(
        buildPersonalSignMessage(
          {
            mode: 'erc8004_offchain_v1',
            chainId: 8453,
            agentRegistry: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
            agentId: '25070',
            authorizedAddress: wallet.address,
            targetChainId: 42161,
            agreementId: '99',
            expiresAt: 2000000000,
            signature: '0x',
            signatureType: 'personal_sign',
          },
          diamondAddress
        )
      ),
    });

    const chainMismatch = await verifyIdentityProof(proof as unknown as Record<string, unknown>, {
      agreementId: '99',
      targetChainId,
      diamondAddress,
      nowMs: 1700000000000,
      resolveWallet: async () => wallet.address,
    });
    expect(chainMismatch.ok).toBe(false);
    expect(chainMismatch.reason).toBe('target_chain_mismatch');

    const agreementMismatch = await verifyIdentityProof(
      { ...proof, targetChainId } as unknown as Record<string, unknown>,
      {
        agreementId: '42',
        targetChainId,
        diamondAddress,
        nowMs: 1700000000000,
        resolveWallet: async () => wallet.address,
      }
    );
    expect(agreementMismatch.ok).toBe(false);
    expect(agreementMismatch.reason).toBe('agreement_id_mismatch');
  });

  it('verifyIdentityProof rejects when resolved wallet mismatches authorized address', async () => {
    const wallet = Wallet.createRandom();
    const proof = await signTypedProof(wallet);
    const differentWallet = Wallet.createRandom();

    const result = await verifyIdentityProof(proof as unknown as Record<string, unknown>, {
      agreementId: '42',
      targetChainId,
      diamondAddress,
      erc8004ChainId: 8453,
      nowMs: 1700000000000,
      resolveWallet: async () => differentWallet.address,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('resolved_wallet_mismatch');
  });

  it('resolveErc8004Wallet decodes wallet from mocked registry call', async () => {
    const expectedWallet = '0x123400000000000000000000000000000000ABCD';
    const iface = new Interface(['function getAgentWallet(string,uint256) view returns (address)']);
    const encoded = iface.encodeFunctionResult('getAgentWallet(string,uint256)', [expectedWallet]);

    const resolved = await resolveErc8004Wallet('registry-key', '25070', {
      registryAddress: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
      provider: {
        call: async () => encoded,
      },
    });

    expect(resolved).toBe(getAddress(expectedWallet));
  });
});
