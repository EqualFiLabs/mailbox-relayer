import { Interface, JsonRpcProvider, Wallet, formatEther, isAddress, toUtf8Bytes } from 'ethers';
import { AlertingService } from './alerting';
import { agreementIdToUint256, scaleAmountToUint256, unitTypeToBytes32 } from './conversion';
import { GasEstimator } from './gas-estimator';
import { MailboxCompat } from './mailbox';
import { NonceManager } from './nonce-manager';
import { UsageSettlementSender, UsageSettlementSenderResult } from './settlement';
import { UsageSubmissionRecord } from './store';

const COMPUTE_USAGE_IFACE = new Interface([
  'function registerUsage(uint256 agreementId, bytes32 unitType, uint256 amount)',
  'function batchRegisterUsage((uint256 agreementId, bytes32 unitType, uint256 amount)[] entries)',
]);

const MAILBOX_IFACE = new Interface([
  'function getEncPubKey(address account) view returns (bytes pubkey)',
  'function publishProviderPayload(uint256 agreementId, bytes envelope)',
]);

export interface TxSubmitterConfig {
  diamondAddress: string;
  chainId: number;
  txTimeoutMs?: number;
  maxGasPriceGwei?: number;
  lowBalanceThresholdEth?: number;
  receiptPollIntervalMs?: number;
}

export interface TransactionSubmitterStatus {
  walletAddress: string;
  walletBalance: string;
  pendingNonce: number;
  isEnabled: boolean;
}

interface LoggerLike {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}

interface SubmitCalldataResult extends UsageSettlementSenderResult {
  nonce?: number;
  gasUsed?: bigint;
}

export class TransactionSubmitter implements UsageSettlementSender {
  private readonly txTimeoutMs: number;
  private readonly maxGasPriceGwei: number;
  private readonly lowBalanceThresholdEth: number;
  private readonly receiptPollIntervalMs: number;
  private readonly maxGasPriceWei: bigint;
  private lowBalanceAlertActive = false;
  private inFlightCount = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly config: TxSubmitterConfig,
    private readonly provider: JsonRpcProvider,
    private readonly nonceManager: NonceManager,
    private readonly gasEstimator: GasEstimator,
    private readonly wallet: Wallet,
    private readonly alerting?: AlertingService,
    private readonly logger: LoggerLike = console
  ) {
    if (!isAddress(config.diamondAddress)) {
      throw new Error('invalid_diamond_address');
    }
    if (!Number.isFinite(config.chainId) || config.chainId <= 0) {
      throw new Error('invalid_chain_id');
    }

    this.txTimeoutMs = config.txTimeoutMs ?? 60_000;
    this.maxGasPriceGwei = config.maxGasPriceGwei ?? 100;
    this.lowBalanceThresholdEth = config.lowBalanceThresholdEth ?? 0.01;
    this.receiptPollIntervalMs = config.receiptPollIntervalMs ?? 250;
    this.maxGasPriceWei = BigInt(Math.floor(this.maxGasPriceGwei * 1e9));
  }

  async send(submission: UsageSubmissionRecord): Promise<UsageSettlementSenderResult> {
    return this.withInFlight(async () => {
      let agreementId: bigint;
      try {
        agreementId = agreementIdToUint256(submission.agreementId);
      } catch {
        return { status: 'error', message: 'invalid_agreement_id' };
      }

      let entries: Array<{ agreementId: bigint; unitType: string; amount: bigint }>;
      try {
        entries = submission.items.map((item) => ({
          agreementId,
          unitType: unitTypeToBytes32(item.unitType),
          amount: scaleAmountToUint256(item.amount),
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'amount_overflow') {
          return { status: 'error', message: 'amount_overflow' };
        }
        if (message === 'invalid_amount') {
          return { status: 'error', message: 'invalid_amount' };
        }
        return { status: 'error', message };
      }

      const data =
        entries.length === 1
          ? COMPUTE_USAGE_IFACE.encodeFunctionData('registerUsage', [
              entries[0].agreementId,
              entries[0].unitType,
              entries[0].amount,
            ])
          : COMPUTE_USAGE_IFACE.encodeFunctionData('batchRegisterUsage', [entries]);

      const result = await this.submitCalldata(data, submission.agreementId, submission.id);

      if (result.status === 'ok') {
        this.logger.info?.(
          {
            agreementId: submission.agreementId,
            submissionId: submission.id,
            txHash: result.txHash,
            nonce: result.nonce,
            gasUsed: result.gasUsed?.toString(),
          },
          'usage settlement tx submitted'
        );
      }

      return result;
    });
  }

  async publishProviderPayload(
    agreementId: string,
    providerCredentials: Record<string, unknown>,
    borrowerAddress: string
  ): Promise<{ txHash?: string; error?: string }> {
    return this.withInFlight(async () => {
      let agreementIdUint: bigint;
      try {
        agreementIdUint = agreementIdToUint256(agreementId);
      } catch {
        return { error: 'invalid_agreement_id' };
      }

      if (!isAddress(borrowerAddress)) {
        return { error: 'invalid_borrower_address' };
      }

      const borrowerKey = await this.getBorrowerEncryptionKey(borrowerAddress);
      if (!borrowerKey) {
        this.logger.error?.({ agreementId, borrowerAddress }, 'missing borrower encryption key');
        return { error: 'no_encryption_key' };
      }

      const envelopeString = await MailboxCompat.encryptPayload(borrowerKey, providerCredentials);
      const envelopeBytes = toUtf8Bytes(envelopeString);
      const data = MAILBOX_IFACE.encodeFunctionData('publishProviderPayload', [agreementIdUint, envelopeBytes]);

      const result = await this.submitCalldata(data, agreementId);
      if (result.status === 'ok') {
        return { txHash: result.txHash };
      }

      this.logger.error?.({ agreementId, message: result.message }, 'publishProviderPayload failed');
      await this.alerting?.emitAlert('provider_payload_publish_failed', 'error', result.message ?? 'publish_failed', {
        agreementId,
        details: {
          borrowerAddress,
        },
      });
      return { error: result.message ?? 'publish_failed' };
    });
  }

  async waitForIdle(timeoutMs = this.txTimeoutMs): Promise<void> {
    if (this.inFlightCount === 0) return;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((candidate) => candidate !== onIdle);
        reject(new Error('tx_submitter_wait_for_idle_timeout'));
      }, timeoutMs);

      const onIdle = () => {
        clearTimeout(timer);
        resolve();
      };

      this.idleWaiters.push(onIdle);
    });
  }

  async status(): Promise<TransactionSubmitterStatus> {
    const walletBalanceWei = await this.provider.getBalance(this.wallet.address);
    const walletBalance = formatEther(walletBalanceWei);
    const pendingNonce = this.safeCurrentNonce();
    const isEnabled = Boolean(this.wallet.address);

    const thresholdWei = BigInt(Math.floor(this.lowBalanceThresholdEth * 1e18));
    if (walletBalanceWei < thresholdWei) {
      if (!this.lowBalanceAlertActive) {
        this.lowBalanceAlertActive = true;
        this.logger.warn?.(
          {
            walletAddress: this.wallet.address,
            walletBalance,
            lowBalanceThresholdEth: this.lowBalanceThresholdEth,
          },
          'relayer wallet balance below threshold'
        );
        await this.alerting?.emitAlert('relayer_low_balance', 'warning', 'Relayer wallet balance below threshold', {
          details: {
            walletAddress: this.wallet.address,
            walletBalance,
            lowBalanceThresholdEth: this.lowBalanceThresholdEth,
          },
        });
      }
    } else {
      this.lowBalanceAlertActive = false;
    }

    return {
      walletAddress: this.wallet.address,
      walletBalance,
      pendingNonce,
      isEnabled,
    };
  }

  private async getBorrowerEncryptionKey(borrowerAddress: string): Promise<string | undefined> {
    try {
      const callData = MAILBOX_IFACE.encodeFunctionData('getEncPubKey', [borrowerAddress]);
      const raw = await this.provider.call({
        to: this.config.diamondAddress,
        data: callData,
      });
      const decoded = MAILBOX_IFACE.decodeFunctionResult('getEncPubKey', raw)[0];
      if (typeof decoded !== 'string') return undefined;
      return decoded === '0x' ? undefined : decoded;
    } catch {
      return undefined;
    }
  }

  private async submitCalldata(
    data: string,
    agreementId: string,
    submissionId?: string
  ): Promise<SubmitCalldataResult> {
    let gasLimit: bigint;
    try {
      gasLimit = await this.gasEstimator.estimateGas({
        to: this.config.diamondAddress,
        data,
        from: this.wallet.address,
      });
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    let feeData;
    try {
      feeData = await this.gasEstimator.getFeeData();
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (feeData.maxFeePerGas > this.maxGasPriceWei) {
      return { status: 'error', message: 'gas_price_exceeded' };
    }

    let attemptedNonceResync = false;
    for (;;) {
      const nonce = await this.nonceManager.acquireNonce();
      const txRequest = {
        to: this.config.diamondAddress,
        data,
        nonce,
        gasLimit,
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        chainId: this.config.chainId,
        type: 2,
      } as const;

      try {
        const txResponse = await this.wallet.sendTransaction(txRequest);
        const receiptResult = await this.waitForReceipt(txResponse.hash, txRequest);

        if (receiptResult.kind === 'timeout') {
          return { status: 'error', message: 'tx_timeout' };
        }

        if (receiptResult.receipt.status !== 1) {
          return {
            status: 'error',
            message: receiptResult.reason ?? 'transaction_reverted',
            txHash: txResponse.hash,
            nonce,
            gasUsed: receiptResult.receipt.gasUsed,
          };
        }

        return {
          status: 'ok',
          txHash: txResponse.hash,
          nonce,
          gasUsed: receiptResult.receipt.gasUsed,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!attemptedNonceResync && this.isNonceError(message)) {
          attemptedNonceResync = true;
          await this.nonceManager.resync();
          continue;
        }
        return { status: 'error', message };
      } finally {
        this.logger.info?.(
          {
            agreementId,
            ...(submissionId ? { submissionId } : {}),
            nonce,
          },
          'tx submission attempt completed'
        );
      }
    }
  }

  private async waitForReceipt(
    txHash: string,
    txRequest: {
      to: string;
      data: string;
      nonce: number;
      gasLimit: bigint;
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
      chainId: number;
      type: number;
    }
  ): Promise<
    | { kind: 'timeout' }
    | {
        kind: 'receipt';
        receipt: NonNullable<Awaited<ReturnType<JsonRpcProvider['getTransactionReceipt']>>>;
        reason?: string;
      }
  > {
    const deadline = Date.now() + this.txTimeoutMs;

    while (Date.now() <= deadline) {
      const receipt = await this.provider.getTransactionReceipt(txHash);
      if (receipt) {
        if (receipt.status === 1) {
          return { kind: 'receipt', receipt };
        }
        const reason = await this.decodeRevertReason(txRequest, receipt.blockNumber);
        return { kind: 'receipt', receipt, ...(reason ? { reason } : {}) };
      }
      await this.delay(this.receiptPollIntervalMs);
    }

    return { kind: 'timeout' };
  }

  private async decodeRevertReason(
    txRequest: {
      to: string;
      data: string;
      nonce: number;
      gasLimit: bigint;
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
      chainId: number;
      type: number;
    },
    blockNumber: number
  ): Promise<string | undefined> {
    try {
      await this.provider.call(
        {
          to: txRequest.to,
          data: txRequest.data,
          from: this.wallet.address,
        },
        blockNumber
      );
      return undefined;
    } catch (error) {
      if (error instanceof Error) {
        return error.message;
      }
      return String(error);
    }
  }

  private safeCurrentNonce(): number {
    try {
      return this.nonceManager.currentNonce();
    } catch {
      return 0;
    }
  }

  private isNonceError(message: string): boolean {
    return /nonce too low|replacement transaction underpriced|nonce/i.test(message.toLowerCase());
  }

  private async delay(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async withInFlight<T>(fn: () => Promise<T>): Promise<T> {
    this.inFlightCount += 1;
    try {
      return await fn();
    } finally {
      this.inFlightCount = Math.max(0, this.inFlightCount - 1);
      if (this.inFlightCount === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const waiter of waiters) {
          waiter();
        }
      }
    }
  }
}
