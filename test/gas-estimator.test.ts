import { describe, expect, it } from 'vitest';
import { JsonRpcProvider, TransactionRequest } from 'ethers';
import { GasEstimator } from '../src/gas-estimator';

interface MockFeeData {
  gasPrice: bigint | null;
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
}

function makeMockProvider(opts: { estimateGasResult?: bigint; estimateGasError?: Error; feeData?: MockFeeData }) {
  const provider = {
    async estimateGas(_tx: TransactionRequest) {
      if (opts.estimateGasError) {
        throw opts.estimateGasError;
      }
      return opts.estimateGasResult ?? 0n;
    },
    async getFeeData() {
      return (
        opts.feeData ?? {
          gasPrice: 1_000_000_000n,
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        }
      );
    },
  } as unknown as JsonRpcProvider;

  return provider;
}

describe('GasEstimator', () => {
  it('applies gas limit multiplier with ceil semantics', async () => {
    const provider = makeMockProvider({ estimateGasResult: 100_001n });
    const estimator = new GasEstimator(provider, 1.2, 100);

    const gasLimit = await estimator.estimateGas({
      to: '0x1111111111111111111111111111111111111111',
      data: '0x',
      from: '0x2222222222222222222222222222222222222222',
    });

    expect(gasLimit).toBe(120_002n);
  });

  it('caps maxFeePerGas at configured gas price ceiling', async () => {
    const provider = makeMockProvider({
      feeData: {
        gasPrice: 80_000_000_000n,
        maxFeePerGas: 200_000_000_000n,
        maxPriorityFeePerGas: 5_000_000_000n,
      },
    });
    const estimator = new GasEstimator(provider, 1.2, 100);

    const feeData = await estimator.getFeeData();

    expect(feeData.maxFeePerGas).toBe(100_000_000_000n);
    expect(feeData.maxPriorityFeePerGas).toBe(5_000_000_000n);
  });

  it('re-throws estimateGas failures with descriptive message', async () => {
    const provider = makeMockProvider({
      estimateGasError: new Error('execution reverted: credit limit exceeded'),
    });
    const estimator = new GasEstimator(provider, 1.2, 100);

    await expect(
      estimator.estimateGas({
        to: '0x1111111111111111111111111111111111111111',
        data: '0x',
        from: '0x2222222222222222222222222222222222222222',
      })
    ).rejects.toThrow('gas_estimate_failed: execution reverted: credit limit exceeded');
  });
});
