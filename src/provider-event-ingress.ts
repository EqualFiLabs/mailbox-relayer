import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MessageStore } from './store';

export interface ProviderEventIngressStatus {
  enabled: boolean;
  lastAcceptedAt?: string;
}

export interface ProviderEventIngressConfig {
  authToken?: string;
  now?: () => string;
  routePath?: string;
}

interface ProviderEventIngressLogger {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
}

const providerEventPayloadSchema = z.object({
  provider: z.enum(['lambda', 'runpod', 'venice', 'bankr']),
  providerResourceId: z.string().min(1),
  externalEventId: z.string().min(1),
  payload: z.record(z.unknown()),
  observedAt: z.string().datetime().optional(),
  traceId: z.string().min(1).optional(),
});

export class ProviderEventIngress {
  private readonly authToken: string | undefined;
  private readonly now: () => string;
  private readonly routePath: string;
  private lastAcceptedAt: string | undefined;

  constructor(
    private readonly store: MessageStore,
    config: ProviderEventIngressConfig = {},
    private readonly logger: ProviderEventIngressLogger = console
  ) {
    this.authToken = config.authToken;
    this.now = config.now ?? (() => new Date().toISOString());
    this.routePath = config.routePath ?? '/events/provider';
  }

  async register(app: FastifyInstance): Promise<void> {
    app.post(this.routePath, async (request, reply) => this.handleEvent(request, reply));
  }

  status(): ProviderEventIngressStatus {
    return {
      enabled: Boolean(this.authToken),
      ...(this.lastAcceptedAt ? { lastAcceptedAt: this.lastAcceptedAt } : {}),
    };
  }

  private async handleEvent(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    if (!this.authToken) {
      return reply.status(503).send({ error: 'provider_event_ingress_disabled' });
    }

    const auth = request.headers.authorization;
    if (auth !== `Bearer ${this.authToken}`) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const parsed = providerEventPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_provider_event_payload', details: parsed.error.flatten() });
    }

    const nowIso = this.now();
    const observedAt = parsed.data.observedAt ?? nowIso;
    const traceIdHeader = request.headers['x-trace-id'];
    const headerTraceId = typeof traceIdHeader === 'string' ? traceIdHeader : undefined;
    const traceId = parsed.data.traceId ?? headerTraceId;

    const inserted = this.store.upsertProviderEvent({
      provider: parsed.data.provider,
      providerResourceId: parsed.data.providerResourceId,
      externalEventId: parsed.data.externalEventId,
      payloadJson: JSON.stringify(parsed.data.payload),
      observedAt,
      createdAt: nowIso,
    });

    this.lastAcceptedAt = nowIso;

    const logPayload = {
      provider: parsed.data.provider,
      providerResourceId: parsed.data.providerResourceId,
      externalEventId: parsed.data.externalEventId,
      observedAt,
      ...(traceId ? { traceId } : {}),
      deduped: !inserted,
    };

    if (inserted) {
      this.logger.info?.(logPayload, 'provider callback persisted');
    } else {
      this.logger.info?.(logPayload, 'provider callback duplicate acknowledged');
    }

    return reply.status(202).send({ ok: true, deduped: !inserted });
  }
}
