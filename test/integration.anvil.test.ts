import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Contract,
  ContractFactory,
  HDNodeWallet,
  Interface,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  keccak256,
  parseEther,
  toUtf8Bytes,
} from 'ethers';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { OnchainActivationContextResolver } from '../src/activation-context-resolver';
import { EventListener } from '../src/event-listener';
import { OnchainEvent, OnchainEventIngestionWorker } from '../src/events';
import { DeterministicMeteringWorker } from '../src/metering';
import { NonceManager } from '../src/nonce-manager';
import { ComputeAdapterRegistry } from '../src/providers/registry';
import {
  ComputeProviderAdapter,
  ProvisionRequest,
  ProvisionResult,
  TerminateRequest,
  TerminateResult,
  UsageRequest,
  UsageResult,
} from '../src/providers/types';
import { ProviderEventIngress } from '../src/provider-event-ingress';
import { InMemoryMessageStore, UsageSubmissionRecord } from '../src/store';
import { GasEstimator } from '../src/gas-estimator';
import { UsageSettlementService } from '../src/settlement';
import { TransactionSubmitter } from '../src/tx-submitter';

interface Artifact {
  abi: unknown[];
  bytecode?: { object?: string } | string;
}

interface DeployedStack {
  provider: JsonRpcProvider;
  chainId: number;
  admin: Wallet;
  borrower: Wallet;
  lender: Wallet;
  relayer: Wallet;
  diamondAddress: string;
  proposal: Contract;
  approval: Contract;
  agreement: Contract;
  mailbox: Contract;
  compute: Contract;
  encPub: Contract;
  positionNft: Contract;
  token: Contract;
}

interface CollectorWorker {
  events: OnchainEvent[];
  ingest: (event: OnchainEvent) => Promise<{
    accepted: boolean;
    deduped: boolean;
    eventKey: string;
    eventType: OnchainEvent['eventType'];
    agreementId: string;
    action: string;
  }>;
}

class MockBankrAdapter implements ComputeProviderAdapter {
  readonly provider = 'bankr' as const;

  constructor(
    private readonly usageRows: UsageResult['usage'],
    private readonly connection: Record<string, unknown> = { apiKey: 'bankr-key' }
  ) {}

  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    return {
      status: 'ok',
      provider: this.provider,
      providerResourceId: `bankr-${request.agreementId}`,
      connection: this.connection,
    };
  }

  async usage(_request: UsageRequest): Promise<UsageResult> {
    return {
      status: 'ok',
      provider: this.provider,
      usage: this.usageRows,
    };
  }

  async terminate(_request: TerminateRequest): Promise<TerminateResult> {
    return {
      status: 'ok',
      provider: this.provider,
      terminated: true,
    };
  }
}

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const HACKATHON_ROOT = resolve(THIS_DIR, '../..');
const EQUALFI_OUT = resolve(HACKATHON_ROOT, 'EqualFi/out');
const ANVIL_URL = process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545';
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const INTEGRATION_TIMEOUT_MS = 45_000;

const PROVIDER_BANKR = keccak256(toUtf8Bytes('bankr'));
const UNIT_BANKR_TEXT_IN = keccak256(toUtf8Bytes('BANKR_TEXT_TOKEN_IN'));

function artifactPath(relativePath: string): string {
  return resolve(EQUALFI_OUT, relativePath);
}

function loadArtifact(relativePath: string): Artifact {
  const raw = readFileSync(artifactPath(relativePath), 'utf8');
  return JSON.parse(raw) as Artifact;
}

function bytecodeFor(artifact: Artifact): string {
  if (typeof artifact.bytecode === 'string' && artifact.bytecode.length > 2) {
    return artifact.bytecode;
  }
  if (typeof artifact.bytecode === 'object' && artifact.bytecode?.object && artifact.bytecode.object.length > 2) {
    return artifact.bytecode.object;
  }
  throw new Error('missing_bytecode');
}

function selectors(abi: unknown[], names: string[]): string[] {
  const iface = new Interface(abi as any[]);
  return names.map((name) => {
    const fragment = iface.getFunction(name);
    if (!fragment) throw new Error(`missing_function:${name}`);
    return fragment.selector;
  });
}

class LatestNonceWallet extends Wallet {
  override async getNonce(_blockTag?: 'latest' | 'pending'): Promise<number> {
    if (!this.provider) {
      throw new Error('wallet_provider_missing');
    }
    return this.provider.getTransactionCount(this.address, 'latest');
  }
}

function walletAt(index: number, provider: JsonRpcProvider): Wallet {
  const hdWallet = HDNodeWallet.fromPhrase(ANVIL_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);
  return new LatestNonceWallet(hdWallet.privateKey, provider);
}

function canonicalEnvelope(recipient: string): Uint8Array {
  return toUtf8Bytes(
    JSON.stringify({
      version: 'equalfi.mailbox.ecies.eth-crypto.v1',
      recipient,
      cipher: {
        iv: '45ec7da7123f5562935ecd4cf0f3139e',
        ephemPublicKey:
          '045ea7b6221a026bafa1adcf2c727d8ebaf5395b40a932bf85c1e991467113ba8867fbcca8e242864e0ea02342deb475e17f384095208dd7e34b1a9162ac647323',
        mac: '0957308398294e8c9f03482c7c0ba49c9aa7d3252dabe4af8224279d9be220c1',
        ciphertext: '9971dc361b6cd776ffc3fdb0a7d74149',
      },
      createdAt: '2026-03-13T12:00:00.000Z',
    })
  );
}

async function deployContract(
  signer: Wallet,
  artifact: Artifact,
  args: unknown[] = []
): Promise<Contract> {
  const factory = new ContractFactory(artifact.abi as any[], bytecodeFor(artifact), signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function waitForCondition(check: () => boolean, timeoutMs = 12_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error('timeout_waiting_for_condition');
}

async function resetAnvil(provider: JsonRpcProvider): Promise<void> {
  await provider.send('anvil_reset', []);
}

async function buildAgenticDiamond(provider: JsonRpcProvider): Promise<DeployedStack> {
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);

  const admin = walletAt(0, provider);
  const borrower = walletAt(1, provider);
  const lender = walletAt(2, provider);
  const relayer = walletAt(3, provider);

  const diamondCutFacetArtifact = loadArtifact('DiamondCutFacet.sol/DiamondCutFacet.json');
  const diamondArtifact = loadArtifact('Diamond.sol/Diamond.json');
  const idiamondCutArtifact = loadArtifact('IDiamondCut.sol/IDiamondCut.json');

  const proposalArtifact = loadArtifact('AgenticProposalFacet.sol/AgenticProposalFacet.json');
  const approvalArtifact = loadArtifact('AgenticApprovalFacet.sol/AgenticApprovalFacet.json');
  const agreementHarnessArtifact = loadArtifact('AgenticAgreementFacet.t.sol/AgenticAgreementHarness.json');
  const mailboxArtifact = loadArtifact('AgenticMailboxFacet.sol/AgenticMailboxFacet.json');
  const computeArtifact = loadArtifact('ComputeUsageFacet.sol/ComputeUsageFacet.json');
  const encPubArtifact = loadArtifact('AgentEncPubRegistryFacet.sol/AgentEncPubRegistryFacet.json');
  const mockPositionArtifact = loadArtifact('AgenticAgreementFacet.t.sol/MockPositionNFTPool.json');
  const mockTokenArtifact = loadArtifact('AgenticTestBase.sol/MockAgenticERC20.json');

  const cutFacet = await deployContract(admin, diamondCutFacetArtifact);
  const cutFacetAddress = await cutFacet.getAddress();
  const diamondCutSelector = selectors(diamondCutFacetArtifact.abi, ['diamondCut'])[0];
  const diamond = await deployContract(admin, diamondArtifact, [
    [{ facetAddress: cutFacetAddress, action: 0, functionSelectors: [diamondCutSelector] }],
    { owner: admin.address },
  ]);
  const diamondAddress = await diamond.getAddress();

  const proposalFacet = await deployContract(admin, proposalArtifact);
  const approvalFacet = await deployContract(admin, approvalArtifact);
  const agreementFacet = await deployContract(admin, agreementHarnessArtifact);
  const mailboxFacet = await deployContract(admin, mailboxArtifact);
  const computeFacet = await deployContract(admin, computeArtifact);
  const encPubFacet = await deployContract(admin, encPubArtifact);

  const proposalSelectors = selectors(proposalArtifact.abi, [
    'createProposal',
    'cancelProposal',
    'getProposal',
    'getProposalsByAgent',
    'getProposalsByLender',
  ]);
  const approvalSelectors = selectors(approvalArtifact.abi, ['approveProposal', 'rejectProposal']);
  const agreementSelectors = selectors(agreementHarnessArtifact.abi, [
    'activateAgreement',
    'applyRepayment',
    'closeAgreement',
    'grantRelayerRole',
    'revokeRelayerRole',
    'getAgreement',
    'getAgreementsByAgent',
    'getEncumbrance',
    'setOwner',
    'setPositionNFTContract',
    'setPool',
    'seedProposal',
    'seedAgreement',
    'setDirectLent',
    'getDirectLent',
    'getProposalStatus',
    'getLenderAgreements',
    'isRelayer',
    'setReentrancyLock',
    'setProposalProviderId',
    'setPrincipalDrawn',
    'increasePrincipalDrawn',
  ]);
  const mailboxSelectors = selectors(mailboxArtifact.abi, [
    'publishBorrowerPayload',
    'publishProviderPayload',
    'getBorrowerPayload',
    'getProviderPayload',
  ]);
  const computeSelectors = selectors(computeArtifact.abi, [
    'setComputeUnitConfig',
    'registerUsage',
    'batchRegisterUsage',
    'getComputeUnitConfig',
    'getUnitUsage',
  ]);
  const encPubSelectors = selectors(encPubArtifact.abi, ['registerEncPubKey', 'getEncPubKey']);

  const diamondCut = new Contract(diamondAddress, idiamondCutArtifact.abi as any[], admin);
  const cuts = [
    { facetAddress: await proposalFacet.getAddress(), action: 0, functionSelectors: proposalSelectors },
    { facetAddress: await approvalFacet.getAddress(), action: 0, functionSelectors: approvalSelectors },
    { facetAddress: await agreementFacet.getAddress(), action: 0, functionSelectors: agreementSelectors },
    { facetAddress: await mailboxFacet.getAddress(), action: 0, functionSelectors: mailboxSelectors },
    { facetAddress: await computeFacet.getAddress(), action: 0, functionSelectors: computeSelectors },
    { facetAddress: await encPubFacet.getAddress(), action: 0, functionSelectors: encPubSelectors },
  ];
  await (await diamondCut.diamondCut(cuts, ZeroAddress, '0x')).wait();

  const positionNft = await deployContract(admin, mockPositionArtifact);
  const token = await deployContract(admin, mockTokenArtifact, ['Agentic Settlement', 'aUSD', 18]);

  const agreement = new Contract(diamondAddress, agreementHarnessArtifact.abi as any[], admin);
  await (await agreement.setPositionNFTContract(await positionNft.getAddress())).wait();
  await (await agreement.setPool(1, await token.getAddress(), parseEther('1000000'), 0n)).wait();
  await (await positionNft.setPoolId(777, 1)).wait();
  await (await agreement.grantRelayerRole(relayer.address)).wait();

  await (await token.mint(borrower.address, parseEther('1000000'))).wait();

  return {
    provider,
    chainId,
    admin,
    borrower,
    lender,
    relayer,
    diamondAddress,
    proposal: new Contract(diamondAddress, proposalArtifact.abi as any[], provider),
    approval: new Contract(diamondAddress, approvalArtifact.abi as any[], provider),
    agreement: new Contract(diamondAddress, agreementHarnessArtifact.abi as any[], provider),
    mailbox: new Contract(diamondAddress, mailboxArtifact.abi as any[], provider),
    compute: new Contract(diamondAddress, computeArtifact.abi as any[], provider),
    encPub: new Contract(diamondAddress, encPubArtifact.abi as any[], provider),
    positionNft,
    token,
  };
}

async function createApprovedProposal(stack: DeployedStack): Promise<{ proposalId: bigint; activationBlock: number }> {
  const nowBlock = await stack.provider.getBlock('latest');
  const expiresAt = BigInt((nowBlock?.timestamp ?? Math.floor(Date.now() / 1000)) + 3600);

  const proposalAsBorrower = stack.proposal.connect(stack.borrower);
  const approvalAsLender = stack.approval.connect(stack.lender);

  const createTx = await proposalAsBorrower.createProposal(
    'erc8004:1:registry',
    1n,
    777n,
    await stack.token.getAddress(),
    parseEther('100'),
    parseEther('1000'),
    expiresAt,
    stack.lender.address,
    PROVIDER_BANKR,
    keccak256(toUtf8Bytes('terms'))
  );
  await createTx.wait();

  const approveTx = await approvalAsLender.approveProposal(1n);
  const approveReceipt = await approveTx.wait();
  if (!approveReceipt) throw new Error('missing_approve_receipt');

  return { proposalId: 1n, activationBlock: approveReceipt.blockNumber };
}

async function createActiveAgreement(stack: DeployedStack): Promise<{ agreementId: bigint; activationBlock: number }> {
  await createApprovedProposal(stack);
  const activationTx = await stack.agreement.connect(stack.borrower).activateAgreement(1n);
  const activationReceipt = await activationTx.wait();
  if (!activationReceipt) throw new Error('missing_activation_receipt');
  return { agreementId: 1n, activationBlock: activationReceipt.blockNumber };
}

async function seedActiveAgreementForMailbox(stack: DeployedStack, agreementId: bigint): Promise<void> {
  await (
    await stack.agreement.connect(stack.admin).seedAgreement(
      agreementId,
      1n,
      777n,
      await stack.token.getAddress(),
      stack.borrower.address,
      stack.lender.address,
      parseEther('100'),
      parseEther('1000'),
      0n,
      0n,
      0n,
      0n,
      parseEther('100'),
      parseEther('1000'),
      0
    )
  ).wait();
}

function makeCollectorWorker(delayMs = 0): CollectorWorker {
  const events: OnchainEvent[] = [];
  return {
    events,
    ingest: async (event: OnchainEvent) => {
      if (delayMs > 0) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      }
      events.push(event);
      return {
        accepted: true,
        deduped: false,
        eventKey: `${event.chainId}:${event.blockNumber}:${event.logIndex}`,
        eventType: event.eventType,
        agreementId: event.agreementId,
        action: 'accepted',
      };
    },
  };
}

describe.sequential('Phase 2 Anvil integration tests', () => {
  it(
    '13.1 Requirement 17: full lifecycle with listener, tx submitter, and closure',
    async () => {
      const provider = new JsonRpcProvider(ANVIL_URL, undefined, { cacheTimeout: 0 });
    await resetAnvil(provider);
    const stack = await buildAgenticDiamond(provider);

    const store = new InMemoryMessageStore();
    const registry = new ComputeAdapterRegistry();
    registry.register(
      new MockBankrAdapter(
        [{ unitType: 'BANKR_TEXT_TOKEN_IN', amount: '3', observedAt: '2026-03-13T12:00:05.000Z', requestId: 'job-1' }],
        { apiKey: 'bankr-live-key' }
      )
    );

    const nonceManager = new NonceManager(provider, stack.relayer.address);
    await nonceManager.init();
    const gasEstimator = new GasEstimator(provider, 1.2, 1_000);
    const txSubmitter = new TransactionSubmitter(
      {
        diamondAddress: stack.diamondAddress,
        chainId: stack.chainId,
        txTimeoutMs: 15_000,
        maxGasPriceGwei: 1_000,
        lowBalanceThresholdEth: 0.001,
        receiptPollIntervalMs: 100,
      },
      provider,
      nonceManager,
      gasEstimator,
      stack.relayer as unknown as Wallet
    );

    const meteringWorker = new DeterministicMeteringWorker(store, registry);
    const activationResolver = new OnchainActivationContextResolver(provider, stack.diamondAddress);
    const ingestionWorker = new OnchainEventIngestionWorker(
      store,
      registry,
      meteringWorker,
      undefined,
      { mode: 'none' },
      txSubmitter,
      activationResolver
    );
    const listener = new EventListener(
      {
        diamondAddress: stack.diamondAddress,
        chainId: stack.chainId,
        startBlock: await provider.getBlockNumber(),
        confirmationDepth: 0,
        pollIntervalMs: 100,
      },
      provider,
      store,
      ingestionWorker
    );

    await listener.start();

    await (
      await stack.encPub
        .connect(stack.borrower)
        .registerEncPubKey(stack.borrower.signingKey.compressedPublicKey)
    ).wait();

    const { agreementId, activationBlock } = await createActiveAgreement(stack);

    await waitForCondition(() => {
      const cursor = store.getBlockCursor(stack.chainId);
      return Boolean(cursor && cursor.lastConfirmed >= activationBlock);
    });

    await waitForCondition(() => Boolean(store.getProviderLink(agreementId.toString())));
    await txSubmitter.waitForIdle();

    const providerLink = store.getProviderLink(agreementId.toString());
    expect(providerLink?.provider).toBe('bankr');

    const providerPayload = await stack.mailbox.getProviderPayload(agreementId);
    expect(typeof providerPayload).toBe('string');
    expect((providerPayload as string).length).toBeGreaterThan(2);

    await (
      await stack.compute
        .connect(stack.admin)
        .setComputeUnitConfig(await stack.token.getAddress(), UNIT_BANKR_TEXT_IN, parseEther('2'), true)
    ).wait();

    const meteringResult = await meteringWorker.runForAgreement(agreementId.toString(), { to: '2026-03-13T12:01:00.000Z' });
    expect(meteringResult.status).toBe('prepared');
    expect(meteringResult.submissionId).toBeDefined();
    expect(meteringResult.aggregatedItems).toEqual([{ unitType: 'BANKR_TEXT_TOKEN_IN', amount: '3' }]);

    const submission = store.getUsageSubmission(meteringResult.submissionId!);
    expect(submission).toBeDefined();

    const sendResult = await txSubmitter.send(submission as UsageSubmissionRecord);
    expect(sendResult.status).toBe('ok');
    expect(sendResult.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

    const agreementAfterUsage = await stack.agreement.getAgreement(agreementId);
    const principalDrawn: bigint = agreementAfterUsage.principalDrawn;
    expect(principalDrawn).toBe(parseEther('6'));

    await (await stack.token.connect(stack.borrower).approve(stack.diamondAddress, principalDrawn)).wait();
    await (await stack.agreement.connect(stack.borrower).applyRepayment(agreementId, principalDrawn)).wait();
    await (await stack.agreement.connect(stack.borrower).closeAgreement(agreementId)).wait();

    const closedAgreement = await stack.agreement.getAgreement(agreementId);
    expect(closedAgreement.status).toBe(1n);
    expect(closedAgreement.principalRepaid).toBe(principalDrawn);

    const finalCursor = store.getBlockCursor(stack.chainId);
    expect(finalCursor).toBeDefined();
    expect((finalCursor as { lastConfirmed: number }).lastConfirmed).toBeGreaterThanOrEqual(activationBlock);

    await listener.stop();
    },
    INTEGRATION_TIMEOUT_MS
  );

  it(
    '13.6 Requirement 26: provider webhook ingestion is idempotent and metering-safe',
    async () => {
      const provider = new JsonRpcProvider(ANVIL_URL, undefined, { cacheTimeout: 0 });
    await resetAnvil(provider);

    const store = new InMemoryMessageStore();
    const registry = new ComputeAdapterRegistry();
    registry.register(
      new MockBankrAdapter([
        {
          unitType: 'BANKR_TEXT_TOKEN_IN',
          amount: '5',
          observedAt: '2026-03-13T13:00:05.000Z',
          requestId: 'evt-bankr-1',
        },
      ])
    );

    store.setProviderLink({
      agreementId: 'agreement-webhook-1',
      provider: 'bankr',
      providerResourceId: 'bankr-resource-1',
      updatedAt: '2026-03-13T13:00:00.000Z',
    });

    const meteringWorker = new DeterministicMeteringWorker(store, registry);

    const logs: unknown[] = [];
    const providerEventIngress = new ProviderEventIngress(
      store,
      { authToken: 'secret-token' },
      {
        info: (obj) => logs.push(obj),
      }
    );

    const app = buildApp(store, registry, meteringWorker, undefined, undefined, undefined, undefined, undefined, {
      providerEventIngress,
    });

    const payload = {
      provider: 'bankr',
      providerResourceId: 'bankr-resource-1',
      externalEventId: 'evt-bankr-1',
      payload: {
        usage: [
          {
            unitType: 'BANKR_TEXT_TOKEN_IN',
            amount: '5',
            observedAt: '2026-03-13T13:00:05.000Z',
            requestId: 'evt-bankr-1',
          },
        ],
      },
      observedAt: '2026-03-13T13:00:05.000Z',
      traceId: 'trace-bankr-1',
    };

    const first = await app.inject({
      method: 'POST',
      url: '/events/provider',
      headers: { authorization: 'Bearer secret-token' },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/events/provider',
      headers: { authorization: 'Bearer secret-token' },
      payload,
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(first.json()).toEqual({ ok: true, deduped: false });
    expect(second.json()).toEqual({ ok: true, deduped: true });

    const rows = store.listProviderEvents('bankr', 'bankr-resource-1');
    expect(rows).toHaveLength(1);
    expect(logs.length).toBeGreaterThanOrEqual(2);

    const metering = await meteringWorker.runForAgreement('agreement-webhook-1', { to: '2026-03-13T13:01:00.000Z' });
    expect(metering.status).toBe('prepared');
    expect(metering.usageRows).toBe(1);
    expect(metering.aggregatedItems).toEqual([{ unitType: 'BANKR_TEXT_TOKEN_IN', amount: '5' }]);

    await app.close();
    },
    INTEGRATION_TIMEOUT_MS
  );

  it(
    '13.2 Requirement 18: reorg simulation discards orphaned events',
    async () => {
      const provider = new JsonRpcProvider(ANVIL_URL, undefined, { cacheTimeout: 0 });
    await resetAnvil(provider);
    const stack = await buildAgenticDiamond(provider);
    await seedActiveAgreementForMailbox(stack, 1n);

    const store = new InMemoryMessageStore();
    const collector = makeCollectorWorker();
    const listener = new EventListener(
      {
        diamondAddress: stack.diamondAddress,
        chainId: stack.chainId,
        startBlock: await provider.getBlockNumber(),
        confirmationDepth: 2,
        pollIntervalMs: 100,
      },
      provider,
      store,
      collector as unknown as OnchainEventIngestionWorker
    );
    await listener.start();

    const snapshot = await provider.send('evm_snapshot', []);

    const orphanTx = await stack.mailbox.connect(stack.borrower).publishBorrowerPayload(1n, canonicalEnvelope('agent:orphan'));
    const orphanReceipt = await orphanTx.wait();
    if (!orphanReceipt) throw new Error('missing_orphan_receipt');
    await provider.send('evm_mine', []);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));

    await provider.send('evm_revert', [snapshot]);

    const canonicalTx = await stack.mailbox
      .connect(stack.borrower)
      .publishBorrowerPayload(1n, canonicalEnvelope('agent:canonical'));
    const canonicalReceipt = await canonicalTx.wait();
    if (!canonicalReceipt) throw new Error('missing_canonical_receipt');
    await provider.send('evm_mine', []);
    await provider.send('evm_mine', []);

    await waitForCondition(() => collector.events.length >= 1, 10_000);
    expect(collector.events).toHaveLength(1);
    expect(collector.events[0].blockNumber).toBeGreaterThanOrEqual(canonicalReceipt.blockNumber);
    expect(collector.events[0].txHash).toBe(canonicalReceipt.hash);
    expect(collector.events[0].txHash).not.toBe(orphanReceipt.hash);
    expect(collector.events[0].envelope?.recipient).toBe('agent:canonical');

    await listener.stop();
    },
    INTEGRATION_TIMEOUT_MS
  );

  it(
    '13.3 Requirement 19: tx failure recovery schedules retry and handles nonce desync',
    async () => {
      const provider = new JsonRpcProvider(ANVIL_URL, undefined, { cacheTimeout: 0 });
    await resetAnvil(provider);
    const stack = await buildAgenticDiamond(provider);
    const { agreementId } = await createActiveAgreement(stack);

    await (
      await stack.compute
        .connect(stack.admin)
        .setComputeUnitConfig(await stack.token.getAddress(), UNIT_BANKR_TEXT_IN, parseEther('2'), true)
    ).wait();

    const store = new InMemoryMessageStore();
    const nonceManager = new NonceManager(provider, stack.relayer.address);
    await nonceManager.init();
    const txSubmitter = new TransactionSubmitter(
      {
        diamondAddress: stack.diamondAddress,
        chainId: stack.chainId,
        txTimeoutMs: 15_000,
        maxGasPriceGwei: 1_000,
        lowBalanceThresholdEth: 0.001,
        receiptPollIntervalMs: 100,
      },
      provider,
      nonceManager,
      new GasEstimator(provider, 1.2, 1_000),
      stack.relayer as unknown as Wallet
    );

    const settlement = new UsageSettlementService(store, txSubmitter, {
      baseBackoffMs: 250,
      maxBackoffMs: 2_000,
      maxAttempts: 3,
    });

    const failingSubmission: UsageSubmissionRecord = {
      id: 'submission-fail',
      agreementId: agreementId.toString(),
      provider: 'bankr',
      to: '2026-03-13T14:00:00.000Z',
      usageDigest: 'digest-fail',
      items: [{ unitType: 'BANKR_TEXT_TOKEN_IN', amount: '5000' }],
      finalPass: false,
      createdAt: '2026-03-13T14:00:01.000Z',
    };
    store.addUsageSubmission(failingSubmission);

    const firstAttempt = await settlement.runForSubmission(failingSubmission.id);
    expect(firstAttempt).toBeDefined();
    expect(firstAttempt?.settled).toBe(false);
    expect(firstAttempt?.status).toBe('error');
    expect(firstAttempt?.nextRetryAt).toBeDefined();

    // Desync local nonce by sending a raw tx directly through the relayer wallet.
    const rawTx = await walletAt(3, provider).sendTransaction({
      to: stack.admin.address,
      value: 1n,
    });
    await rawTx.wait();

    const goodSubmission: UsageSubmissionRecord = {
      id: 'submission-ok',
      agreementId: agreementId.toString(),
      provider: 'bankr',
      to: '2026-03-13T14:01:00.000Z',
      usageDigest: 'digest-ok',
      items: [{ unitType: 'BANKR_TEXT_TOKEN_IN', amount: '1' }],
      finalPass: false,
      createdAt: '2026-03-13T14:01:01.000Z',
    };

    const okResult = await txSubmitter.send(goodSubmission);
    expect(okResult.status).toBe('ok');
    expect(okResult.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    },
    INTEGRATION_TIMEOUT_MS
  );

  it(
    '13.4 Requirement 20: idempotent re-delivery with cursor rewind',
    async () => {
      const provider = new JsonRpcProvider(ANVIL_URL, undefined, { cacheTimeout: 0 });
    await resetAnvil(provider);
    const stack = await buildAgenticDiamond(provider);
    await seedActiveAgreementForMailbox(stack, 1n);

    const store = new InMemoryMessageStore();
    const registry = new ComputeAdapterRegistry();
    const ingestionWorker = new OnchainEventIngestionWorker(store, registry);

    const listenerA = new EventListener(
      {
        diamondAddress: stack.diamondAddress,
        chainId: stack.chainId,
        startBlock: await provider.getBlockNumber(),
        confirmationDepth: 0,
        pollIntervalMs: 100,
      },
      provider,
      store,
      ingestionWorker
    );
    await listenerA.start();

    const mailboxTx = await stack.mailbox
      .connect(stack.borrower)
      .publishBorrowerPayload(1n, canonicalEnvelope('agent:redelivery'));
    const mailboxReceipt = await mailboxTx.wait();
    if (!mailboxReceipt) throw new Error('missing_mailbox_receipt');

    await waitForCondition(() => store.getAgreementState('1')?.state === 'mailbox_received');
    await listenerA.stop();

    const firstState = store.getAgreementState('1');
    expect(firstState).toBeDefined();

    store.setBlockCursor(stack.chainId, mailboxReceipt.blockNumber - 1);

    const listenerB = new EventListener(
      {
        diamondAddress: stack.diamondAddress,
        chainId: stack.chainId,
        startBlock: 0,
        confirmationDepth: 0,
        pollIntervalMs: 100,
      },
      provider,
      store,
      ingestionWorker
    );
    await listenerB.start();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    await listenerB.stop();

    const secondState = store.getAgreementState('1');
    expect(secondState?.updatedAt).toBe(firstState?.updatedAt);
    expect((store as any).processedEvents.size).toBe(1);
    expect((store as any).messages.size).toBe(1);
    },
    INTEGRATION_TIMEOUT_MS
  );

  it(
    '13.5 Requirement 21: graceful shutdown persists full block progress',
    async () => {
      const provider = new JsonRpcProvider(ANVIL_URL, undefined, { cacheTimeout: 0 });
    await resetAnvil(provider);
    const stack = await buildAgenticDiamond(provider);
    await seedActiveAgreementForMailbox(stack, 1n);

    const store = new InMemoryMessageStore();
    const collector = makeCollectorWorker(120);

    const listener = new EventListener(
      {
        diamondAddress: stack.diamondAddress,
        chainId: stack.chainId,
        startBlock: await provider.getBlockNumber(),
        confirmationDepth: 0,
        pollIntervalMs: 100,
      },
      provider,
      store,
      collector as unknown as OnchainEventIngestionWorker
    );

    const txA = await stack.mailbox
      .connect(stack.borrower)
      .publishBorrowerPayload(1n, canonicalEnvelope('agent:shutdown:a'));
    await txA.wait();
    const txB = await stack.mailbox
      .connect(stack.borrower)
      .publishBorrowerPayload(1n, canonicalEnvelope('agent:shutdown:b'));
    await txB.wait();

    await listener.start();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    await listener.stop();

    expect(collector.events.length).toBeGreaterThan(0);

    const cursor = store.getBlockCursor(stack.chainId);
    expect(cursor).toBeDefined();
    const maxDeliveredBlock = Math.max(...collector.events.map((event) => event.blockNumber));
    expect((cursor as { lastConfirmed: number }).lastConfirmed).toBe(maxDeliveredBlock);
    expect(collector.events.every((event) => event.blockNumber <= (cursor as { lastConfirmed: number }).lastConfirmed)).toBe(true);
    },
    INTEGRATION_TIMEOUT_MS
  );
});
