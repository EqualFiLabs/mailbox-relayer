import {
  Interface,
  JsonRpcProvider,
  getAddress,
  isAddress,
  verifyMessage,
  verifyTypedData,
} from 'ethers';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

type SignatureType = 'eip712' | 'personal_sign';

export interface OffchainIdentityProof {
  mode: string;
  chainId: number | string;
  agentRegistry: string;
  agentId: string;
  authorizedAddress: string;
  targetChainId: number | string;
  agreementId: string;
  expiresAt: number | string;
  signature: string;
  signatureType?: SignatureType;
}

export interface ResolveErc8004WalletConfig {
  rpcUrl?: string;
  chainId?: number;
  registryAddress: string;
  provider?: {
    call(request: { to: string; data: string }): Promise<string>;
  };
}

export interface AgreementIdentityContext {
  agreementId: string;
  targetChainId: number;
  diamondAddress: string;
  erc8004ChainId?: number;
  erc8004RpcUrl?: string;
  erc8004RegistryAddress?: string;
  maxSkewSeconds?: number;
  nowMs?: number;
  resolveWallet?: (agentRegistry: string, agentId: string) => Promise<string>;
}

export interface IdentityVerificationResult {
  ok: boolean;
  reason?: string;
  resolvedWallet?: string;
}

function parseUint(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new Error('invalid_uint');
    }
    return BigInt(value);
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('invalid_uint');
  }
  return BigInt(trimmed);
}

function parseEpochSeconds(value: string | number): bigint {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('invalid_expires_at');
    }
    return BigInt(Math.floor(value));
  }

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return BigInt(trimmed);
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error('invalid_expires_at');
  }
  return BigInt(Math.floor(parsed / 1000));
}

function buildTypedDomain(targetChainId: number, diamondAddress: string) {
  return {
    name: 'EqualFiIdentityProof',
    version: '1',
    chainId: targetChainId,
    verifyingContract: diamondAddress,
  } as const;
}

const TYPED_TYPES = {
  IdentityProof: [
    { name: 'agentRegistry', type: 'string' },
    { name: 'agentId', type: 'uint256' },
    { name: 'authorizedAddress', type: 'address' },
    { name: 'targetChainId', type: 'uint256' },
    { name: 'agreementId', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
  ],
} as const;

export function buildPersonalSignMessage(proof: OffchainIdentityProof, diamondAddress: string): string {
  return [
    'EqualFi Identity Proof v1',
    `agentRegistry:${proof.agentRegistry}`,
    `agentId:${proof.agentId}`,
    `authorizedAddress:${proof.authorizedAddress}`,
    `targetChainId:${String(proof.targetChainId)}`,
    `agreementId:${proof.agreementId}`,
    `expiresAt:${String(proof.expiresAt)}`,
    `verifyingContract:${diamondAddress}`,
  ].join('\n');
}

async function recoverSigner(
  proof: OffchainIdentityProof,
  agreementContext: AgreementIdentityContext
): Promise<string | undefined> {
  const signatureType = proof.signatureType;

  const tryEip712 = (): string | undefined => {
    try {
      const recovered = verifyTypedData(
        buildTypedDomain(agreementContext.targetChainId, agreementContext.diamondAddress),
        TYPED_TYPES,
        {
          agentRegistry: proof.agentRegistry,
          agentId: parseUint(proof.agentId),
          authorizedAddress: proof.authorizedAddress,
          targetChainId: parseUint(proof.targetChainId),
          agreementId: parseUint(proof.agreementId),
          expiresAt: parseEpochSeconds(proof.expiresAt),
        },
        proof.signature
      );
      return getAddress(recovered);
    } catch {
      return undefined;
    }
  };

  const tryPersonalSign = (): string | undefined => {
    try {
      const recovered = verifyMessage(buildPersonalSignMessage(proof, agreementContext.diamondAddress), proof.signature);
      return getAddress(recovered);
    } catch {
      return undefined;
    }
  };

  if (signatureType === 'eip712') {
    return tryEip712();
  }
  if (signatureType === 'personal_sign') {
    return tryPersonalSign();
  }

  return tryEip712() ?? tryPersonalSign();
}

function getResolverProvider(config: ResolveErc8004WalletConfig) {
  if (config.provider) {
    return config.provider;
  }

  if (!config.rpcUrl) {
    throw new Error('missing_erc8004_rpc_url');
  }

  return new JsonRpcProvider(config.rpcUrl, config.chainId);
}

async function tryResolveCandidate(
  provider: { call(request: { to: string; data: string }): Promise<string> },
  registryAddress: string,
  signature: string,
  args: Array<string | bigint>
): Promise<string | undefined> {
  const iface = new Interface([`function ${signature} view returns (address)`]);
  const fn = iface.getFunction(signature);
  if (!fn) return undefined;

  try {
    const data = iface.encodeFunctionData(fn, args);
    const rawResult = await provider.call({ to: registryAddress, data });
    const decoded = iface.decodeFunctionResult(fn, rawResult)[0];
    if (typeof decoded !== 'string') return undefined;
    if (!isAddress(decoded)) return undefined;
    const normalized = getAddress(decoded);
    if (normalized === ZERO_ADDRESS) return undefined;
    return normalized;
  } catch {
    return undefined;
  }
}

export async function resolveErc8004Wallet(
  agentRegistry: string,
  agentId: string,
  config: ResolveErc8004WalletConfig
): Promise<string> {
  if (!isAddress(config.registryAddress)) {
    throw new Error('invalid_erc8004_registry_address');
  }

  const agentIdUint = parseUint(agentId);
  const provider = getResolverProvider(config);

  const candidates: Array<{ signature: string; args: Array<string | bigint> }> = [
    { signature: 'getAgentWallet(string,uint256)', args: [agentRegistry, agentIdUint] },
    { signature: 'resolveAgentWallet(string,uint256)', args: [agentRegistry, agentIdUint] },
    { signature: 'agentWallet(string,uint256)', args: [agentRegistry, agentIdUint] },
    { signature: 'ownerOf(uint256)', args: [agentIdUint] },
  ];

  if (isAddress(agentRegistry)) {
    const normalizedRegistry = getAddress(agentRegistry);
    candidates.unshift(
      { signature: 'getAgentWallet(address,uint256)', args: [normalizedRegistry, agentIdUint] },
      { signature: 'resolveAgentWallet(address,uint256)', args: [normalizedRegistry, agentIdUint] },
      { signature: 'agentWallet(address,uint256)', args: [normalizedRegistry, agentIdUint] }
    );
  }

  for (const candidate of candidates) {
    const resolved = await tryResolveCandidate(provider, config.registryAddress, candidate.signature, candidate.args);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error('identity_resolution_failed');
}

export async function verifyIdentityProof(
  proofInput: Record<string, unknown>,
  agreementContext: AgreementIdentityContext
): Promise<IdentityVerificationResult> {
  try {
    const proof = proofInput as OffchainIdentityProof;
    if (proof.mode !== 'erc8004_offchain_v1') {
      return { ok: false, reason: 'invalid_identity_mode' };
    }

    if (!isAddress(agreementContext.diamondAddress)) {
      return { ok: false, reason: 'invalid_diamond_address' };
    }

    if (!isAddress(proof.authorizedAddress)) {
      return { ok: false, reason: 'invalid_authorized_address' };
    }

    if (String(proof.agreementId) !== agreementContext.agreementId) {
      return { ok: false, reason: 'agreement_id_mismatch' };
    }

    const proofTargetChainId = Number(parseUint(proof.targetChainId));
    if (!Number.isFinite(proofTargetChainId) || proofTargetChainId !== agreementContext.targetChainId) {
      return { ok: false, reason: 'target_chain_mismatch' };
    }

    if (agreementContext.erc8004ChainId !== undefined) {
      const proofSourceChainId = Number(parseUint(proof.chainId));
      if (!Number.isFinite(proofSourceChainId) || proofSourceChainId !== agreementContext.erc8004ChainId) {
        return { ok: false, reason: 'source_chain_mismatch' };
      }
    }

    const nowSec = BigInt(Math.floor((agreementContext.nowMs ?? Date.now()) / 1000));
    const skew = BigInt(agreementContext.maxSkewSeconds ?? 0);
    const expiresAt = parseEpochSeconds(proof.expiresAt);
    if (expiresAt + skew < nowSec) {
      return { ok: false, reason: 'proof_expired' };
    }

    const recoveredSigner = await recoverSigner(proof, agreementContext);
    if (!recoveredSigner) {
      return { ok: false, reason: 'invalid_signature' };
    }

    const authorizedAddress = getAddress(proof.authorizedAddress);
    if (getAddress(recoveredSigner) !== authorizedAddress) {
      return { ok: false, reason: 'signature_signer_mismatch' };
    }

    let resolvedWallet: string;
    if (agreementContext.resolveWallet) {
      resolvedWallet = await agreementContext.resolveWallet(proof.agentRegistry, proof.agentId);
    } else {
      if (!agreementContext.erc8004RpcUrl || !agreementContext.erc8004RegistryAddress) {
        return { ok: false, reason: 'resolver_not_configured' };
      }
      resolvedWallet = await resolveErc8004Wallet(proof.agentRegistry, proof.agentId, {
        rpcUrl: agreementContext.erc8004RpcUrl,
        chainId: agreementContext.erc8004ChainId,
        registryAddress: agreementContext.erc8004RegistryAddress,
      });
    }

    if (!isAddress(resolvedWallet)) {
      return { ok: false, reason: 'resolved_wallet_invalid' };
    }

    const resolvedNormalized = getAddress(resolvedWallet);
    if (resolvedNormalized !== authorizedAddress) {
      return { ok: false, reason: 'resolved_wallet_mismatch', resolvedWallet: resolvedNormalized };
    }

    return { ok: true, resolvedWallet: resolvedNormalized };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'identity_verification_error' };
  }
}
