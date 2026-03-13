import { buildApp } from './app';
import { createDefaultStore } from './store';
import { createDefaultComputeAdapterRegistry } from './providers';
import { DeterministicMeteringWorker, MeteringScheduler } from './metering';

const store = createDefaultStore();
const providerRegistry = createDefaultComputeAdapterRegistry();
const meteringWorker = new DeterministicMeteringWorker(store, providerRegistry);

const intervalMs = Number(process.env.METERING_INTERVAL_MS ?? '30000');
const meteringEnabled = process.env.METERING_ENABLED === 'true';

const meteringScheduler = new MeteringScheduler(meteringWorker, intervalMs);
if (meteringEnabled) {
  meteringScheduler.start();
}

const app = buildApp(store, providerRegistry, meteringWorker, meteringScheduler);

app.addHook('onClose', async () => {
  meteringScheduler.stop();
});

const port = Number(process.env.PORT ?? '3000');
const host = process.env.HOST ?? '0.0.0.0';

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
