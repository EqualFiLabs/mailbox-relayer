import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Interface } from 'ethers';
import { InMemoryMessageStore } from '../src/store';
import { InterestAccrualScheduler, InterestAccrualService } from '../src/interest-accrual';

const AGREEMENT_IFACE = new Interface([
  'function getAgreement(uint256 agreementId) view returns (uint256 id,uint256 proposalId,string agentRegistry,uint256 agentId,uint256 lenderPositionId,bytes32 lenderPositionKey,address settlementAsset,uint8 mode,uint8 status,uint256 creditLimit,uint256 unitLimit,uint256 principalDrawn,uint256 principalRepaid,uint256 interestAccrued,uint256 feesAccrued,uint256 principalEncumbered,uint256 unitsEncumbered,address borrower,address lender,bytes32 providerId)',
]);

const INTEREST_IFACE = new Interface([
  'function getInterestConfig(uint256 agreementId) view returns (uint16 annualRateBps,uint16 originationFeeBps,uint16 serviceFeeBps,uint16 lateFeeBps,uint40 lastAccrualAt)',
  'function accrueInterest(uint256 agreementId)',
]);

const ZERO_BYTES32 = `0x${'00'.repeat(32)}`;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const TEST_ADDRESS = `0x${'11'.repeat(20)}`;

describe('InterestAccrualService', () => {
  const agreementSelector = AGREEMENT_IFACE.getFunction('getAgreement')!.selector;
  const configSelector = INTEREST_IFACE.getFunction('getInterestConfig')!.selector;

  let store: InMemoryMessageStore;
  let provider: any;
  let signer: any;

  beforeEach(() => {
    store = new InMemoryMessageStore();
    provider = {
      getBlock: vi.fn(async () => ({ timestamp: 2_000_000 })),
      call: vi.fn(),
    };
    signer = {
      sendTransaction: vi.fn(async () => ({
        hash: '0xtx-hash',
        wait: async () => ({ status: 1 }),
      })),
    };
  });

  it('accrues interest only for due active agreements with outstanding principal', async () => {
    store.setAgreementState({
      agreementId: '1',
      state: 'active',
      updatedAt: '2026-03-14T00:00:00.000Z',
    });
    store.setAgreementState({
      agreementId: '2',
      state: 'active',
      updatedAt: '2026-03-14T00:00:01.000Z',
    });
    store.setAgreementState({
      agreementId: '3',
      state: 'active',
      updatedAt: '2026-03-14T00:00:02.000Z',
    });

    provider.call.mockImplementation(async (tx: { data: string }) => {
      const selector = tx.data.slice(0, 10);

      if (selector === agreementSelector) {
        const decoded = AGREEMENT_IFACE.decodeFunctionData('getAgreement', tx.data);
        const agreementId = decoded.agreementId as bigint;

        if (agreementId === 1n) {
          return AGREEMENT_IFACE.encodeFunctionResult('getAgreement', [
            1n,
            1n,
            'erc8004:base:registry',
            1n,
            1n,
            ZERO_BYTES32,
            TEST_ADDRESS,
            0n,
            0n,
            1_000n,
            0n,
            500n,
            0n,
            0n,
            0n,
            0n,
            0n,
            TEST_ADDRESS,
            TEST_ADDRESS,
            ZERO_BYTES32,
          ]);
        }

        if (agreementId === 2n) {
          return AGREEMENT_IFACE.encodeFunctionResult('getAgreement', [
            2n,
            2n,
            'erc8004:base:registry',
            1n,
            1n,
            ZERO_BYTES32,
            TEST_ADDRESS,
            0n,
            0n,
            1_000n,
            0n,
            0n,
            0n,
            0n,
            0n,
            0n,
            0n,
            TEST_ADDRESS,
            TEST_ADDRESS,
            ZERO_BYTES32,
          ]);
        }

        return AGREEMENT_IFACE.encodeFunctionResult('getAgreement', [
          3n,
          3n,
          'erc8004:base:registry',
          1n,
          1n,
          ZERO_BYTES32,
          TEST_ADDRESS,
          0n,
          0n,
          1_000n,
          0n,
          500n,
          0n,
          0n,
          0n,
          0n,
          0n,
          TEST_ADDRESS,
          TEST_ADDRESS,
          ZERO_BYTES32,
        ]);
      }

      if (selector === configSelector) {
        const decoded = INTEREST_IFACE.decodeFunctionData('getInterestConfig', tx.data);
        const agreementId = decoded.agreementId as bigint;

        if (agreementId === 1n) {
          return INTEREST_IFACE.encodeFunctionResult('getInterestConfig', [1000n, 0n, 0n, 0n, 1_000_000n]);
        }
        if (agreementId === 2n) {
          return INTEREST_IFACE.encodeFunctionResult('getInterestConfig', [1000n, 0n, 0n, 0n, 1_000_000n]);
        }

        return INTEREST_IFACE.encodeFunctionResult('getInterestConfig', [1000n, 0n, 0n, 0n, 1_999_500n]);
      }

      throw new Error('unexpected_call');
    });

    const service = new InterestAccrualService(
      store,
      provider as never,
      signer as never,
      TEST_ADDRESS,
      { accrualThresholdSeconds: 3600 }
    );

    const result = await service.run();

    expect(result.processed).toBe(3);
    expect(result.accrued).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.results.find((r) => r.agreementId === '1')?.status).toBe('accrued');
    expect(result.results.find((r) => r.agreementId === '2')?.reason).toBe('no_principal_outstanding');
    expect(result.results.find((r) => r.agreementId === '3')?.reason).toBe('below_threshold');
    expect(signer.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('retries naturally on next cycle after a failed transaction', async () => {
    store.setAgreementState({
      agreementId: '10',
      state: 'active',
      updatedAt: '2026-03-14T00:00:00.000Z',
    });

    provider.call.mockImplementation(async (tx: { data: string }) => {
      const selector = tx.data.slice(0, 10);
      if (selector === agreementSelector) {
        return AGREEMENT_IFACE.encodeFunctionResult('getAgreement', [
          10n,
          10n,
          'erc8004:base:registry',
          1n,
          1n,
          ZERO_BYTES32,
          TEST_ADDRESS,
          0n,
          0n,
          1_000n,
          0n,
          500n,
          0n,
          0n,
          0n,
          0n,
          0n,
          TEST_ADDRESS,
          TEST_ADDRESS,
          ZERO_BYTES32,
        ]);
      }

      return INTEREST_IFACE.encodeFunctionResult('getInterestConfig', [1000n, 0n, 0n, 0n, 1_000_000n]);
    });

    let attempts = 0;
    signer.sendTransaction.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('rpc timeout');
      }
      return {
        hash: '0xtx-second',
        wait: async () => ({ status: 1 }),
      };
    });

    const service = new InterestAccrualService(store, provider as never, signer as never, TEST_ADDRESS);

    const first = await service.run();
    expect(first.failed).toBe(1);
    expect(first.accrued).toBe(0);

    const second = await service.run();
    expect(second.failed).toBe(0);
    expect(second.accrued).toBe(1);
    expect(signer.sendTransaction).toHaveBeenCalledTimes(2);
  });
});

describe('InterestAccrualScheduler', () => {
  it('starts once, runs periodically, and reports status', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({
      processed: 0,
      accrued: 0,
      skipped: 0,
      failed: 0,
      results: [],
    }));
    const scheduler = new InterestAccrualScheduler({ run } as unknown as InterestAccrualService, 1000);

    expect(scheduler.start()).toBe(true);
    expect(scheduler.start()).toBe(false);
    expect(scheduler.status().enabled).toBe(true);

    await vi.advanceTimersByTimeAsync(1005);
    expect(run).toHaveBeenCalledTimes(1);

    expect(scheduler.stop()).toBe(true);
    expect(scheduler.stop()).toBe(false);
    expect(scheduler.status().enabled).toBe(false);

    vi.useRealTimers();
  });
});
