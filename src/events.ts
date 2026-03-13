import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { onchainEventSchema } from './schema';
import { AgreementStateRecord, MessageStore } from './store';
import { StoredMessage } from './types';
import { ComputeAdapterRegistry, ComputeProvider } from './providers';
import { DeterministicMeteringWorker } from './metering';
import { KillSwitchEnforcementService } from './killswitch';

export type OnchainEvent = z.infer<typeof onchainEventSchema>;

export interface OnchainIngestionResult {
  accepted: boolean;
  deduped: boolean;
  eventKey: string;
  eventType: OnchainEvent['eventType'];
  agreementId: string;
  provider?: ComputeProvider;
  action: string;
  message?: string;
  meta?: Record<string, unknown>;
}

export class OnchainEventIngestionWorker {
  constructor(
    private readonly store: MessageStore,
    private readonly providers: ComputeAdapterRegistry,
    private readonly meteringWorker?: DeterministicMeteringWorker,
    private readonly killSwitchService?: KillSwitchEnforcementService
  ) {}

  async ingest(event: OnchainEvent): Promise<OnchainIngestionResult> {
    const eventKey = this.toEventKey(event);
    if (this.store.isEventProcessed(eventKey)) {
      return {
        accepted: true,
        deduped: true,
        eventKey,
        eventType: event.eventType,
        agreementId: event.agreementId,
        ...(event.provider ? { provider: event.provider } : {}),
        action: 'dedupe_skip',
      };
    }

    let result: OnchainIngestionResult;

    if (event.eventType === 'mailbox') {
      result = await this.handleMailboxEvent(event, eventKey);
    } else if (event.eventType === 'activation') {
      result = await this.handleActivationEvent(event, eventKey);
    } else {
      result = await this.handleBreachOrDefaultEvent(event, eventKey);
    }

    // Persist dedupe marker only after a successful acceptance path.
    if (result.accepted) {
      const marked = this.store.markEventProcessed(eventKey, event.blockNumber, event.logIndex);
      if (!marked) {
        return {
          accepted: true,
          deduped: true,
          eventKey,
          eventType: event.eventType,
          agreementId: event.agreementId,
          ...(event.provider ? { provider: event.provider } : {}),
          action: 'dedupe_skip',
          message: 'event already processed concurrently',
        };
      }
    }

    return result;
  }

  async ingestMany(events: OnchainEvent[]): Promise<OnchainIngestionResult[]> {
    const out: OnchainIngestionResult[] = [];
    for (const event of events) {
      out.push(await this.ingest(event));
    }
    return out;
  }

  private async handleMailboxEvent(event: OnchainEvent, eventKey: string): Promise<OnchainIngestionResult> {
    if (!event.envelope) {
      return {
        accepted: false,
        deduped: false,
        eventKey,
        eventType: event.eventType,
        agreementId: event.agreementId,
        ...(event.provider ? { provider: event.provider } : {}),
        action: 'rejected',
        message: 'mailbox events require envelope payload',
      };
    }

    const envelope = {
      version: event.envelope.version,
      recipient: event.envelope.recipient,
      cipher: event.envelope.cipher,
      createdAt: event.envelope.createdAt,
      ...(event.envelope.expiresAt ? { expiresAt: event.envelope.expiresAt } : {}),
      ...(event.traceId ? { traceId: event.traceId } : {}),
    };

    const message: StoredMessage = {
      id: randomUUID(),
      status: 'queued',
      envelope,
    };

    this.store.save(message);
    this.store.setAgreementState(this.toStateRecord(event.agreementId, 'mailbox_received', event.traceId));

    return {
      accepted: true,
      deduped: false,
      eventKey,
      eventType: event.eventType,
      agreementId: event.agreementId,
      ...(event.provider ? { provider: event.provider } : {}),
      action: 'mailbox_queued',
      meta: { messageId: message.id },
    };
  }

  private async handleActivationEvent(event: OnchainEvent, eventKey: string): Promise<OnchainIngestionResult> {
    const provider = event.provider ?? this.store.getProviderLink(event.agreementId)?.provider;

    if (!provider) {
      return {
        accepted: false,
        deduped: false,
        eventKey,
        eventType: event.eventType,
        agreementId: event.agreementId,
        action: 'rejected',
        message: 'activation event missing provider',
      };
    }

    const adapter = this.providers.get(provider);

    if (!adapter) {
      return {
        accepted: false,
        deduped: false,
        eventKey,
        eventType: event.eventType,
        agreementId: event.agreementId,
        provider,
        action: 'rejected',
        message: 'provider_not_supported',
      };
    }

    const provision = await adapter.provision({
      agreementId: event.agreementId,
      ...(event.traceId ? { traceId: event.traceId } : {}),
      ...(event.policy ? { policy: event.policy } : {}),
      ...(event.payload ? { payload: event.payload } : {}),
    });

    if (provision.providerResourceId) {
      this.store.setProviderLink({
        agreementId: event.agreementId,
        provider,
        providerResourceId: provision.providerResourceId,
        updatedAt: new Date().toISOString(),
      });
    }

    this.store.setAgreementState(
      this.toStateRecord(event.agreementId, provision.status === 'ok' ? 'active' : 'activation_failed', event.traceId)
    );

    return {
      accepted: true,
      deduped: false,
      eventKey,
      eventType: event.eventType,
      agreementId: event.agreementId,
      provider,
      action: 'activation_processed',
      meta: {
        providerResultStatus: provision.status,
        ...(provision.providerResourceId ? { providerResourceId: provision.providerResourceId } : {}),
      },
    };
  }

  private async handleBreachOrDefaultEvent(event: OnchainEvent, eventKey: string): Promise<OnchainIngestionResult> {
    const provider = event.provider ?? this.store.getProviderLink(event.agreementId)?.provider;
    const state = event.eventType === 'breach' ? 'breach_detected' : 'default_detected';

    const finalMetering = this.meteringWorker
      ? await this.meteringWorker.runForAgreement(event.agreementId, { finalPass: true })
      : undefined;

    this.store.setAgreementState(this.toStateRecord(event.agreementId, state, event.traceId));

    if (this.killSwitchService) {
      const ks = await this.killSwitchService.enforce({
        agreementId: event.agreementId,
        eventType: event.eventType as 'breach' | 'default',
        ...(event.reason ? { reason: event.reason } : {}),
        ...(provider ? { provider } : {}),
        sourceEventKey: eventKey,
      });

      return {
        accepted: true,
        deduped: false,
        eventKey,
        eventType: event.eventType,
        agreementId: event.agreementId,
        ...(provider ? { provider } : {}),
        action: ks.action === 'termination_attempted' ? 'termination_attempted' : 'kill_switch_frozen',
        meta: {
          drawFrozen: ks.drawFrozen,
          ...(ks.attempt
            ? {
                terminationAttempt: {
                  attempt: ks.attempt.attempt,
                  status: ks.attempt.status,
                  terminated: ks.attempt.terminated,
                  ...(ks.attempt.nextRetryAt ? { nextRetryAt: ks.attempt.nextRetryAt } : {}),
                },
              }
            : {}),
          ...(finalMetering
            ? {
                finalMetering: {
                  status: finalMetering.status,
                  usageRows: finalMetering.usageRows,
                  preparedItems: finalMetering.aggregatedItems.length,
                  ...(finalMetering.submissionId ? { submissionId: finalMetering.submissionId } : {}),
                },
              }
            : {}),
        },
      };
    }

    if (!provider) {
      return {
        accepted: true,
        deduped: false,
        eventKey,
        eventType: event.eventType,
        agreementId: event.agreementId,
        action: 'kill_switch_frozen',
      };
    }

    const adapter = this.providers.get(provider);
    if (!adapter) {
      return {
        accepted: false,
        deduped: false,
        eventKey,
        eventType: event.eventType,
        agreementId: event.agreementId,
        provider,
        action: 'rejected',
        message: 'provider_not_supported',
      };
    }

    const providerResourceId = this.store.getProviderLink(event.agreementId)?.providerResourceId;

    const terminated = await adapter.terminate({
      agreementId: event.agreementId,
      ...(providerResourceId ? { providerResourceId } : {}),
      reason: event.reason ?? event.eventType,
    });

    return {
      accepted: true,
      deduped: false,
      eventKey,
      eventType: event.eventType,
      agreementId: event.agreementId,
      provider,
      action: 'termination_attempted',
      meta: {
        terminated: terminated.terminated,
        providerResultStatus: terminated.status,
        ...(finalMetering
          ? {
              finalMetering: {
                status: finalMetering.status,
                usageRows: finalMetering.usageRows,
                preparedItems: finalMetering.aggregatedItems.length,
                ...(finalMetering.submissionId ? { submissionId: finalMetering.submissionId } : {}),
              },
            }
          : {}),
      },
      ...(terminated.message ? { message: terminated.message } : {}),
    };
  }

  private toStateRecord(
    agreementId: string,
    state: AgreementStateRecord['state'],
    traceId?: string
  ): AgreementStateRecord {
    return {
      agreementId,
      state,
      updatedAt: new Date().toISOString(),
      ...(traceId ? { traceId } : {}),
    };
  }

  private toEventKey(event: OnchainEvent): string {
    return `${event.chainId}:${event.blockNumber}:${event.logIndex}`;
  }
}
