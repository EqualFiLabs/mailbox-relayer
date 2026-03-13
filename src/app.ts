import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { MailboxCompat } from './mailbox';
import { canonicalEnvelopeSchema, ackSchema, demoVerticalFlowSchema } from './schema';
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

  app.post('/demo/vertical-flow', async (request, reply) => {
    const parsed = demoVerticalFlowSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const provider = parsed.data.provider;
    const adapter = providerRegistry.get(provider);

    if (!adapter) {
      return reply.status(400).send({ error: 'provider_not_supported' });
    }

    const agreementId = parsed.data.agreementId ?? randomUUID();
    const traceId = parsed.data.traceId ?? `trace-${randomUUID()}`;

    const borrower = MailboxCompat.generateKeys();
    const node = MailboxCompat.generateKeys();

    // Borrower request payload -> encrypted for orchestration node
    const borrowerRequestPayload = {
      kind: 'borrower_payload',
      agreementId,
      provider,
      requestedUnitType: 'GPU_HOUR_A100',
      traceId,
      env: {
        model: provider === 'venice' ? 'zai-org-glm-5' : 'mock-model',
      },
    };

    const encryptedBorrowerRequest = await MailboxCompat.encryptPayload(node.compressedPublicKey, borrowerRequestPayload);
    const borrowerCipher = MailboxCompat.parseEnvelope(encryptedBorrowerRequest);

    const borrowerMessage: StoredMessage = {
      id: randomUUID(),
      status: 'queued',
      envelope: {
        version: 'equalfi.mailbox.ecies.eth-crypto.v1',
        recipient: `orchestrator:${provider}`,
        cipher: borrowerCipher,
        createdAt: new Date().toISOString(),
        traceId,
      },
    };

    store.save(borrowerMessage);

    // Node decrypts borrower payload and invokes provider adapter stub
    const decryptedBorrowerPayload = JSON.parse(
      await MailboxCompat.decryptPayload(node.privateKey, encryptedBorrowerRequest)
    ) as Record<string, unknown>;

    const provision = await adapter.provision({
      agreementId,
      traceId,
      payload: decryptedBorrowerPayload,
      policy: { mode: 'mock' },
    });

    // Provider callback payload -> encrypted for borrower
    const providerCallbackPayload = {
      kind: 'provider_payload',
      agreementId,
      provider,
      traceId,
      provision,
      callbackRecorded: true,
    };

    const encryptedProviderCallback = await MailboxCompat.encryptPayload(
      borrower.compressedPublicKey,
      providerCallbackPayload
    );
    const providerCipher = MailboxCompat.parseEnvelope(encryptedProviderCallback);

    const providerMessage: StoredMessage = {
      id: randomUUID(),
      status: 'queued',
      envelope: {
        version: 'equalfi.mailbox.ecies.eth-crypto.v1',
        recipient: 'borrower:session-wallet',
        cipher: providerCipher,
        createdAt: new Date().toISOString(),
        traceId,
      },
    };

    store.save(providerMessage);

    const acked = store.update(providerMessage.id, (existing) => ({
      ...existing,
      status: 'delivered',
      deliveredAt: new Date().toISOString(),
      ack: {
        at: new Date().toISOString(),
        provider,
        meta: {
          agreementId,
          traceId,
          callbackKind: 'provider_payload',
        },
      },
    }));

    const decryptedProviderCallback = JSON.parse(
      await MailboxCompat.decryptPayload(borrower.privateKey, encryptedProviderCallback)
    ) as Record<string, unknown>;

    return reply.send({
      agreementId,
      traceId,
      provider,
      requestMessageId: borrowerMessage.id,
      callbackMessageId: providerMessage.id,
      providerResultStatus: provision.status,
      callbackRecorded: Boolean(acked),
      decryptedCallbackPreview: decryptedProviderCallback,
      mockKeys: {
        borrowerCompressedPublicKey: borrower.compressedPublicKey,
        nodeCompressedPublicKey: node.compressedPublicKey,
      },
    });
  });

  return app;
}
