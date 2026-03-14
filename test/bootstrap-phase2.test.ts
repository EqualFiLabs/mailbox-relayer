import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapPhase2 } from '../src/bootstrap-phase2';
import { InMemoryMessageStore } from '../src/store';
import { ComputeAdapterRegistry } from '../src/providers';

const ORIGINAL_ENV = { ...process.env };

function setPhase2Env() {
  process.env.RPC_URL = 'https://example-rpc.local';
  process.env.DIAMOND_ADDRESS = '0x1111111111111111111111111111111111111111';
  process.env.CHAIN_ID = '84532';
  process.env.RELAYER_PRIVATE_KEY = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  process.env.RELAYER_ENCRYPTION_PRIVATE_KEY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  process.env.PROVIDER_EVENT_AUTH_TOKEN = 'provider-event-token-123456';
  process.env.EVENT_LISTENER_START_BLOCK = '0';
  process.env.CONFIRMATION_DEPTH = '2';
  process.env.EVENT_POLL_INTERVAL_MS = '1000';
  process.env.TX_TIMEOUT_MS = '30000';
  process.env.GAS_LIMIT_MULTIPLIER = '1.2';
  process.env.MAX_GAS_PRICE_GWEI = '90';
  process.env.LOW_BALANCE_THRESHOLD_ETH = '0.01';
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('bootstrapPhase2', () => {
  it('creates phase2 components and wires tx submitter + event listener + ingress', async () => {
    setPhase2Env();

    const providerStub = {
      getTransactionCount: async () => 7,
      estimateGas: async () => 100_000n,
      getFeeData: async () => ({
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        gasPrice: 2_000_000_000n,
      }),
      call: async () => '0x',
      getBalance: async () => 1_000_000_000_000_000_000n,
      getTransactionReceipt: async () => null,
      getNetwork: async () => ({ chainId: 84532n }),
      getBlockNumber: async () => 0,
      getLogs: async () => [],
      getBlock: async () => ({ hash: '0xabc' }),
    } as any;

    const walletStub = {
      address: '0x9999999999999999999999999999999999999999',
      sendTransaction: async () => ({ hash: '0xabc' }),
    } as any;

    const store = new InMemoryMessageStore();
    const providerRegistry = new ComputeAdapterRegistry();

    const result = await bootstrapPhase2({
      store,
      providerRegistry,
      providerFactory: () => providerStub,
      walletFactory: () => walletStub,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    expect(result.store).toBe(store);
    expect(result.providerRegistry).toBe(providerRegistry);
    expect(result.txSubmitter).toBeDefined();
    expect(result.eventListener).toBeDefined();
    expect(result.providerEventIngress.status().enabled).toBe(true);
    expect(result.usageSettlementService).toBeDefined();
  });
});
