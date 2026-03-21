/**
 * Proof-of-settlement script: uses the relayer's TransactionSubmitter
 * to submit real registerUsage() transactions to Anvil.
 *
 * Prerequisites:
 *   - Anvil running at http://127.0.0.1:8545
 *   - Diamond deployed with active agreements (100 for Venice, 101 for Bankr)
 *   - Relayer role granted to 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
 *   - Compute unit configs set (VENICE_TEXT_TOKEN_IN, BANKR_TEXT_TOKEN_IN)
 */

import { JsonRpcProvider, Wallet } from 'ethers';
import { NonceManager } from '../src/nonce-manager';
import { GasEstimator } from '../src/gas-estimator';
import { TransactionSubmitter } from '../src/tx-submitter';
import type { UsageSubmissionRecord } from '../src/store';

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853';
const PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

async function main() {
  const provider = new JsonRpcProvider(RPC_URL);
  const wallet = new Wallet(PRIVATE_KEY, provider);
  const nonceManager = new NonceManager(provider, wallet.address);
  await nonceManager.init();
  const gasEstimator = new GasEstimator(provider);

  const txSubmitter = new TransactionSubmitter(
    {
      diamondAddress: DIAMOND_ADDRESS,
      chainId: 31337,
      txTimeoutMs: 30_000,
      maxGasPriceGwei: 100,
      lowBalanceThresholdEth: 0.01,
      receiptPollIntervalMs: 250,
    },
    provider,
    nonceManager,
    gasEstimator,
    wallet,
    undefined,
    console
  );

  const results: Record<string, unknown>[] = [];

  // Venice settlement: submit registerUsage for agreement 100
  const veniceSubmission: UsageSubmissionRecord = {
    id: 'venice-proof-' + Date.now(),
    agreementId: '100',
    provider: 'venice',
    items: [
      { unitType: 'VENICE_TEXT_TOKEN_IN', amount: '0.596235' },
      { unitType: 'VENICE_TEXT_TOKEN_OUT', amount: '0.00232' },
    ],
    usageDigest: 'proof-of-settlement-venice',
    at: new Date().toISOString(),
  };

  console.log('\n=== Venice: submitting registerUsage to Anvil ===');
  const veniceResult = await txSubmitter.send(veniceSubmission);
  console.log('Status:', veniceResult.status, 'TxHash:', veniceResult.txHash);
  results.push({ provider: 'venice', agreementId: '100', status: veniceResult.status, txHash: veniceResult.txHash });

  // Bankr settlement: submit registerUsage for agreement 101
  const bankrSubmission: UsageSubmissionRecord = {
    id: 'bankr-proof-' + Date.now(),
    agreementId: '101',
    provider: 'bankr',
    items: [
      { unitType: 'BANKR_TEXT_TOKEN_IN', amount: '0.013' },
      { unitType: 'BANKR_TEXT_TOKEN_OUT', amount: '0.030' },
    ],
    usageDigest: 'proof-of-settlement-bankr',
    at: new Date().toISOString(),
  };

  console.log('\n=== Bankr: submitting registerUsage to Anvil ===');
  const bankrResult = await txSubmitter.send(bankrSubmission);
  console.log('Status:', bankrResult.status, 'TxHash:', bankrResult.txHash);
  results.push({ provider: 'bankr', agreementId: '101', status: bankrResult.status, txHash: bankrResult.txHash });

  // Verify on-chain state
  console.log('\n=== Verifying on-chain state ===');
  for (const r of results) {
    if (r.txHash && typeof r.txHash === 'string') {
      const receipt = await provider.getTransactionReceipt(r.txHash as string);
      console.log(`${r.provider} tx ${r.txHash}:`);
      console.log(`  status: ${receipt?.status === 1 ? 'success' : 'failed'}`);
      console.log(`  blockNumber: ${receipt?.blockNumber}`);
      console.log(`  gasUsed: ${receipt?.gasUsed?.toString()}`);
    }
  }

  // Output JSON summary
  const summary = {
    runAt: new Date().toISOString(),
    mode: 'phase2_onchain_settlement',
    chain: 'anvil_31337',
    diamond: DIAMOND_ADDRESS,
    relayer: wallet.address,
    settlements: results,
  };

  console.log('\n=== SETTLEMENT PROOF ===');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
