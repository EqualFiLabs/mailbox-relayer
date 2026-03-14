import { Contract, JsonRpcProvider, id, isAddress } from 'ethers';
import { ComputeProvider } from './providers';

const AGREEMENT_VIEW_ABI = [
  'function getAgreement(uint256 agreementId) view returns (tuple(uint256 id,uint256 proposalId,string agentRegistry,uint256 agentId,uint256 lenderPositionId,bytes32 lenderPositionKey,address settlementAsset,uint8 mode,uint8 status,uint256 creditLimit,uint256 unitLimit,uint256 principalDrawn,uint256 principalRepaid,uint256 interestAccrued,uint256 feesAccrued,uint256 principalEncumbered,uint256 unitsEncumbered,address borrower,address lender,bytes32 providerId) agreement)',
] as const;

const PROVIDER_ID_MAP = new Map<string, ComputeProvider>([
  [id('venice').toLowerCase(), 'venice'],
  [id('bankr').toLowerCase(), 'bankr'],
  [id('lambda').toLowerCase(), 'lambda'],
  [id('runpod').toLowerCase(), 'runpod'],
]);

export interface ActivationContext {
  provider?: ComputeProvider;
  borrowerAddress?: string;
  providerId?: string;
}

export interface ActivationContextResolver {
  resolveActivationContext(agreementId: string): Promise<ActivationContext>;
}

function parseAgreementId(agreementId: string): bigint {
  if (!/^\d+$/.test(agreementId)) {
    throw new Error('invalid_agreement_id');
  }
  return BigInt(agreementId);
}

function normalizeBytes32(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) return undefined;
  return value.toLowerCase();
}

function normalizeAddress(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return isAddress(value) ? value : undefined;
}

export class OnchainActivationContextResolver implements ActivationContextResolver {
  private readonly agreementFacet: Contract;

  constructor(
    private readonly provider: JsonRpcProvider,
    diamondAddress: string
  ) {
    if (!isAddress(diamondAddress)) {
      throw new Error('invalid_diamond_address');
    }
    this.agreementFacet = new Contract(diamondAddress, AGREEMENT_VIEW_ABI, provider);
  }

  async resolveActivationContext(agreementId: string): Promise<ActivationContext> {
    const agreementIdUint = parseAgreementId(agreementId);
    const agreement = await this.agreementFacet.getAgreement(agreementIdUint);

    const record = agreement as unknown as Record<string, unknown>;
    const providerId = normalizeBytes32(record.providerId);
    const borrowerAddress = normalizeAddress(record.borrower);
    const provider = providerId ? PROVIDER_ID_MAP.get(providerId) : undefined;

    return {
      ...(provider ? { provider } : {}),
      ...(borrowerAddress ? { borrowerAddress } : {}),
      ...(providerId ? { providerId } : {}),
    };
  }
}
