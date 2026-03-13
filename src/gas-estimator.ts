import { JsonRpcProvider, TransactionRequest } from 'ethers';

export interface Eip1559FeeData {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export class GasEstimator {
  private readonly maxGasPriceWei: bigint;

  constructor(
    private readonly provider: JsonRpcProvider,
    private readonly gasLimitMultiplier = 1.2,
    private readonly maxGasPriceGwei = 100
  ) {
    if (!Number.isFinite(gasLimitMultiplier) || gasLimitMultiplier <= 0) {
      throw new Error('invalid_gas_limit_multiplier');
    }
    if (!Number.isFinite(maxGasPriceGwei) || maxGasPriceGwei <= 0) {
      throw new Error('invalid_max_gas_price_gwei');
    }

    this.maxGasPriceWei = BigInt(Math.floor(maxGasPriceGwei * 1e9));
  }

  async estimateGas(tx: TransactionRequest): Promise<bigint> {
    try {
      const estimate = await this.provider.estimateGas(tx);
      const multiplied = Math.ceil(Number(estimate) * this.gasLimitMultiplier);
      return BigInt(multiplied);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`gas_estimate_failed: ${message}`);
    }
  }

  async getFeeData(): Promise<Eip1559FeeData> {
    const feeData = await this.provider.getFeeData();
    const rawMaxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;

    if (rawMaxFeePerGas === null) {
      throw new Error('fee_data_missing_max_fee_per_gas');
    }

    const cappedMaxFeePerGas = rawMaxFeePerGas > this.maxGasPriceWei ? this.maxGasPriceWei : rawMaxFeePerGas;
    const rawPriority = feeData.maxPriorityFeePerGas ?? 0n;
    const maxPriorityFeePerGas = rawPriority > cappedMaxFeePerGas ? cappedMaxFeePerGas : rawPriority;

    return {
      maxFeePerGas: cappedMaxFeePerGas,
      maxPriorityFeePerGas,
    };
  }
}
