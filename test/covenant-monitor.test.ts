import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Interface } from 'ethers';
import { InMemoryMessageStore } from '../src/store';
import { CovenantMonitorScheduler, CovenantMonitorService } from '../src/covenant-monitor';

const COVENANT_IFACE = new Interface([
  'function checkCovenant(uint256 agreementId,uint256 periodId) view returns (bool breached,uint256 requiredPayment,uint256 actualPayment,uint256 netDraw)',
  'function detectBreach(uint256 agreementId)',
  'function terminateForBreach(uint256 agreementId)',
]);

const TEST_ADDRESS = `0x${'11'.repeat(20)}`;

describe('CovenantMonitorService', () => {
  const checkSelector = COVENANT_IFACE.getFunction('checkCovenant')!.selector;
  const detectSelector = COVENANT_IFACE.getFunction('detectBreach')!.selector;
  const terminateSelector = COVENANT_IFACE.getFunction('terminateForBreach')!.selector;

  let store: InMemoryMessageStore;
  let provider: any;
  let signer: any;

  beforeEach(() => {
    store = new InMemoryMessageStore();
    provider = {
      call: vi.fn(),
    };
    signer = {
      getAddress: vi.fn(async () => TEST_ADDRESS),
      sendTransaction: vi.fn(async () => ({
        hash: '0xtx-default',
        wait: async () => ({ status: 1 }),
      })),
    };
  });

  it('detects breach and submits detectBreach when covenant is breached', async () => {
    store.setAgreementState({
      agreementId: '1',
      state: 'active',
      updatedAt: '2026-03-14T00:00:00.000Z',
    });

    provider.call.mockImplementation(async (tx: { data: string }) => {
      const selector = tx.data.slice(0, 10);
      if (selector === checkSelector) {
        return COVENANT_IFACE.encodeFunctionResult('checkCovenant', [true, 1000n, 100n, 900n]);
      }
      if (selector === terminateSelector) {
        throw new Error('CurePeriodNotExpired');
      }
      throw new Error('unexpected_call');
    });

    signer.sendTransaction.mockImplementation(async (tx: { data: string }) => {
      const selector = tx.data.slice(0, 10);
      if (selector === detectSelector) {
        return { hash: '0xdetect', wait: async () => ({ status: 1 }) };
      }
      throw new Error('unexpected_tx');
    });

    const service = new CovenantMonitorService(store, provider, signer, TEST_ADDRESS);
    const result = await service.run();

    expect(result.processed).toBe(1);
    expect(result.breached).toBe(1);
    expect(result.detected).toBe(1);
    expect(result.terminated).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results[0]?.status).toBe('detected');
    expect(result.results[0]?.detectTxHash).toBe('0xdetect');
    expect(signer.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('submits terminateForBreach when cure-period policy window has elapsed', async () => {
    store.setAgreementState({
      agreementId: '9',
      state: 'active',
      updatedAt: '2026-03-14T00:00:00.000Z',
    });

    provider.call.mockImplementation(async (tx: { data: string }) => {
      const selector = tx.data.slice(0, 10);
      if (selector === checkSelector) {
        return COVENANT_IFACE.encodeFunctionResult('checkCovenant', [true, 1000n, 100n, 900n]);
      }
      if (selector === terminateSelector) {
        return '0x';
      }
      throw new Error('unexpected_call');
    });

    let txCount = 0;
    signer.sendTransaction.mockImplementation(async (tx: { data: string }) => {
      txCount += 1;
      const selector = tx.data.slice(0, 10);
      if (txCount === 1) {
        expect(selector).toBe(detectSelector);
        return { hash: '0xdetect-9', wait: async () => ({ status: 1 }) };
      }
      expect(selector).toBe(terminateSelector);
      return { hash: '0xterminate-9', wait: async () => ({ status: 1 }) };
    });

    const service = new CovenantMonitorService(store, provider, signer, TEST_ADDRESS);
    const result = await service.run();

    expect(result.processed).toBe(1);
    expect(result.breached).toBe(1);
    expect(result.detected).toBe(1);
    expect(result.terminated).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.results[0]?.status).toBe('terminated');
    expect(result.results[0]?.detectTxHash).toBe('0xdetect-9');
    expect(result.results[0]?.terminateTxHash).toBe('0xterminate-9');
    expect(signer.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it('retries failed onchain submissions on subsequent cycles', async () => {
    store.setAgreementState({
      agreementId: '10',
      state: 'active',
      updatedAt: '2026-03-14T00:00:00.000Z',
    });

    provider.call.mockImplementation(async (tx: { data: string }) => {
      const selector = tx.data.slice(0, 10);
      if (selector === checkSelector) {
        return COVENANT_IFACE.encodeFunctionResult('checkCovenant', [true, 1000n, 100n, 900n]);
      }
      if (selector === terminateSelector) {
        throw new Error('CurePeriodNotExpired');
      }
      throw new Error('unexpected_call');
    });

    let attempts = 0;
    signer.sendTransaction.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('rpc timeout');
      }
      return { hash: '0xdetect-retry', wait: async () => ({ status: 1 }) };
    });

    const service = new CovenantMonitorService(store, provider, signer, TEST_ADDRESS);

    const first = await service.run();
    expect(first.failed).toBe(1);
    expect(first.detected).toBe(0);

    const second = await service.run();
    expect(second.failed).toBe(0);
    expect(second.detected).toBe(1);
    expect(second.results[0]?.status).toBe('detected');
    expect(signer.sendTransaction).toHaveBeenCalledTimes(2);
  });
});

describe('CovenantMonitorScheduler', () => {
  it('starts once, runs periodically, and reports status', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({
      processed: 0,
      breached: 0,
      detected: 0,
      terminated: 0,
      skipped: 0,
      failed: 0,
      results: [],
    }));
    const scheduler = new CovenantMonitorScheduler({ run } as unknown as CovenantMonitorService, 1000);

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
