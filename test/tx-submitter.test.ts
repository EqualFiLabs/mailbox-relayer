import { describe, expect, it, vi } from 'vitest';
import { Interface, JsonRpcProvider, Wallet } from 'ethers';
import { MailboxCompat } from '../src/mailbox';
import { TransactionSubmitter } from '../src/tx-submitter';
import { GasEstimator } from '../src/gas-estimator';
import { NonceManager } from '../src/nonce-manager';
import { UsageSubmissionRecord } from '../src/store';
import { AlertingService } from '../src/alerting';

const COMPUTE_USAGE_IFACE = new Interface([
  'function registerUsage(uint256 agreementId, bytes32 unitType, uint256 amount)',
  'function batchRegisterUsage((uint256 agreementId, bytes32 unitType, uint256 amount)[] entries)',
]);

const MAILBOX_IFACE = new Interface([
  'function getEncPubKey(address account) view returns (bytes pubkey)',
  'function publishProviderPayload(uint256 agreementId, bytes envelope)',
]);

function makeSubmission(items: Array<{ unitType: string; amount: string }>): UsageSubmissionRecord {
  return {
    id: 'submission-1',
    agreementId: '42',
    provider: 'venice',
    from: '2026-03-13T00:00:00.000Z',
    to: '2026-03-13T00:01:00.000Z',
    usageDigest: 'digest-1',
    items,
    finalPass: false,
    createdAt: '2026-03-13T00:01:01.000Z',
  };
}

interface HarnessOptions {
  maxGasPriceGwei?: number;
  txTimeoutMs?: number;
  receiptPollIntervalMs?: number;
}

function makeHarness(options: HarnessOptions = {}) {
  const sentTxs: Array<Record<string, unknown>> = [];
  const sendQueue: Array<{ hash: string } | Error> = [];
  const receiptQueue = new Map<string, Array<Record<string, unknown> | null>>();
  const lowBalanceWei = { value: 10_000_000_000_000_000n };
  const callSpy = vi.fn();

  const provider = {
    call: vi.fn(async (request: { to: string; data: string }, blockTag?: number | string) => {
      callSpy(request, blockTag);
      const selector = request.data.slice(0, 10);
      const getEncPubKeySelector = MAILBOX_IFACE.getFunction('getEncPubKey')!.selector;
      if (selector === getEncPubKeySelector) {
        return MAILBOX_IFACE.encodeFunctionResult('getEncPubKey', ['0x']);
      }
      throw new Error('execution reverted: mocked revert reason');
    }),
    getTransactionReceipt: vi.fn(async (txHash: string) => {
      const queue = receiptQueue.get(txHash);
      if (!queue || queue.length === 0) {
        return null;
      }
      return queue.shift() ?? null;
    }),
    getBalance: vi.fn(async () => lowBalanceWei.value),
  } as unknown as JsonRpcProvider;

  const gasEstimator = {
    estimateGas: vi.fn(async () => 120_000n),
    getFeeData: vi.fn(async () => ({
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    })),
  } as unknown as GasEstimator;

  const nonceState = { value: 7 };
  const nonceManager = {
    acquireNonce: vi.fn(async () => {
      const next = nonceState.value;
      nonceState.value += 1;
      return next;
    }),
    resync: vi.fn(async () => {
      nonceState.value = 100;
    }),
    currentNonce: vi.fn(() => nonceState.value),
  } as unknown as NonceManager;

  const wallet = {
    address: '0x3333333333333333333333333333333333333333',
    sendTransaction: vi.fn(async (tx: Record<string, unknown>) => {
      sentTxs.push(tx);
      if (sendQueue.length === 0) {
        return { hash: '0xaaa' };
      }
      const next = sendQueue.shift()!;
      if (next instanceof Error) {
        throw next;
      }
      return next;
    }),
  } as unknown as Wallet;

  const alerting = {
    emitAlert: vi.fn(async () => undefined),
  } as unknown as AlertingService;

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const submitter = new TransactionSubmitter(
    {
      diamondAddress: '0x1111111111111111111111111111111111111111',
      chainId: 84532,
      txTimeoutMs: options.txTimeoutMs ?? 100,
      maxGasPriceGwei: options.maxGasPriceGwei ?? 100,
      lowBalanceThresholdEth: 0.02,
      receiptPollIntervalMs: options.receiptPollIntervalMs ?? 1,
    },
    provider,
    nonceManager,
    gasEstimator,
    wallet,
    alerting,
    logger
  );

  return {
    submitter,
    sentTxs,
    sendQueue,
    receiptQueue,
    provider,
    gasEstimator,
    nonceManager,
    wallet,
    alerting,
    logger,
    lowBalanceWei,
    callSpy,
  };
}

describe('TransactionSubmitter', () => {
  it('send() single-item dispatches registerUsage calldata', async () => {
    const h = makeHarness();
    h.receiptQueue.set('0xaaa', [{ status: 1, gasUsed: 21_000n, blockNumber: 11 }]);

    const result = await h.submitter.send(
      makeSubmission([{ unitType: 'VENICE_TEXT_TOKEN_IN', amount: '1.5' }])
    );

    expect(result.status).toBe('ok');
    expect(result.txHash).toBe('0xaaa');
    const parsed = COMPUTE_USAGE_IFACE.parseTransaction({ data: String(h.sentTxs[0].data) });
    expect(parsed?.name).toBe('registerUsage');
    expect(parsed?.args[0]).toBe(42n);
    expect(parsed?.args[2]).toBe(1_500_000_000_000_000_000n);
  });

  it('send() multi-item dispatches batchRegisterUsage calldata', async () => {
    const h = makeHarness();
    h.receiptQueue.set('0xaaa', [{ status: 1, gasUsed: 30_000n, blockNumber: 12 }]);

    const result = await h.submitter.send(
      makeSubmission([
        { unitType: 'VENICE_TEXT_TOKEN_IN', amount: '1' },
        { unitType: 'VENICE_TEXT_TOKEN_OUT', amount: '2' },
      ])
    );

    expect(result.status).toBe('ok');
    const parsed = COMPUTE_USAGE_IFACE.parseTransaction({ data: String(h.sentTxs[0].data) });
    expect(parsed?.name).toBe('batchRegisterUsage');
    expect(parsed?.args[0].length).toBe(2);
    expect(parsed?.args[0][0][0]).toBe(42n);
    expect(parsed?.args[0][1][0]).toBe(42n);
  });

  it('returns invalid_agreement_id for invalid agreement id', async () => {
    const h = makeHarness();
    const submission = makeSubmission([{ unitType: 'VENICE_TEXT_TOKEN_IN', amount: '1' }]);
    submission.agreementId = 'abc';

    const result = await h.submitter.send(submission);
    expect(result).toEqual({ status: 'error', message: 'invalid_agreement_id' });
    expect(h.wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('returns invalid_amount for zero or negative amounts', async () => {
    const h = makeHarness();
    const zero = await h.submitter.send(makeSubmission([{ unitType: 'VENICE_TEXT_TOKEN_IN', amount: '0' }]));
    expect(zero).toEqual({ status: 'error', message: 'invalid_amount' });

    const negative = await h.submitter.send(
      makeSubmission([{ unitType: 'VENICE_TEXT_TOKEN_IN', amount: '-1' }])
    );
    expect(negative).toEqual({ status: 'error', message: 'invalid_amount' });
  });

  it('returns amount_overflow for huge amount', async () => {
    const h = makeHarness();
    const overflow = await h.submitter.send(
      makeSubmission([
        {
          unitType: 'VENICE_TEXT_TOKEN_IN',
          amount:
            '999999999999999999999999999999999999999999999999999999999999999999999999999',
        },
      ])
    );
    expect(overflow).toEqual({ status: 'error', message: 'amount_overflow' });
  });

  it('returns estimateGas failure without sending tx', async () => {
    const h = makeHarness();
    (h.gasEstimator.estimateGas as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('execution reverted: credit limit exceeded')
    );

    const result = await h.submitter.send(
      makeSubmission([{ unitType: 'VENICE_TEXT_TOKEN_IN', amount: '1' }])
    );

    expect(result.status).toBe('error');
    expect(result.message).toContain('credit limit exceeded');
    expect(h.wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('returns gas_price_exceeded when fee data exceeds ceiling', async () => {
    const h = makeHarness({ maxGasPriceGwei: 100 });
    (h.gasEstimator.getFeeData as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      maxFeePerGas: 200_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });

    const result = await h.submitter.send(
      makeSubmission([{ unitType: 'VENICE_TEXT_TOKEN_IN', amount: '1' }])
    );

    expect(result).toEqual({ status: 'error', message: 'gas_price_exceeded' });
    expect(h.wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('returns error with revert reason for reverted receipt', async () => {
    const h = makeHarness();
    h.receiptQueue.set('0xaaa', [{ status: 0, gasUsed: 55_000n, blockNumber: 22 }]);

    const result = await h.submitter.send(
      makeSubmission([{ unitType: 'VENICE_TEXT_TOKEN_IN', amount: '1' }])
    );

    expect(result.status).toBe('error');
    expect(result.message).toContain('mocked revert reason');
    expect(result.txHash).toBe('0xaaa');
  });

  it('returns tx_timeout when no receipt is found in timeout window', async () => {
    const h = makeHarness({ txTimeoutMs: 5, receiptPollIntervalMs: 1 });
    const result = await h.submitter.send(
      makeSubmission([{ unitType: 'VENICE_TEXT_TOKEN_IN', amount: '1' }])
    );

    expect(result).toEqual({ status: 'error', message: 'tx_timeout' });
  });

  it('resyncs nonce and retries once on nonce-related send error', async () => {
    const h = makeHarness();
    h.sendQueue.push(new Error('nonce too low'), { hash: '0xretry' });
    h.receiptQueue.set('0xretry', [{ status: 1, gasUsed: 21_100n, blockNumber: 31 }]);

    const result = await h.submitter.send(
      makeSubmission([{ unitType: 'VENICE_TEXT_TOKEN_IN', amount: '1' }])
    );

    expect(result.status).toBe('ok');
    expect(result.txHash).toBe('0xretry');
    expect(h.nonceManager.resync).toHaveBeenCalledTimes(1);
    expect(h.wallet.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it('publishProviderPayload returns no_encryption_key when borrower key is missing', async () => {
    const h = makeHarness();

    const result = await h.submitter.publishProviderPayload(
      '42',
      { provider: 'venice', apiKey: 'k1' },
      '0x4444444444444444444444444444444444444444'
    );

    expect(result).toEqual({ error: 'no_encryption_key' });
    expect(h.wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('publishProviderPayload encrypts and submits with valid borrower key', async () => {
    const h = makeHarness();
    const keys = MailboxCompat.generateKeys();
    (h.provider.call as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (request: { data: string }, blockTag?: number | string) => {
        const selector = request.data.slice(0, 10);
        const getEncPubKeySelector = MAILBOX_IFACE.getFunction('getEncPubKey')!.selector;
        if (selector === getEncPubKeySelector) {
          return MAILBOX_IFACE.encodeFunctionResult('getEncPubKey', [keys.compressedPublicKey]);
        }
        throw new Error(`execution reverted (block ${String(blockTag)})`);
      }
    );
    h.receiptQueue.set('0xaaa', [{ status: 1, gasUsed: 40_000n, blockNumber: 40 }]);

    const result = await h.submitter.publishProviderPayload(
      '42',
      { provider: 'venice', apiKey: 'secret-key' },
      '0x4444444444444444444444444444444444444444'
    );

    expect(result).toEqual({ txHash: '0xaaa' });
    const parsed = MAILBOX_IFACE.parseTransaction({ data: String(h.sentTxs[0].data) });
    expect(parsed?.name).toBe('publishProviderPayload');

    const envelopeHex = String(parsed?.args[1]);
    const envelopeString = Buffer.from(envelopeHex.slice(2), 'hex').toString('utf8');
    const decrypted = await MailboxCompat.decryptPayload(keys.privateKey, envelopeString);
    expect(JSON.parse(decrypted)).toEqual({ provider: 'venice', apiKey: 'secret-key' });
  });

  it('publishProviderPayload handles Bankr/Lambda/RunPod provider credentials', async () => {
    const h = makeHarness();
    const keys = MailboxCompat.generateKeys();
    (h.provider.call as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      MAILBOX_IFACE.encodeFunctionResult('getEncPubKey', [keys.compressedPublicKey])
    );

    const providers = ['bankr', 'lambda', 'runpod'];
    for (const providerName of providers) {
      h.sentTxs.length = 0;
      h.receiptQueue.set('0xaaa', [{ status: 1, gasUsed: 41_000n, blockNumber: 41 }]);

      const result = await h.submitter.publishProviderPayload(
        '42',
        { provider: providerName, token: `${providerName}-token` },
        '0x4444444444444444444444444444444444444444'
      );

      expect(result.txHash).toBe('0xaaa');
      const parsed = MAILBOX_IFACE.parseTransaction({ data: String(h.sentTxs[0].data) });
      const envelopeHex = String(parsed?.args[1]);
      const envelopeString = Buffer.from(envelopeHex.slice(2), 'hex').toString('utf8');
      const decrypted = await MailboxCompat.decryptPayload(keys.privateKey, envelopeString);
      expect(JSON.parse(decrypted).provider).toBe(providerName);
    }
  });

  it('status() fires low balance alert once per low-balance episode', async () => {
    const h = makeHarness();
    h.lowBalanceWei.value = 1_000_000_000_000_000n; // 0.001 ETH

    const first = await h.submitter.status();
    const second = await h.submitter.status();

    expect(first.walletAddress).toBe('0x3333333333333333333333333333333333333333');
    expect(first.pendingNonce).toBe(7);
    expect(first.isEnabled).toBe(true);
    expect(second.walletBalance).toBe('0.001');
    expect(h.alerting.emitAlert).toHaveBeenCalledTimes(1);
  });

  it('waitForIdle() waits until in-flight transaction submission completes', async () => {
    const h = makeHarness({ txTimeoutMs: 100, receiptPollIntervalMs: 1 });
    h.receiptQueue.set('0xaaa', [null, { status: 1, gasUsed: 21_000n, blockNumber: 99 }]);

    const sendPromise = h.submitter.send(
      makeSubmission([{ unitType: 'VENICE_TEXT_TOKEN_IN', amount: '1' }])
    );

    await h.submitter.waitForIdle(1000);

    const sendResult = await sendPromise;
    expect(sendResult.status).toBe('ok');
    expect(sendResult.txHash).toBe('0xaaa');
  });
});
