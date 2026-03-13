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

const store = createDefaultStore();
const providerRegistry = createDefaultComputeAdapterRegistry();

const alertingService = new AlertingService(
  process.env.ALERT_WEBHOOK_URL
    ? new WebhookAlertSender(process.env.ALERT_WEBHOOK_URL, process.env.ALERT_WEBHOOK_TOKEN)
    : new DisabledAlertSender()
);

const meteringWorker = new DeterministicMeteringWorker(store, providerRegistry, undefined, alertingService);
const meteringIntervalMs = Number(process.env.METERING_INTERVAL_MS ?? '30000');
const meteringEnabled = process.env.METERING_ENABLED === 'true';
const meteringScheduler = new MeteringScheduler(meteringWorker, meteringIntervalMs);
if (meteringEnabled) {
  meteringScheduler.start();
}

const killSwitchService = new KillSwitchEnforcementService(store, providerRegistry, {}, alertingService);
const killSwitchRetryIntervalMs = Number(process.env.KILLSWITCH_RETRY_INTERVAL_MS ?? '30000');
const killSwitchRetryEnabled = process.env.KILLSWITCH_RETRY_ENABLED === 'true';
const killSwitchRetryScheduler = new KillSwitchRetryScheduler(killSwitchService, killSwitchRetryIntervalMs);
if (killSwitchRetryEnabled) {
  killSwitchRetryScheduler.start();
}

const settlementSender = process.env.USAGE_SETTLEMENT_WEBHOOK_URL
  ? new WebhookUsageSettlementSender(
      process.env.USAGE_SETTLEMENT_WEBHOOK_URL,
      process.env.USAGE_SETTLEMENT_WEBHOOK_TOKEN
    )
  : new DisabledUsageSettlementSender();

const usageSettlementService = new UsageSettlementService(store, settlementSender, {}, alertingService);
const usageSettlementIntervalMs = Number(process.env.USAGE_SETTLEMENT_INTERVAL_MS ?? '30000');
const usageSettlementEnabled = process.env.USAGE_SETTLEMENT_ENABLED === 'true';
const usageSettlementScheduler = new UsageSettlementScheduler(usageSettlementService, usageSettlementIntervalMs);
if (usageSettlementEnabled) {
  usageSettlementScheduler.start();
}

const app = buildApp(
  store,
  providerRegistry,
  meteringWorker,
  meteringScheduler,
  killSwitchService,
  killSwitchRetryScheduler,
  usageSettlementService,
  usageSettlementScheduler
);

app.addHook('onClose', async () => {
  meteringScheduler.stop();
  killSwitchRetryScheduler.stop();
  usageSettlementScheduler.stop();
});

const port = Number(process.env.PORT ?? '3000');
const host = process.env.HOST ?? '0.0.0.0';

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
