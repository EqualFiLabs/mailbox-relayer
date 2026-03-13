import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { MailboxCompat } from './mailbox';
import {
  canonicalEnvelopeSchema,
  ackSchema,
  demoVerticalFlowSchema,
  onchainEventBatchSchema,
  onchainEventSchema,
} from './schema';
import { createDefaultStore, MessageStore } from './store';
import { StoredMessage } from './types';
import { ComputeAdapterRegistry, createDefaultComputeAdapterRegistry } from './providers';
import { OnchainEventIngestionWorker } from './events';
import { DeterministicMeteringWorker, MeteringScheduler } from './metering';
import { KillSwitchEnforcementService, KillSwitchRetryScheduler } from './killswitch';
import {
  DisabledUsageSettlementSender,
  UsageSettlementScheduler,
  UsageSettlementService,
} from './settlement';

export function buildApp(
  store: MessageStore = createDefaultStore(),
  providerRegistry: ComputeAdapterRegistry = createDefaultComputeAdapterRegistry(),
  meteringWorker: DeterministicMeteringWorker = new DeterministicMeteringWorker(store, providerRegistry),
  meteringScheduler?: MeteringScheduler,
  killSwitchService: KillSwitchEnforcementService = new KillSwitchEnforcementService(store, providerRegistry),
  killSwitchRetryScheduler?: KillSwitchRetryScheduler,
  usageSettlementService: UsageSettlementService = new UsageSettlementService(
    store,
    new DisabledUsageSettlementSender()
  ),
  usageSettlementScheduler?: UsageSettlementScheduler
) {
  const app = Fastify({ logger: true });

  const requireAdminAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = process.env.ADMIN_AUTH_TOKEN;
    if (token) {
      const auth = request.headers.authorization;
      if (auth !== `Bearer ${token}`) {
        return reply.status(401).send({ error: 'unauthorized' });
      }
    }
  };

  app.addHook('preHandler', async (request) => {
    if (request.body && typeof request.body === 'object') {
      const body = request.body as Record<string, unknown>;
      const traceId = typeof body.traceId === 'string' ? body.traceId : undefined;
      const agreementId = typeof body.agreementId === 'string' ? body.agreementId : undefined;

      if (traceId || agreementId) {
        request.log = request.log.child({
          ...(traceId ? { traceId } : {}),
          ...(agreementId ? { agreementId } : {}),
        });
      }
    }
  });

  const onchainWorker = new OnchainEventIngestionWorker(store, providerRegistry, meteringWorker, killSwitchService);

  app.get('/health', async () => ({ ok: true }));

  app.get('/providers', async () => ({ providers: providerRegistry.list() }));

  app.post('/events/onchain', async (request, reply) => {
    const singleParsed = onchainEventSchema.safeParse(request.body);

    let events;
    if (singleParsed.success) {
      events = [singleParsed.data];
    } else {
      const batchParsed = onchainEventBatchSchema.safeParse(request.body);
      if (!batchParsed.success) {
        return reply.status(400).send({
          error: 'invalid_onchain_event_payload',
          details: {
            single: singleParsed.error.flatten(),
            batch: batchParsed.error.flatten(),
          },
        });
      }
      events = batchParsed.data.events;
    }

    const results = await onchainWorker.ingestMany(events);

    return reply.send({
      accepted: results.filter((r) => r.accepted).length,
      deduped: results.filter((r) => r.deduped).length,
      rejected: results.filter((r) => !r.accepted).length,
      results,
    });
  });

  app.get('/agreements/:agreementId/state', async (request, reply) => {
    const { agreementId } = request.params as { agreementId: string };
    const state = store.getAgreementState(agreementId);

    if (!state) {
      return reply.status(404).send({ error: 'agreement_state_not_found' });
    }

    return state;
  });

  app.get('/agreements/:agreementId/draw-eligibility', async (request) => {
    const { agreementId } = request.params as { agreementId: string };
    const killSwitch = store.getKillSwitch(agreementId);

    return {
      agreementId,
      drawAllowed: killSwitch ? !killSwitch.active : true,
      ...(killSwitch ? { killSwitch } : {}),
    };
  });

  app.post('/killswitch/retries/run', { preHandler: [requireAdminAuth] }, async (request) => {
    const body = (request.body ?? {}) as { limit?: number };
    const limit = body.limit && Number.isFinite(body.limit) ? Math.min(Math.max(1, body.limit), 200) : 20;

    return killSwitchService.runDueRetries(limit);
  });

  app.get('/killswitch/active', async (request) => {
    const query = request.query as { limit?: string };
    const rawLimit = query?.limit ? Number(query.limit) : 20;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 20;

    return {
      switches: store.listActiveKillSwitches(limit),
    };
  });

  app.get('/killswitch/attempts', async (request) => {
    const query = request.query as { agreementId?: string; limit?: string };
    const rawLimit = query?.limit ? Number(query.limit) : 50;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50;

    return {
      attempts: store.listTerminationAttempts(query.agreementId, limit),
    };
  });

  app.post('/metering/run', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const body = (request.body ?? {}) as { agreementId?: string; finalPass?: boolean; to?: string };

    if (body.to && Number.isNaN(Date.parse(body.to))) {
      return reply.status(400).send({ error: 'invalid_to_timestamp' });
    }

    if (body.agreementId) {
      const result = await meteringWorker.runForAgreement(body.agreementId, {
        ...(body.finalPass !== undefined ? { finalPass: body.finalPass } : {}),
        ...(body.to ? { to: body.to } : {}),
      });

      return reply.send({
        agreementsScanned: 1,
        preparedCount: result.status === 'prepared' ? 1 : 0,
        results: [result],
      });
    }

    const result = await meteringWorker.runOnce({
      ...(body.finalPass !== undefined ? { finalPass: body.finalPass } : {}),
      ...(body.to ? { to: body.to } : {}),
    });

    return reply.send(result);
  });

  app.get('/metering/submissions', async (request) => {
    const query = request.query as { limit?: string };
    const rawLimit = query?.limit ? Number(query.limit) : 20;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 20;

    return {
      submissions: store.listUsageSubmissions(limit).map((submission) => ({
        ...submission,
        settlement: store.getLatestUsageSettlementAttempt(submission.id) ?? null,
      })),
    };
  });

  app.post('/settlement/run', { preHandler: [requireAdminAuth] }, async (request) => {
    const body = (request.body ?? {}) as { submissionId?: string; limitUnattempted?: number; limitRetries?: number };

    if (body.submissionId) {
      const attempt = await usageSettlementService.runForSubmission(body.submissionId);
      if (!attempt) {
        return {
          processed: 0,
          settled: 0,
          failed: 0,
          results: [],
          error: 'submission_not_found',
        };
      }

      return {
        processed: 1,
        settled: attempt.settled ? 1 : 0,
        failed: attempt.settled ? 0 : 1,
        results: [attempt],
      };
    }

    const limitUnattempted =
      body.limitUnattempted && Number.isFinite(body.limitUnattempted)
        ? Math.min(Math.max(1, body.limitUnattempted), 200)
        : 20;
    const limitRetries =
      body.limitRetries && Number.isFinite(body.limitRetries) ? Math.min(Math.max(1, body.limitRetries), 200) : 20;

    return usageSettlementService.run(limitUnattempted, limitRetries);
  });

  app.get('/settlement/attempts', async (request) => {
    const query = request.query as { submissionId?: string; limit?: string };
    const rawLimit = query?.limit ? Number(query.limit) : 50;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50;

    return {
      attempts: store.listUsageSettlementAttempts(query.submissionId, limit),
    };
  });

  app.get('/metering/status', async () => ({
    scheduler: meteringScheduler?.status() ?? { enabled: false, intervalMs: 0 },
    killSwitchRetryScheduler: killSwitchRetryScheduler?.status() ?? { enabled: false, intervalMs: 0 },
    usageSettlementScheduler: usageSettlementScheduler?.status() ?? { enabled: false, intervalMs: 0 },
  }));

  app.post('/messages', async (request, reply) => {
    const parsed = canonicalEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const envelope = {
      version: parsed.data.version,
      recipient: parsed.data.recipient,
      cipher: parsed.data.cipher,
      createdAt: parsed.data.createdAt,
      ...(parsed.data.expiresAt ? { expiresAt: parsed.data.expiresAt } : {}),
      ...(parsed.data.traceId ? { traceId: parsed.data.traceId } : {}),
    };

    const message: StoredMessage = {
      id: randomUUID(),
      envelope,
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

    if (provision.providerResourceId) {
      store.setProviderLink({
        agreementId,
        provider,
        providerResourceId: provision.providerResourceId,
        updatedAt: new Date().toISOString(),
      });
    }

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

    store.setUsageCheckpoint({
      agreementId,
      provider,
      lastUsageTimestamp: new Date().toISOString(),
      lastUsageDigest: `demo-${traceId}`,
      updatedAt: new Date().toISOString(),
    });

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
