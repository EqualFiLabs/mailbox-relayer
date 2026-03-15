import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Interface } from 'ethers';
import { DelinquencyMonitor } from '../src/schedulers/DelinquencyMonitor';

const AGREEMENT_IFACE = new Interface([
  'function getAgreementsByStatus(uint8 status) view returns (uint256[] agreementIds)',
]);

const RISK_IFACE = new Interface([
  'function detectDelinquency(uint256 agreementId)',
  'function triggerDefault(uint256 agreementId)',
]);

const AGREEMENT_ADDRESS = `0x${'11'.repeat(20)}`;
const RISK_ADDRESS = `0x${'22'.repeat(20)}`;

type MonitorHarness = {
  monitor: DelinquencyMonitor;
  provider: any;
  signer: any;
  onError: any;
};

function encodeAgreementIds(ids: bigint[]): string {
  return AGREEMENT_IFACE.encodeFunctionResult('getAgreementsByStatus', [ids]);
}

function decodeRiskTx(data: string): { fn: 'detectDelinquency' | 'triggerDefault'; agreementId: bigint } {
  const selector = data.slice(0, 10);
  const detectSelector = RISK_IFACE.getFunction('detectDelinquency')!.selector;
  if (selector === detectSelector) {
    const decoded = RISK_IFACE.decodeFunctionData('detectDelinquency', data);
    return { fn: 'detectDelinquency', agreementId: BigInt(decoded.agreementId) };
  }

  const decoded = RISK_IFACE.decodeFunctionData('triggerDefault', data);
  return { fn: 'triggerDefault', agreementId: BigInt(decoded.agreementId) };
}

function createHarness(intervalMs = 900_000): MonitorHarness {
  const provider = {
    call: vi.fn(async ({ data }: { data: string }) => {
      const decoded = AGREEMENT_IFACE.decodeFunctionData('getAgreementsByStatus', data);
      const status = Number(decoded.status);
      if (status === 0) return encodeAgreementIds([]);
      if (status === 2) return encodeAgreementIds([]);
      throw new Error('unexpected_status');
    }),
  };

  const signer = {
    sendTransaction: vi.fn(async () => ({
      hash: '0xtx',
      wait: async () => ({ status: 1 }),
    })),
  };

  const onError = vi.fn();
  const monitor = new DelinquencyMonitor(
    provider as never,
    signer as never,
    RISK_ADDRESS,
    AGREEMENT_ADDRESS,
    intervalMs,
    onError
  );

  return { monitor, provider, signer, onError };
}

describe('DelinquencyMonitor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('supports start/stop lifecycle and configurable interval', async () => {
    vi.useFakeTimers();
    const { monitor, provider } = createHarness(1_234);

    expect(monitor.start()).toBe(true);
    expect(monitor.start()).toBe(false);
    expect(monitor.status()).toEqual({ enabled: true, running: false, intervalMs: 1_234 });

    await vi.advanceTimersByTimeAsync(1_235);
    expect(provider.call).toHaveBeenCalledTimes(2);

    expect(monitor.stop()).toBe(true);
    expect(monitor.stop()).toBe(false);
    expect(monitor.status()).toEqual({ enabled: false, running: false, intervalMs: 1_234 });

    vi.useRealTimers();
  });

  it('calls detectDelinquency for all Active agreements in detection phase', async () => {
    const { monitor, provider, signer } = createHarness();

    provider.call.mockImplementation(async ({ data }: { data: string }) => {
      const decoded = AGREEMENT_IFACE.decodeFunctionData('getAgreementsByStatus', data);
      const status = Number(decoded.status);
      if (status === 0) return encodeAgreementIds([1n, 2n, 3n]);
      if (status === 2) return encodeAgreementIds([]);
      throw new Error('unexpected_status');
    });

    await monitor.runCycle();

    const calls = signer.sendTransaction.mock.calls.map((args) => decodeRiskTx(args[0].data));
    expect(calls).toEqual([
      { fn: 'detectDelinquency', agreementId: 1n },
      { fn: 'detectDelinquency', agreementId: 2n },
      { fn: 'detectDelinquency', agreementId: 3n },
    ]);
  });

  it('calls triggerDefault for all Delinquent agreements in default phase', async () => {
    const { monitor, provider, signer } = createHarness();

    provider.call.mockImplementation(async ({ data }: { data: string }) => {
      const decoded = AGREEMENT_IFACE.decodeFunctionData('getAgreementsByStatus', data);
      const status = Number(decoded.status);
      if (status === 0) return encodeAgreementIds([]);
      if (status === 2) return encodeAgreementIds([7n, 8n]);
      throw new Error('unexpected_status');
    });

    await monitor.runCycle();

    const calls = signer.sendTransaction.mock.calls.map((args) => decodeRiskTx(args[0].data));
    expect(calls).toEqual([
      { fn: 'triggerDefault', agreementId: 7n },
      { fn: 'triggerDefault', agreementId: 8n },
    ]);
  });

  it('isRunning guard prevents concurrent cycle overlap', async () => {
    const { monitor, provider, signer } = createHarness();

    let releaseActiveQuery: (() => void) | undefined;
    provider.call.mockImplementation(async ({ data }: { data: string }) => {
      const decoded = AGREEMENT_IFACE.decodeFunctionData('getAgreementsByStatus', data);
      const status = Number(decoded.status);

      if (status === 0) {
        await new Promise<void>((resolve) => {
          releaseActiveQuery = resolve;
        });
        return encodeAgreementIds([1n]);
      }
      if (status === 2) return encodeAgreementIds([]);
      throw new Error('unexpected_status');
    });

    const first = monitor.runCycle();
    await Promise.resolve();
    const second = monitor.runCycle();
    await Promise.resolve();

    expect(monitor.status().running).toBe(true);
    expect(provider.call).toHaveBeenCalledTimes(1);

    releaseActiveQuery?.();
    await first;
    await second;

    expect(monitor.status().running).toBe(false);
    expect(provider.call).toHaveBeenCalledTimes(2);
    expect(signer.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('logs failed txs, skips expected custom errors, and continues next cycle', async () => {
    const { monitor, provider, signer, onError } = createHarness();

    provider.call.mockImplementation(async ({ data }: { data: string }) => {
      const decoded = AGREEMENT_IFACE.decodeFunctionData('getAgreementsByStatus', data);
      const status = Number(decoded.status);
      if (status === 0) return encodeAgreementIds([1n, 2n, 3n]);
      if (status === 2) return encodeAgreementIds([5n]);
      throw new Error('unexpected_status');
    });

    signer.sendTransaction.mockImplementation(async ({ data }: { data: string }) => {
      const call = decodeRiskTx(data);
      if (call.fn === 'detectDelinquency' && call.agreementId === 1n) {
        throw new Error('rpc_timeout');
      }
      if (call.fn === 'detectDelinquency' && call.agreementId === 2n) {
        throw new Error('NotDelinquent');
      }
      if (call.fn === 'triggerDefault' && call.agreementId === 5n) {
        throw new Error('CurePeriodNotExpired');
      }
      return {
        hash: '0xok',
        wait: async () => ({ status: 1 }),
      };
    });

    await monitor.runCycle();
    await monitor.runCycle();

    expect(signer.sendTransaction).toHaveBeenCalledTimes(8);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(monitor.status().running).toBe(false);
  });
});
