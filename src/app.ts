import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { canonicalEnvelopeSchema, ackSchema } from './schema';
import { InMemoryMessageStore } from './store';
import { StoredMessage } from './types';
import { ComputeAdapterRegistry, createDefaultComputeAdapterRegistry } from './providers';

export function buildApp(
  store = new InMemoryMessageStore(),
  providerRegistry: ComputeAdapterRegistry = createDefaultComputeAdapterRegistry()
) {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ ok: true }));

  app.get('/providers', async () => ({ providers: providerRegistry.list() }));

  app.post('/messages', async (request, reply) => {
    const parsed = canonicalEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const message: StoredMessage = {
      id: randomUUID(),
      envelope: parsed.data,
      status: 'queued',
    };

    store.save(message);
    return reply.status(201).send(message);
  });

  app.get('/messages/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const message = store.get(id);

    if (!message) {
      return reply.status(404).send({ error: 'message_not_found' });
    }

    return message;
  });

  app.post('/deliveries/:id/ack', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = ackSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const updated = store.update(id, (existing) => ({
      ...existing,
      status: 'delivered',
      deliveredAt: new Date().toISOString(),
      ack: {
        at: new Date().toISOString(),
        ...(parsed.data.provider ? { provider: parsed.data.provider } : {}),
        ...(parsed.data.meta ? { meta: parsed.data.meta } : {}),
      },
    }));

    if (!updated) {
      return reply.status(404).send({ error: 'message_not_found' });
    }

    return updated;
  });

  return app;
}
