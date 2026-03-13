import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { InMemoryMessageStore } from './store';
import { StoredMessage } from './types';

const app = Fastify({ logger: true });
const store = new InMemoryMessageStore();

const createMessageSchema = z.object({
  recipient: z.string().min(1),
  payload: z.string().min(1),
  traceId: z.string().min(1).optional(),
  expiresAt: z.string().datetime().optional(),
});

const ackSchema = z.object({
  provider: z.string().min(1).optional(),
  meta: z.record(z.unknown()).optional(),
});

app.get('/health', async () => ({ ok: true }));

app.post('/messages', async (request, reply) => {
  const parsed = createMessageSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const now = new Date().toISOString();
  const message: StoredMessage = {
    id: randomUUID(),
    recipient: parsed.data.recipient,
    payload: parsed.data.payload,
    createdAt: now,
    status: 'queued',
    ...(parsed.data.traceId ? { traceId: parsed.data.traceId } : {}),
    ...(parsed.data.expiresAt ? { expiresAt: parsed.data.expiresAt } : {}),
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

const port = Number(process.env.PORT ?? '3000');
const host = process.env.HOST ?? '0.0.0.0';

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
