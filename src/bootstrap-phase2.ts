import { JsonRpcProvider, Wallet } from 'ethers';
import { AlertingService } from './alerting';
import { validatePhase2Env } from './env-config';
import { OnchainEventIngestionWorker } from './events';
import { EventListener } from './event-listener';
import { GasEstimator } from './gas-estimator';
import { KillSwitchEnforcementService } from './killswitch';
import { DeterministicMeteringWorker } from './metering';
import { NonceManager } from './nonce-manager';
import { createDefaultComputeAdapterRegistry, ComputeAdapterRegistry } from './providers';
import { ProviderEventIngress } from './provider-event-ingress';
import { UsageSettlementService } from './settlement';
import { createDefaultStore, MessageStore } from './store';
import { TransactionSubmitter } from './tx-submitter';
import { ActivationContextResolver, OnchainActivationContextResolver } from './activation-context-resolver';

interface LoggerLike {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}

export interface BootstrapPhase2Options {
  store?: MessageStore;
  providerRegistry?: ComputeAdapterRegistry;
  meteringWorker?: DeterministicMeteringWorker;
  killSwitchService?: KillSwitchEnforcementService;
  alertingService?: AlertingService;
  logger?: LoggerLike;
  providerFactory?: (rpcUrl: string) => JsonRpcProvider;
  walletFactory?: (privateKey: string, provider: JsonRpcProvider) => Wallet;
}

export interface BootstrapPhase2Result {
  store: MessageStore;
  providerRegistry: ComputeAdapterRegistry;
  meteringWorker: DeterministicMeteringWorker;
  killSwitchService: KillSwitchEnforcementService;
  activationContextResolver: ActivationContextResolver;
  usageSettlementService: UsageSettlementService;
  txSubmitter: TransactionSubmitter;
  eventListener: EventListener;
  providerEventIngress: ProviderEventIngress;
}

function envRecord(): Record<string, string | undefined> {
  return process.env as Record<string, string | undefined>;
}

export async function bootstrapPhase2(options: BootstrapPhase2Options = {}): Promise<BootstrapPhase2Result> {
  const logger = options.logger ?? console;
  const env = validatePhase2Env(envRecord());

  const store = options.store ?? createDefaultStore();
  const providerRegistry = options.providerRegistry ?? createDefaultComputeAdapterRegistry();
  const meteringWorker = options.meteringWorker ?? new DeterministicMeteringWorker(store, providerRegistry);
  const killSwitchService = options.killSwitchService ?? new KillSwitchEnforcementService(store, providerRegistry);

  const provider = options.providerFactory ? options.providerFactory(env.RPC_URL) : new JsonRpcProvider(env.RPC_URL);
  const wallet = options.walletFactory
    ? options.walletFactory(env.RELAYER_PRIVATE_KEY, provider)
    : new Wallet(env.RELAYER_PRIVATE_KEY, provider);

  logger.info?.({ walletAddress: wallet.address }, 'phase2 signer configured');

  const nonceManager = new NonceManager(provider, wallet.address);
  await nonceManager.init();

  const gasEstimator = new GasEstimator(provider, env.GAS_LIMIT_MULTIPLIER, env.MAX_GAS_PRICE_GWEI);

  const txSubmitter = new TransactionSubmitter(
    {
      diamondAddress: env.DIAMOND_ADDRESS,
      chainId: env.CHAIN_ID,
      txTimeoutMs: env.TX_TIMEOUT_MS,
      maxGasPriceGwei: env.MAX_GAS_PRICE_GWEI,
      lowBalanceThresholdEth: env.LOW_BALANCE_THRESHOLD_ETH,
      receiptPollIntervalMs: env.EVENT_POLL_INTERVAL_MS,
    },
    provider,
    nonceManager,
    gasEstimator,
    wallet,
    options.alertingService,
    logger
  );

  const identityGate = env.IDENTITY_MODE === 'erc8004_offchain'
    ? {
        mode: 'erc8004_offchain' as const,
        targetChainId: env.CHAIN_ID,
        diamondAddress: env.DIAMOND_ADDRESS,
        erc8004ChainId: env.ERC8004_CHAIN_ID,
        erc8004RpcUrl: env.ERC8004_RPC_URL,
        erc8004RegistryAddress: env.ERC8004_REGISTRY_ADDRESS,
        proofMaxSkewSeconds: env.IDENTITY_PROOF_MAX_SKEW_SECONDS,
      }
    : { mode: 'none' as const };

  const activationContextResolver = new OnchainActivationContextResolver(provider, env.DIAMOND_ADDRESS);

  const onchainWorker = new OnchainEventIngestionWorker(
    store,
    providerRegistry,
    meteringWorker,
    killSwitchService,
    identityGate,
    txSubmitter,
    activationContextResolver
  );

  const eventListener = new EventListener(
    {
      diamondAddress: env.DIAMOND_ADDRESS,
      chainId: env.CHAIN_ID,
      startBlock: env.EVENT_LISTENER_START_BLOCK,
      confirmationDepth: env.CONFIRMATION_DEPTH,
      pollIntervalMs: env.EVENT_POLL_INTERVAL_MS,
    },
    provider,
    store,
    onchainWorker,
    logger
  );

  const providerEventIngress = new ProviderEventIngress(
    store,
    {
      authToken: env.PROVIDER_EVENT_AUTH_TOKEN,
    },
    logger
  );

  const usageSettlementService = new UsageSettlementService(store, txSubmitter, {}, options.alertingService);

  return {
    store,
    providerRegistry,
    meteringWorker,
    killSwitchService,
    activationContextResolver,
    usageSettlementService,
    txSubmitter,
    eventListener,
    providerEventIngress,
  };
}
