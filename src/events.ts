import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { onchainEventSchema } from './schema';
import { AgreementStateRecord, MessageStore, ProviderResourceLink } from './store';
import { StoredMessage } from './types';
import { ComputeAdapterRegistry, ComputeProvider } from './providers';
import { DeterministicMeteringWorker } from './metering';
import { KillSwitchEnforcementService } from './killswitch';
import { verifyIdentityProof } from './identity-resolver';
import { isAddress } from 'ethers';

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

export interface IdentityGateConfig {
  mode: 'none' | 'erc8004_offchain';
  targetChainId?: number;
  diamondAddress?: string;
  erc8004ChainId?: number;
  erc8004RpcUrl?: string;
  erc8004RegistryAddress?: string;
  proofMaxSkewSeconds?: number;
  resolveWallet?: (agentRegistry: string, agentId: string) => Promise<string>;
}

export interface ProviderPayloadPublisher {
  publishProviderPayload(
    agreementId: string,
    providerCredentials: Record<string, unknown>,
    borrowerAddress: string
  ): Promise<{ txHash?: string; error?: string }>;
}

export class OnchainEventIngestionWorker {
  constructor(
    private readonly store: MessageStore,
    private readonly providers: ComputeAdapterRegistry,
    private readonly meteringWorker?: DeterministicMeteringWorker,
    private readonly killSwitchService?: KillSwitchEnforcementService,
    private readonly identityGate: IdentityGateConfig = { mode: 'none' },
    private readonly txSubmitter?: ProviderPayloadPublisher
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
    } else if (event.eventType === 'agreement_closed') {
      result = this.handleAgreementClosedEvent(event, eventKey);
    } else {
      result = await this.handleRiskEvent(event, eventKey);
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
    // Canonical routing source for activation is on-chain provider from the event payload.
    const provider = event.provider;

    if (!provider) {
      return {
        accepted: false,
        deduped: false,
        eventKey,
        eventType: event.eventType,
        agreementId: event.agreementId,
        action: 'rejected',
        message: 'activation event missing canonical provider',
      };
    }

    const identityCheck = await this.verifyActivationIdentity(event);
    if (!identityCheck.ok) {
      this.store.setAgreementState(this.toStateRecord(event.agreementId, 'activation_failed', event.traceId));
      return {
        accepted: false,
        deduped: false,
        eventKey,
        eventType: event.eventType,
        agreementId: event.agreementId,
        provider,
        action: 'rejected',
        message: 'identity_verification_failed',
        meta: {
          reason: identityCheck.reason,
        },
      };
    }

    const overrideAttempt = this.readProviderOverride(event.policy, event.payload);
    if (overrideAttempt && overrideAttempt !== provider) {
      this.store.setAgreementState(this.toStateRecord(event.agreementId, 'activation_failed', event.traceId));
      return {
        accepted: true,
        deduped: false,
        eventKey,
        eventType: event.eventType,
        agreementId: event.agreementId,
        provider,
        action: 'activation_rejected_provider_mismatch',
        message: 'provider_override_mismatch',
        meta: {
          canonicalProvider: provider,
          overrideProvider: overrideAttempt,
        },
      };
    }

    const existingLink = this.store.getProviderLink(event.agreementId);
    if (existingLink && existingLink.provider !== provider) {
      this.store.setAgreementState(this.toStateRecord(event.agreementId, 'activation_failed', event.traceId));
      return {
        accepted: true,
        deduped: false,
        eventKey,
        eventType: event.eventType,
        agreementId: event.agreementId,
        provider,
        action: 'activation_rejected_provider_mismatch',
        message: 'provider_override_mismatch',
        meta: {
          canonicalProvider: provider,
          existingProvider: existingLink.provider,
        },
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
      const conflict = this.findProviderResourceConflict(event.agreementId, provider, provision.providerResourceId);
      if (conflict) {
        this.store.setAgreementState(this.toStateRecord(event.agreementId, 'activation_failed', event.traceId));

        return {
          accepted: true,
          deduped: false,
          eventKey,
          eventType: event.eventType,
          agreementId: event.agreementId,
          provider,
          action: 'activation_rejected_duplicate_provider_resource',
          message: 'provider_resource_already_assigned',
          meta: {
            providerResultStatus: 'error',
            providerResourceId: provision.providerResourceId,
            conflictingAgreementId: conflict.agreementId,
          },
        };
      }

      this.store.setProviderLink({
        agreementId: event.agreementId,
        provider,
        providerResourceId: provision.providerResourceId,
        updatedAt: new Date().toISOString(),
      });
    }

    let providerPayloadPublish:
      | {
          status: 'published';
          txHash?: string;
        }
      | {
          status: 'skipped';
          reason: string;
        }
      | {
          status: 'failed';
          error: string;
        }
      | undefined;

    if (this.txSubmitter && provision.connection && this.isRecord(provision.connection)) {
      const borrowerAddress = this.readBorrowerAddress(event.policy, event.payload);
      if (!borrowerAddress) {
        providerPayloadPublish = { status: 'skipped', reason: 'missing_borrower_address' };
      } else {
        const publish = await this.txSubmitter.publishProviderPayload(
          event.agreementId,
          provision.connection,
          borrowerAddress
        );

        if (publish.error) {
          providerPayloadPublish = { status: 'failed', error: publish.error };
        } else {
          providerPayloadPublish = {
            status: 'published',
            ...(publish.txHash ? { txHash: publish.txHash } : {}),
          };
        }
      }
    } else if (this.txSubmitter && !provision.connection) {
      providerPayloadPublish = { status: 'skipped', reason: 'missing_provider_credentials' };
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
        ...(providerPayloadPublish ? { providerPayloadPublish } : {}),
      },
    };
  }

  private async handleRiskEvent(event: OnchainEvent, eventKey: string): Promise<OnchainIngestionResult> {
    const normalized = this.normalizeRiskEventType(event.eventType);
    if (!normalized) {
      return {
        accepted: false,
        deduped: false,
        eventKey,
        eventType: event.eventType,
        agreementId: event.agreementId,
        ...(event.provider ? { provider: event.provider } : {}),
        action: 'rejected',
        message: 'unsupported_event_type',
      };
    }

    const provider = event.provider ?? this.store.getProviderLink(event.agreementId)?.provider;
    const state = normalized === 'breach' ? 'breach_detected' : 'default_detected';

    const finalMetering = this.meteringWorker
      ? await this.meteringWorker.runForAgreement(event.agreementId, { finalPass: true })
      : undefined;

    this.store.setAgreementState(this.toStateRecord(event.agreementId, state, event.traceId));

    if (this.killSwitchService) {
      const ks = await this.killSwitchService.enforce({
        agreementId: event.agreementId,
        eventType: normalized,
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

  private handleAgreementClosedEvent(event: OnchainEvent, eventKey: string): OnchainIngestionResult {
    this.store.setAgreementState(this.toStateRecord(event.agreementId, 'closed', event.traceId));

    return {
      accepted: true,
      deduped: false,
      eventKey,
      eventType: event.eventType,
      agreementId: event.agreementId,
      ...(event.provider ? { provider: event.provider } : {}),
      action: 'agreement_closed_recorded',
    };
  }

  private normalizeRiskEventType(
    eventType: OnchainEvent['eventType']
  ): 'breach' | 'default' | undefined {
    if (eventType === 'breach' || eventType === 'risk_covenant_breached' || eventType === 'risk_draw_terminated') {
      return 'breach';
    }
    if (eventType === 'default' || eventType === 'risk_defaulted') {
      return 'default';
    }
    return undefined;
  }

  private readBorrowerAddress(
    policy?: Record<string, unknown>,
    payload?: Record<string, unknown>
  ): string | undefined {
    const direct = [
      this.readAddress(policy, ['borrowerAddress', 'borrower', 'authorizedAddress']),
      this.readAddress(payload, ['borrowerAddress', 'borrower', 'authorizedAddress']),
    ].find((value) => value !== undefined);

    if (direct) return direct;

    const payloadIdentity = this.readRecord(payload, ['identity']);
    const policyIdentity = this.readRecord(policy, ['identity']);

    return (
      this.readAddress(payloadIdentity, ['authorizedAddress']) ??
      this.readAddress(policyIdentity, ['authorizedAddress']) ??
      undefined
    );
  }

  private readAddress(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
    if (!source) return undefined;
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && isAddress(value)) {
        return value;
      }
    }
    return undefined;
  }

  private readRecord(source: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> | undefined {
    if (!source) return undefined;
    for (const key of keys) {
      const value = source[key];
      if (this.isRecord(value)) return value;
    }
    return undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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

  private findProviderResourceConflict(
    agreementId: string,
    provider: ComputeProvider,
    providerResourceId: string
  ): ProviderResourceLink | undefined {
    return this.store
      .listProviderLinks()
      .find(
        (link) =>
          link.provider === provider &&
          link.providerResourceId === providerResourceId &&
          link.agreementId !== agreementId
      );
  }

  private readProviderOverride(
    policy?: Record<string, unknown>,
    payload?: Record<string, unknown>
  ): ComputeProvider | undefined {
    const candidates = [
      this.readProviderFromRecord(payload),
      this.readProviderFromRecord(policy),
    ];

    for (const candidate of candidates) {
      if (candidate) return candidate;
    }

    return undefined;
  }

  private readProviderFromRecord(record?: Record<string, unknown>): ComputeProvider | undefined {
    if (!record) return undefined;
    const keys = ['provider', 'computeProvider'];
    for (const key of keys) {
      const value = record[key];
      if (this.isComputeProvider(value)) {
        return value;
      }
    }
    return undefined;
  }

  private isComputeProvider(value: unknown): value is ComputeProvider {
    return value === 'lambda' || value === 'runpod' || value === 'venice' || value === 'bankr';
  }

  private async verifyActivationIdentity(
    event: OnchainEvent
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.identityGate.mode !== 'erc8004_offchain') {
      return { ok: true };
    }

    if (!this.identityGate.diamondAddress) {
      return { ok: false, reason: 'identity_gate_diamond_not_configured' };
    }

    const payload = event.payload;
    if (!payload || typeof payload !== 'object') {
      return { ok: false, reason: 'missing_identity_proof' };
    }

    const identity = (payload as Record<string, unknown>).identity;
    if (!identity || typeof identity !== 'object') {
      return { ok: false, reason: 'missing_identity_proof' };
    }

    const verification = await verifyIdentityProof(identity as Record<string, unknown>, {
      agreementId: event.agreementId,
      targetChainId: this.identityGate.targetChainId ?? event.chainId,
      diamondAddress: this.identityGate.diamondAddress,
      ...(this.identityGate.erc8004ChainId !== undefined
        ? { erc8004ChainId: this.identityGate.erc8004ChainId }
        : {}),
      ...(this.identityGate.erc8004RpcUrl ? { erc8004RpcUrl: this.identityGate.erc8004RpcUrl } : {}),
      ...(this.identityGate.erc8004RegistryAddress
        ? { erc8004RegistryAddress: this.identityGate.erc8004RegistryAddress }
        : {}),
      ...(this.identityGate.proofMaxSkewSeconds !== undefined
        ? { maxSkewSeconds: this.identityGate.proofMaxSkewSeconds }
        : {}),
      ...(this.identityGate.resolveWallet ? { resolveWallet: this.identityGate.resolveWallet } : {}),
    });

    if (!verification.ok) {
      return { ok: false, reason: verification.reason ?? 'identity_verification_failed' };
    }
    return { ok: true };
  }
}
