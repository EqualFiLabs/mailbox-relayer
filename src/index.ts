import { buildApp } from './app';
import { createDefaultStore } from './store';
import { createDefaultComputeAdapterRegistry } from './providers';
import { DeterministicMeteringWorker, MeteringScheduler } from './metering';
import { KillSwitchEnforcementService, KillSwitchRetryScheduler } from './killswitch';
import {
  DisabledUsageSettlementSender,
  UsageSettlementScheduler,
  UsageSettlementService,
  WebhookUsageSettlementSender,
} from './settlement';
import { AlertingService, DisabledAlertSender, WebhookAlertSender } from './alerting';
import { bootstrapPhase2 } from './bootstrap-phase2';
import { InterestAccrualScheduler, InterestAccrualService } from './interest-accrual';
import { CovenantMonitorScheduler, CovenantMonitorService } from './covenant-monitor';
import { DelinquencyMonitor } from './schedulers/DelinquencyMonitor';
import { JsonRpcProvider, Wallet } from 'ethers';

function phase2ConfigMode(): 'disabled' | 'partial' | 'enabled' {
  const required = ['RPC_URL', 'DIAMOND_ADDRESS', 'CHAIN_ID', 'RELAYER_PRIVATE_KEY'];
  const configured = required.filter((key) => {
    const value = process.env[key];
    return typeof value === 'string' && value.length > 0;
  });

  if (configured.length === 0) return 'disabled';
  if (configured.length === required.length) return 'enabled';
  return 'partial';
}

async function main(): Promise<void> {
  const alertingService = new AlertingService(
    process.env.ALERT_WEBHOOK_URL
      ? new WebhookAlertSender(process.env.ALERT_WEBHOOK_URL, process.env.ALERT_WEBHOOK_TOKEN)
      : new DisabledAlertSender()
  );

  const phase2Mode = phase2ConfigMode();
  if (phase2Mode === 'partial') {
    throw new Error('phase2_partial_env_config: set all of RPC_URL, DIAMOND_ADDRESS, CHAIN_ID, RELAYER_PRIVATE_KEY');
  }

  const phase2 =
    phase2Mode === 'enabled'
      ? await bootstrapPhase2({
          alertingService,
          logger: console,
        })
      : undefined;

  const store = phase2?.store ?? createDefaultStore();
  const providerRegistry = phase2?.providerRegistry ?? createDefaultComputeAdapterRegistry();

  const meteringWorker = phase2?.meteringWorker ?? new DeterministicMeteringWorker(store, providerRegistry, undefined, alertingService);
  const meteringIntervalMs = Number(process.env.METERING_INTERVAL_MS ?? '30000');
  const meteringEnabled = process.env.METERING_ENABLED === 'true';
  const meteringScheduler = new MeteringScheduler(meteringWorker, meteringIntervalMs);
  if (meteringEnabled) {
    meteringScheduler.start();
  }

  const killSwitchService =
    phase2?.killSwitchService ?? new KillSwitchEnforcementService(store, providerRegistry, {}, alertingService);
  const killSwitchRetryIntervalMs = Number(process.env.KILLSWITCH_RETRY_INTERVAL_MS ?? '30000');
  const killSwitchRetryEnabled = process.env.KILLSWITCH_RETRY_ENABLED === 'true';
  const killSwitchRetryScheduler = new KillSwitchRetryScheduler(killSwitchService, killSwitchRetryIntervalMs);
  if (killSwitchRetryEnabled) {
    killSwitchRetryScheduler.start();
  }

  const fallbackSettlementSender = process.env.USAGE_SETTLEMENT_WEBHOOK_URL
    ? new WebhookUsageSettlementSender(
        process.env.USAGE_SETTLEMENT_WEBHOOK_URL,
        process.env.USAGE_SETTLEMENT_WEBHOOK_TOKEN
      )
    : new DisabledUsageSettlementSender();

  const usageSettlementService =
    phase2?.usageSettlementService ?? new UsageSettlementService(store, fallbackSettlementSender, {}, alertingService);
  const usageSettlementIntervalMs = Number(process.env.USAGE_SETTLEMENT_INTERVAL_MS ?? '30000');
  const usageSettlementEnabled = process.env.USAGE_SETTLEMENT_ENABLED === 'true';
  const usageSettlementScheduler = new UsageSettlementScheduler(usageSettlementService, usageSettlementIntervalMs);
  if (usageSettlementEnabled) {
    usageSettlementScheduler.start();
  }

  const covenantMonitorEnabled = process.env.COVENANT_MONITOR_ENABLED === 'true';
  const covenantMonitorIntervalMs = Number(process.env.COVENANT_MONITOR_INTERVAL_MS ?? '900000');
  const covenantFacetAddress = process.env.COVENANT_FACET_ADDRESS ?? process.env.DIAMOND_ADDRESS;
  let covenantMonitorScheduler: CovenantMonitorScheduler | undefined;
  if (
    covenantMonitorEnabled &&
    process.env.RPC_URL &&
    process.env.RELAYER_PRIVATE_KEY &&
    covenantFacetAddress
  ) {
    const provider = new JsonRpcProvider(process.env.RPC_URL);
    const signer = new Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
    const service = new CovenantMonitorService(store, provider, signer, covenantFacetAddress, {
      logger: console,
    });
    covenantMonitorScheduler = new CovenantMonitorScheduler(service, covenantMonitorIntervalMs);
    covenantMonitorScheduler.start();
  } else if (covenantMonitorEnabled) {
    // eslint-disable-next-line no-console
    console.warn(
      '[covenant-monitor] scheduler enabled but missing one of RPC_URL, RELAYER_PRIVATE_KEY, or COVENANT_FACET_ADDRESS/DIAMOND_ADDRESS'
    );
  }

  const interestAccrualEnabled = process.env.INTEREST_ACCRUAL_ENABLED === 'true';
  const interestAccrualIntervalMs = Number(process.env.INTEREST_ACCRUAL_INTERVAL_MS ?? '3600000');
  const interestAccrualThresholdSeconds = Number(process.env.INTEREST_ACCRUAL_THRESHOLD_SECONDS ?? '3600');
  const interestFacetAddress = process.env.INTEREST_FACET_ADDRESS ?? process.env.DIAMOND_ADDRESS;
  let interestAccrualScheduler: InterestAccrualScheduler | undefined;
  if (
    interestAccrualEnabled &&
    process.env.RPC_URL &&
    process.env.RELAYER_PRIVATE_KEY &&
    interestFacetAddress
  ) {
    const provider = new JsonRpcProvider(process.env.RPC_URL);
    const signer = new Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
    const service = new InterestAccrualService(store, provider, signer, interestFacetAddress, {
      accrualThresholdSeconds: interestAccrualThresholdSeconds,
      logger: console,
    });
    interestAccrualScheduler = new InterestAccrualScheduler(service, interestAccrualIntervalMs);
    interestAccrualScheduler.start();
  } else if (interestAccrualEnabled) {
    // eslint-disable-next-line no-console
    console.warn(
      '[interest-accrual] scheduler enabled but missing one of RPC_URL, RELAYER_PRIVATE_KEY, or INTEREST_FACET_ADDRESS/DIAMOND_ADDRESS'
    );
  }

  const delinquencyMonitorEnabled = process.env.DELINQUENCY_MONITOR_ENABLED === 'true';
  const delinquencyMonitorIntervalMs = Number(process.env.DELINQUENCY_MONITOR_INTERVAL_MS ?? '900000');
  const riskFacetAddress = process.env.RISK_FACET_ADDRESS ?? process.env.DIAMOND_ADDRESS;
  const agreementFacetAddress = process.env.AGREEMENT_FACET_ADDRESS ?? process.env.DIAMOND_ADDRESS;
  let delinquencyMonitor: DelinquencyMonitor | undefined;
  if (
    delinquencyMonitorEnabled &&
    process.env.RPC_URL &&
    process.env.RELAYER_PRIVATE_KEY &&
    riskFacetAddress &&
    agreementFacetAddress
  ) {
    const provider = new JsonRpcProvider(process.env.RPC_URL);
    const signer = new Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
    delinquencyMonitor = new DelinquencyMonitor(
      provider,
      signer,
      riskFacetAddress,
      agreementFacetAddress,
      delinquencyMonitorIntervalMs
    );
    delinquencyMonitor.start();
  } else if (delinquencyMonitorEnabled) {
    // eslint-disable-next-line no-console
    console.warn(
      '[delinquency-monitor] scheduler enabled but missing one of RPC_URL, RELAYER_PRIVATE_KEY, RISK_FACET_ADDRESS/DIAMOND_ADDRESS, or AGREEMENT_FACET_ADDRESS/DIAMOND_ADDRESS'
    );
  }

  const buildOptions = {
    ...(phase2?.eventListener ? { eventListener: phase2.eventListener } : {}),
    ...(phase2?.txSubmitter ? { txSubmitter: phase2.txSubmitter } : {}),
    ...(phase2?.providerEventIngress ? { providerEventIngress: phase2.providerEventIngress } : {}),
    ...(phase2?.activationContextResolver ? { activationContextResolver: phase2.activationContextResolver } : {}),
    ...(delinquencyMonitor ? { delinquencyMonitor } : {}),
  };

  const app = buildApp(
    store,
    providerRegistry,
    meteringWorker,
    meteringScheduler,
    killSwitchService,
    killSwitchRetryScheduler,
    usageSettlementService,
    usageSettlementScheduler,
    buildOptions
  );

  app.addHook('onClose', async () => {
    meteringScheduler.stop();
    killSwitchRetryScheduler.stop();
    usageSettlementScheduler.stop();
    covenantMonitorScheduler?.stop();
    interestAccrualScheduler?.stop();
    delinquencyMonitor?.stop();
  });

  const port = Number(process.env.PORT ?? '3000');
  const host = process.env.HOST ?? '0.0.0.0';

  await app.listen({ port, host });

  if (phase2?.eventListener) {
    await phase2.eventListener.start();
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info({ signal }, 'shutdown signal received');

    try {
      if (phase2?.eventListener) {
        await phase2.eventListener.stop();
      }

      if (phase2?.txSubmitter) {
        await phase2.txSubmitter.waitForIdle();
      }
    } finally {
      await app.close();
    }
  };

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').finally(() => process.exit(0));
  });

  process.once('SIGINT', () => {
    void shutdown('SIGINT').finally(() => process.exit(0));
  });
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
