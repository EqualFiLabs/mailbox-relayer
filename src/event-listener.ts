import { Interface, Log, Result, getAddress, id, isAddress } from 'ethers';
import { canonicalEnvelopeSchema } from './schema';
import { OnchainEvent, OnchainEventIngestionWorker } from './events';
import { MessageStore } from './store';

export interface EventListenerConfig {
  diamondAddress: string;
  chainId: number;
  startBlock?: number;
  confirmationDepth?: number;
  pollIntervalMs?: number;
  maxRetryIntervalMs?: number;
}

export interface EventListenerStatus {
  lastConfirmedBlock: number;
  chainHead: number;
  blocksBehind: number;
  isPolling: boolean;
}

interface LoggerLike {
  child?: (bindings: Record<string, unknown>) => LoggerLike;
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
}

interface DecodedDiamondEvent {
  blockNumber: number;
  blockHash?: string;
  logIndex: number;
  txHash?: string;
  eventName: string;
  args: Result;
}

interface PendingBlock {
  blockNumber: number;
  blockHash?: string;
  events: DecodedDiamondEvent[];
}

export interface EventOrderKey {
  blockNumber: number;
  logIndex: number;
}

export function compareByBlockAndLogIndex(a: EventOrderKey, b: EventOrderKey): number {
  if (a.blockNumber !== b.blockNumber) {
    return a.blockNumber - b.blockNumber;
  }
  return a.logIndex - b.logIndex;
}

export function sortByBlockAndLogIndex<T extends EventOrderKey>(items: readonly T[]): T[] {
  return [...items].sort(compareByBlockAndLogIndex);
}

const EVENT_SIGNATURES = [
  'AgreementActivated(uint256,uint256,uint8)',
  'BorrowerPayloadPublished(uint256,address,bytes)',
  'ProviderPayloadPublished(uint256,address,bytes)',
  'CoverageCovenantBreached(uint256,uint256,uint256,uint256,uint256)',
  'DrawRightsTerminated(uint256,bytes32)',
  'AgreementDefaulted(uint256,uint256)',
  'AgreementClosed(uint256)',
  'DrawExecuted(uint256,uint256,uint256,address)',
  'RepaymentApplied(uint256,uint256,uint256,uint256,uint256)',
  'NativeEncumbranceUpdated(uint256,bytes32,uint256,uint256,bytes32)',
] as const;

const OBSERVABILITY_ONLY_EVENTS = new Set(['ProviderPayloadPublished', 'DrawExecuted', 'RepaymentApplied', 'NativeEncumbranceUpdated']);

const DIAMOND_EVENTS_ABI = [
  'event AgreementActivated(uint256 indexed agreementId, uint256 indexed proposalId, uint8 mode)',
  'event BorrowerPayloadPublished(uint256 indexed agreementId, address indexed borrower, bytes envelope)',
  'event ProviderPayloadPublished(uint256 indexed agreementId, address indexed provider, bytes envelope)',
  'event CoverageCovenantBreached(uint256 indexed agreementId, uint256 indexed periodId, uint256 requiredPayment, uint256 actualPayment, uint256 netDraw)',
  'event DrawRightsTerminated(uint256 indexed agreementId, bytes32 reason)',
  'event AgreementDefaulted(uint256 indexed agreementId, uint256 pastDue)',
  'event AgreementClosed(uint256 indexed agreementId)',
  'event DrawExecuted(uint256 indexed agreementId, uint256 amount, uint256 units, address recipient)',
  'event RepaymentApplied(uint256 indexed agreementId, uint256 amount, uint256 toFees, uint256 toInterest, uint256 toPrincipal)',
  'event NativeEncumbranceUpdated(uint256 indexed agreementId, bytes32 indexed positionKey, uint256 principalEncumbered, uint256 unitsEncumbered, bytes32 reason)',
] as const;

export class EventListener {
  private readonly iface = new Interface(DIAMOND_EVENTS_ABI);
  private readonly topic0s = EVENT_SIGNATURES.map((signature) => id(signature));
  private readonly diamondAddress: string;
  private readonly chainId: number;
  private readonly startBlock: number;
  private readonly confirmationDepth: number;
  private readonly pollIntervalMs: number;
  private readonly maxRetryIntervalMs: number;

  private readonly pendingBlocks = new Map<number, PendingBlock>();

  private isStarted = false;
  private isPolling = false;
  private nextScanBlock = 0;
  private lastConfirmedBlock = 0;
  private lastConfirmedHash: string | undefined;
  private chainHead = 0;

  private pollLoopPromise: Promise<void> | undefined;
  private inFlightPollPromise: Promise<void> | undefined;

  private currentPollIntervalMs: number;

  constructor(
    config: EventListenerConfig,
    private readonly provider: {
      getNetwork: () => Promise<{ chainId: bigint }>;
      getBlockNumber: () => Promise<number>;
      getLogs: (filter: {
        address: string;
        fromBlock: number;
        toBlock: number;
        topics: Array<string | string[] | null>;
      }) => Promise<Log[]>;
      getBlock: (blockNumber: number) => Promise<{ hash: string } | null>;
    },
    private readonly store: MessageStore,
    private readonly ingestionWorker: OnchainEventIngestionWorker,
    private readonly logger: LoggerLike = console
  ) {
    if (!isAddress(config.diamondAddress)) {
      throw new Error('invalid_diamond_address');
    }
    if (!Number.isFinite(config.chainId) || config.chainId <= 0) {
      throw new Error('invalid_chain_id');
    }

    this.diamondAddress = getAddress(config.diamondAddress);
    this.chainId = config.chainId;
    this.startBlock = config.startBlock ?? 0;
    this.confirmationDepth = config.confirmationDepth ?? 12;
    this.pollIntervalMs = config.pollIntervalMs ?? 2_000;
    this.maxRetryIntervalMs = config.maxRetryIntervalMs ?? 60_000;
    this.currentPollIntervalMs = this.pollIntervalMs;
  }

  async start(): Promise<void> {
    if (this.isPolling) {
      return;
    }

    if (!this.isStarted) {
      await this.initialize();
      this.isStarted = true;
    }

    this.isPolling = true;
    this.pollLoopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.isPolling = false;
    await this.inFlightPollPromise;
    await this.pollLoopPromise;

    if (this.lastConfirmedHash) {
      this.store.setBlockCursor(this.chainId, this.lastConfirmedBlock, this.lastConfirmedHash);
    } else {
      this.store.setBlockCursor(this.chainId, this.lastConfirmedBlock);
    }
  }

  status(): EventListenerStatus {
    return {
      lastConfirmedBlock: this.lastConfirmedBlock,
      chainHead: this.chainHead,
      blocksBehind: Math.max(0, this.chainHead - this.lastConfirmedBlock),
      isPolling: this.isPolling,
    };
  }

  private async initialize(): Promise<void> {
    const network = await this.provider.getNetwork();
    const rpcChainId = Number(network.chainId);

    if (rpcChainId !== this.chainId) {
      throw new Error(`chain_id_mismatch: expected=${this.chainId} rpc=${rpcChainId}`);
    }

    const cursor = this.store.getBlockCursor(this.chainId);
    if (cursor) {
      this.lastConfirmedBlock = cursor.lastConfirmed;
      this.lastConfirmedHash = cursor.blockHash;
      this.nextScanBlock = cursor.lastConfirmed + 1;
    } else {
      this.lastConfirmedBlock = this.startBlock > 0 ? this.startBlock - 1 : 0;
      this.nextScanBlock = this.startBlock;
    }

    this.chainHead = await this.provider.getBlockNumber();

    if (this.nextScanBlock > this.chainHead + 1) {
      this.logger.info?.(
        {
          chainId: this.chainId,
          nextScanBlock: this.nextScanBlock,
          chainHead: this.chainHead,
        },
        'event listener cursor ahead of chain head; waiting for chain advancement'
      );
    }
  }

  private async runLoop(): Promise<void> {
    while (this.isPolling) {
      this.inFlightPollPromise = this.pollCycle();
      await this.inFlightPollPromise;
      this.inFlightPollPromise = undefined;

      if (!this.isPolling) {
        break;
      }

      await this.delay(this.currentPollIntervalMs);
    }
  }

  private async pollCycle(): Promise<void> {
    try {
      const chainHead = await this.provider.getBlockNumber();
      this.chainHead = chainHead;

      if (chainHead >= this.nextScanBlock) {
        await this.fetchAndBufferLogs(this.nextScanBlock, chainHead);
        this.nextScanBlock = chainHead + 1;
      }

      await this.deliverConfirmedBlocks(chainHead);
      this.resetBackoffIfNeeded();
    } catch (error) {
      this.bumpBackoff(error);
    }
  }

  private async fetchAndBufferLogs(fromBlock: number, toBlock: number): Promise<void> {
    if (toBlock < fromBlock) {
      return;
    }

    const logs = await this.provider.getLogs({
      address: this.diamondAddress,
      fromBlock,
      toBlock,
      topics: [this.topic0s],
    });

    for (const log of logs) {
      try {
        const parsed = this.iface.parseLog({ topics: [...log.topics], data: log.data });
        if (!parsed) {
          throw new Error('log_parse_failed');
        }

        const blockNumber = Number(log.blockNumber);
        const logIndex = Number(log.index);

        const pending =
          this.pendingBlocks.get(blockNumber) ??
          {
            blockNumber,
            ...(log.blockHash ? { blockHash: log.blockHash } : {}),
            events: [],
          };

        pending.events.push({
          blockNumber,
          ...(log.blockHash ? { blockHash: log.blockHash } : {}),
          logIndex,
          ...(log.transactionHash ? { txHash: log.transactionHash } : {}),
          eventName: parsed.name,
          args: parsed.args,
        });

        pending.events.sort((a, b) => a.logIndex - b.logIndex);
        this.pendingBlocks.set(blockNumber, pending);
      } catch (error) {
        this.logger.warn?.(
          {
            chainId: this.chainId,
            blockNumber: Number(log.blockNumber),
            logIndex: Number(log.index),
            txHash: log.transactionHash,
            error: error instanceof Error ? error.message : String(error),
          },
          'event listener skipping undecodable log'
        );
      }
    }
  }

  private async deliverConfirmedBlocks(chainHead: number): Promise<void> {
    const blockNumbers = [...this.pendingBlocks.keys()].sort((a, b) => a - b);

    for (const blockNumber of blockNumbers) {
      if (chainHead - blockNumber < this.confirmationDepth) {
        continue;
      }

      const pending = this.pendingBlocks.get(blockNumber);
      if (!pending) {
        continue;
      }

      const canonicalBlock = await this.provider.getBlock(blockNumber);
      const canonicalHash = canonicalBlock?.hash;

      if (pending.blockHash && canonicalHash && pending.blockHash !== canonicalHash) {
        this.logger.warn?.(
          {
            chainId: this.chainId,
            blockNumber,
            expectedHash: pending.blockHash,
            canonicalHash,
          },
          'event listener detected reorg; discarding pending branch'
        );

        for (const candidate of [...this.pendingBlocks.keys()]) {
          if (candidate >= blockNumber) {
            this.pendingBlocks.delete(candidate);
          }
        }

        this.nextScanBlock = Math.min(this.nextScanBlock, blockNumber);
        break;
      }

      try {
        await this.deliverBlock({
          ...pending,
          ...(canonicalHash ? { blockHash: canonicalHash } : {}),
        });
      } catch (error) {
        this.logger.error?.(
          {
            chainId: this.chainId,
            blockNumber,
            error: error instanceof Error ? error.message : String(error),
          },
          'event listener block delivery failed; block will be retried'
        );
        break;
      }
    }
  }

  private async deliverBlock(block: PendingBlock): Promise<void> {
    const ordered = sortByBlockAndLogIndex(block.events);

    for (const decoded of ordered) {
      const mapped = this.mapDecodedEvent(decoded);

      if (!mapped.deliver) {
        this.logger.info?.(
          {
            chainId: this.chainId,
            blockNumber: decoded.blockNumber,
            logIndex: decoded.logIndex,
            txHash: decoded.txHash,
            eventType: mapped.eventType,
            agreementId: mapped.agreementId,
          },
          'event listener observed informational event'
        );
        continue;
      }

      const event: OnchainEvent = mapped.event;

      const result = await this.ingestionWorker.ingest(event);

      const logPayload = {
        chainId: this.chainId,
        blockNumber: event.blockNumber,
        logIndex: event.logIndex,
        txHash: event.txHash,
        eventType: event.eventType,
        agreementId: event.agreementId,
        ...(event.traceId ? { traceId: event.traceId } : {}),
        eventKey: result.eventKey,
      };

      if (!result.accepted) {
        this.logger.error?.(logPayload, 'event listener delivery rejected by ingestion worker');
        continue;
      }

      if (result.deduped) {
        this.logger.debug?.(logPayload, 'event listener delivery deduped');
        continue;
      }

      this.logger.info?.(logPayload, 'event listener delivered event');
    }

    if (block.blockHash) {
      this.store.setBlockCursor(this.chainId, block.blockNumber, block.blockHash);
      this.lastConfirmedHash = block.blockHash;
    } else {
      this.store.setBlockCursor(this.chainId, block.blockNumber);
      this.lastConfirmedHash = undefined;
    }

    this.lastConfirmedBlock = block.blockNumber;
    this.pendingBlocks.delete(block.blockNumber);
    this.nextScanBlock = Math.max(this.nextScanBlock, block.blockNumber + 1);
  }

  private mapDecodedEvent(
    decoded: DecodedDiamondEvent
  ):
    | {
        deliver: true;
        event: OnchainEvent;
      }
    | {
        deliver: false;
        eventType: string;
        agreementId?: string;
      } {
    const eventName = decoded.eventName;

    const agreementId = this.bigintArgToString(decoded.args, 'agreementId', 0);

    if (!agreementId) {
      throw new Error(`missing_agreement_id:${eventName}`);
    }

    if (eventName === 'AgreementActivated') {
      return {
        deliver: true,
        event: this.baseEvent(decoded, agreementId, 'activation'),
      };
    }

    if (eventName === 'BorrowerPayloadPublished') {
      const envelopeHex = this.stringArg(decoded.args, 'envelope', 2);
      const envelopeJson = this.decodeEnvelope(envelopeHex);
      return {
        deliver: true,
        event: {
          ...this.baseEvent(decoded, agreementId, 'mailbox'),
          envelope: envelopeJson,
        },
      };
    }

    if (eventName === 'CoverageCovenantBreached') {
      return {
        deliver: true,
        event: {
          ...this.baseEvent(decoded, agreementId, 'risk_covenant_breached'),
          payload: {
            periodId: this.bigintArgToString(decoded.args, 'periodId', 1),
            requiredPayment: this.bigintArgToString(decoded.args, 'requiredPayment', 2),
            actualPayment: this.bigintArgToString(decoded.args, 'actualPayment', 3),
            netDraw: this.bigintArgToString(decoded.args, 'netDraw', 4),
          },
        },
      };
    }

    if (eventName === 'DrawRightsTerminated') {
      const reason = this.stringArg(decoded.args, 'reason', 1);
      return {
        deliver: true,
        event: {
          ...this.baseEvent(decoded, agreementId, 'risk_draw_terminated'),
          reason,
          payload: {
            reason,
          },
        },
      };
    }

    if (eventName === 'AgreementDefaulted') {
      const pastDue = this.bigintArgToString(decoded.args, 'pastDue', 1);
      return {
        deliver: true,
        event: {
          ...this.baseEvent(decoded, agreementId, 'risk_defaulted'),
          payload: {
            pastDue,
          },
        },
      };
    }

    if (eventName === 'AgreementClosed') {
      return {
        deliver: true,
        event: this.baseEvent(decoded, agreementId, 'agreement_closed'),
      };
    }

    if (OBSERVABILITY_ONLY_EVENTS.has(eventName)) {
      return {
        deliver: false,
        eventType: eventName,
        agreementId,
      };
    }

    return {
      deliver: false,
      eventType: eventName,
      agreementId,
    };
  }

  private baseEvent(
    decoded: DecodedDiamondEvent,
    agreementId: string,
    eventType: OnchainEvent['eventType']
  ): OnchainEvent {
    return {
      chainId: this.chainId,
      blockNumber: decoded.blockNumber,
      logIndex: decoded.logIndex,
      ...(decoded.txHash ? { txHash: decoded.txHash } : {}),
      eventType,
      agreementId,
    };
  }

  private decodeEnvelope(rawHex: string): OnchainEvent['envelope'] {
    if (!rawHex.startsWith('0x')) {
      throw new Error('invalid_envelope_hex');
    }

    const utf8 = Buffer.from(rawHex.slice(2), 'hex').toString('utf8');
    const parsed = JSON.parse(utf8) as unknown;
    const validated = canonicalEnvelopeSchema.safeParse(parsed);

    if (!validated.success) {
      throw new Error('invalid_envelope_payload');
    }

    return validated.data;
  }

  private bigintArgToString(args: Result, key: string, index: number): string | undefined {
    const value = this.readArg(args, key, index);
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'number') {
      return value.toString();
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      return value;
    }
    return undefined;
  }

  private stringArg(args: Result, key: string, index: number): string {
    const value = this.readArg(args, key, index);
    if (typeof value === 'string') {
      return value;
    }
    throw new Error(`invalid_string_arg:${key}`);
  }

  private readArg(args: Result, key: string, index: number): unknown {
    const named = (args as unknown as Record<string, unknown>)[key];
    if (named !== undefined) {
      return named;
    }

    return args[index];
  }

  private bumpBackoff(error: unknown): void {
    const next = Math.min(this.maxRetryIntervalMs, this.currentPollIntervalMs * 2);
    this.currentPollIntervalMs = next;
    this.logger.warn?.(
      {
        chainId: this.chainId,
        retryIntervalMs: this.currentPollIntervalMs,
        error: error instanceof Error ? error.message : String(error),
      },
      'event listener RPC poll failed; backing off'
    );
  }

  private resetBackoffIfNeeded(): void {
    if (this.currentPollIntervalMs !== this.pollIntervalMs) {
      this.currentPollIntervalMs = this.pollIntervalMs;
      this.logger.info?.(
        {
          chainId: this.chainId,
          pollIntervalMs: this.pollIntervalMs,
        },
        'event listener RPC recovered; poll interval reset'
      );
    }
  }

  private async delay(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
