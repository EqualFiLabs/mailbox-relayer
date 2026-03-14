import { Interface, Log } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnchainEvent } from '../src/events';
import { EventListener } from '../src/event-listener';
import { InMemoryMessageStore } from '../src/store';

const diamondAddress = '0x1111111111111111111111111111111111111111';
const chainId = 84532;

const EVENT_ABI = [
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

const EVENT_IFACE = new Interface(EVENT_ABI);

const validEnvelope = {
  version: 'equalfi.mailbox.ecies.eth-crypto.v1',
  recipient: 'agent:base:0xabc123',
  cipher: {
    iv: '45ec7da7123f5562935ecd4cf0f3139e',
    ephemPublicKey:
      '045ea7b6221a026bafa1adcf2c727d8ebaf5395b40a932bf85c1e991467113ba8867fbcca8e242864e0ea02342deb475e17f384095208dd7e34b1a9162ac647323',
    mac: '0957308398294e8c9f03482c7c0ba49c9aa7d3252dabe4af8224279d9be220c1',
    ciphertext: '9971dc361b6cd776ffc3fdb0a7d74149',
  },
  createdAt: '2026-03-10T20:00:00.000Z',
};

function makeHash(seed: number): string {
  return `0x${seed.toString(16).padStart(64, '0')}`;
}

function encodeEventLog(
  eventName: string,
  values: ReadonlyArray<unknown>,
  blockNumber: number,
  logIndex: number,
  txSeed: number,
  blockHash?: string
): Log {
  const fragment = EVENT_IFACE.getEvent(eventName);
  const encoded = EVENT_IFACE.encodeEventLog(fragment, [...values]);

  return {
    address: diamondAddress,
    blockNumber,
    blockHash: blockHash ?? makeHash(blockNumber),
    transactionHash: makeHash(txSeed),
    index: logIndex,
    removed: false,
    data: encoded.data,
    topics: encoded.topics,
    transactionIndex: 0,
  } as unknown as Log;
}

class MockProvider {
  chainHead = 0;
  chainId = BigInt(chainId);
  logs: Log[] = [];
  blockHashes = new Map<number, string>();
  getLogsCalls: Array<{ fromBlock: number; toBlock: number }> = [];
  failBlockNumberCount = 0;
  failGetLogsCount = 0;

  async getNetwork(): Promise<{ chainId: bigint }> {
    return { chainId: this.chainId };
  }

  async getBlockNumber(): Promise<number> {
    if (this.failBlockNumberCount > 0) {
      this.failBlockNumberCount -= 1;
      throw new Error('rpc_blocknumber_failed');
    }
    return this.chainHead;
  }

  async getLogs(filter: {
    address: string;
    fromBlock: number;
    toBlock: number;
    topics: Array<string | string[] | null>;
  }): Promise<Log[]> {
    if (this.failGetLogsCount > 0) {
      this.failGetLogsCount -= 1;
      throw new Error('rpc_getlogs_failed');
    }

    this.getLogsCalls.push({ fromBlock: filter.fromBlock, toBlock: filter.toBlock });

    const firstTopicFilter = filter.topics[0];
    const topicSet = new Set(Array.isArray(firstTopicFilter) ? firstTopicFilter : firstTopicFilter ? [firstTopicFilter] : []);

    return this.logs
      .filter(
        (log) =>
          log.address.toLowerCase() === filter.address.toLowerCase() &&
          Number(log.blockNumber) >= filter.fromBlock &&
          Number(log.blockNumber) <= filter.toBlock &&
          topicSet.has(log.topics[0] ?? '')
      )
      .sort((a, b) => {
        const blockA = Number(a.blockNumber);
        const blockB = Number(b.blockNumber);
        if (blockA !== blockB) return blockA - blockB;
        return Number(a.index) - Number(b.index);
      });
  }

  async getBlock(blockNumber: number): Promise<{ hash: string } | null> {
    const hash = this.blockHashes.get(blockNumber);
    if (!hash) return null;
    return { hash };
  }
}

function makeHarness(config?: {
  startBlock?: number;
  confirmationDepth?: number;
  pollIntervalMs?: number;
  maxRetryIntervalMs?: number;
}) {
  const provider = new MockProvider();
  const store = new InMemoryMessageStore();
  const ingest = vi.fn(async (event: OnchainEvent) => ({
    accepted: true,
    deduped: false,
    eventKey: `${event.chainId}:${event.blockNumber}:${event.logIndex}`,
    eventType: event.eventType,
    agreementId: event.agreementId,
    action: 'ok',
  }));

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };

  const listener = new EventListener(
    {
      diamondAddress,
      chainId,
      startBlock: config?.startBlock ?? 0,
      confirmationDepth: config?.confirmationDepth ?? 0,
      pollIntervalMs: config?.pollIntervalMs ?? 5,
      maxRetryIntervalMs: config?.maxRetryIntervalMs ?? 40,
    },
    provider,
    store,
    { ingest } as unknown as any,
    logger
  );

  return { provider, store, ingest, logger, listener };
}

async function initialize(listener: EventListener): Promise<void> {
  await (listener as any).initialize();
}

async function poll(listener: EventListener): Promise<void> {
  await (listener as any).pollCycle();
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('wait_for_timeout');
}

describe('EventListener', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps AgreementActivated to activation with agreementId', async () => {
    const h = makeHarness();
    h.provider.chainHead = 10;
    h.provider.blockHashes.set(10, makeHash(10));
    h.provider.logs = [encodeEventLog('AgreementActivated', [42n, 7n, 0], 10, 1, 1001)];

    await initialize(h.listener);
    await poll(h.listener);

    expect(h.ingest).toHaveBeenCalledTimes(1);
    const event = h.ingest.mock.calls[0]?.[0] as OnchainEvent;
    expect(event.eventType).toBe('activation');
    expect(event.agreementId).toBe('42');
  });

  it('maps BorrowerPayloadPublished to mailbox with decoded envelope', async () => {
    const h = makeHarness();
    h.provider.chainHead = 11;
    h.provider.blockHashes.set(11, makeHash(11));

    const envelopeHex = `0x${Buffer.from(JSON.stringify(validEnvelope), 'utf8').toString('hex')}`;
    h.provider.logs = [
      encodeEventLog(
        'BorrowerPayloadPublished',
        [42n, '0x2222222222222222222222222222222222222222', envelopeHex],
        11,
        0,
        1002
      ),
    ];

    await initialize(h.listener);
    await poll(h.listener);

    const event = h.ingest.mock.calls[0]?.[0] as OnchainEvent;
    expect(event.eventType).toBe('mailbox');
    expect(event.agreementId).toBe('42');
    expect(event.envelope).toEqual(validEnvelope);
  });

  it('maps risk events and agreement closure correctly', async () => {
    const h = makeHarness();
    h.provider.chainHead = 12;
    h.provider.blockHashes.set(12, makeHash(12));

    h.provider.logs = [
      encodeEventLog('CoverageCovenantBreached', [1n, 2n, 300n, 120n, 50n], 12, 0, 1010),
      encodeEventLog('DrawRightsTerminated', [2n, makeHash(77)], 12, 1, 1011),
      encodeEventLog('AgreementDefaulted', [3n, 99n], 12, 2, 1012),
      encodeEventLog('AgreementClosed', [4n], 12, 3, 1013),
    ];

    await initialize(h.listener);
    await poll(h.listener);

    expect(h.ingest).toHaveBeenCalledTimes(4);
    const eventTypes = h.ingest.mock.calls.map((call) => (call[0] as OnchainEvent).eventType);
    expect(eventTypes).toEqual([
      'risk_covenant_breached',
      'risk_draw_terminated',
      'risk_defaulted',
      'agreement_closed',
    ]);
  });

  it('skips undecodable logs with warning and does not crash', async () => {
    const h = makeHarness();
    h.provider.chainHead = 13;
    h.provider.blockHashes.set(13, makeHash(13));

    const valid = encodeEventLog('AgreementClosed', [9n], 13, 1, 1020);
    const malformedBorrower = encodeEventLog(
      'BorrowerPayloadPublished',
      [9n, '0x2222222222222222222222222222222222222222', '0x1234'],
      13,
      0,
      1021
    );
    const invalid = {
      ...malformedBorrower,
      data: '0x1234',
    } as Log;

    h.provider.logs = [invalid, valid];

    await initialize(h.listener);
    await poll(h.listener);

    expect(h.ingest).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalled();
  });

  it('does not deliver events until confirmationDepth is reached', async () => {
    const h = makeHarness({ confirmationDepth: 2 });
    h.provider.blockHashes.set(20, makeHash(20));
    h.provider.logs = [encodeEventLog('AgreementClosed', [100n], 20, 0, 1030)];

    await initialize(h.listener);

    h.provider.chainHead = 21;
    await poll(h.listener);
    expect(h.ingest).toHaveBeenCalledTimes(0);

    h.provider.chainHead = 22;
    await poll(h.listener);
    expect(h.ingest).toHaveBeenCalledTimes(1);
  });

  it('detects reorgs, discards orphaned pending blocks, and rescans from reorg block', async () => {
    const h = makeHarness({ confirmationDepth: 1 });

    h.provider.blockHashes.set(30, makeHash(30));
    h.provider.chainHead = 30;
    h.provider.logs = [encodeEventLog('AgreementClosed', [301n], 30, 0, 1040, makeHash(30))];

    await initialize(h.listener);
    await poll(h.listener);
    expect(h.ingest).toHaveBeenCalledTimes(0);

    h.provider.blockHashes.set(30, makeHash(3030));
    h.provider.chainHead = 31;
    h.provider.logs = [encodeEventLog('AgreementClosed', [999n], 30, 0, 1041, makeHash(3030))];

    await poll(h.listener);
    expect(h.ingest).toHaveBeenCalledTimes(0);
    expect(h.logger.warn).toHaveBeenCalled();

    await poll(h.listener);
    expect(h.ingest).toHaveBeenCalledTimes(1);
    const event = h.ingest.mock.calls[0]?.[0] as OnchainEvent;
    expect(event.agreementId).toBe('999');

    const reScanCall = h.provider.getLogsCalls.find((call) => call.fromBlock === 30);
    expect(reScanCall).toBeDefined();
  });

  it('persists block cursor after successful block delivery and resumes from cursor+1', async () => {
    const h = makeHarness({ startBlock: 5 });
    h.provider.blockHashes.set(40, makeHash(40));
    h.provider.chainHead = 40;
    h.provider.logs = [encodeEventLog('AgreementClosed', [400n], 40, 0, 1050)];

    await initialize(h.listener);
    await poll(h.listener);

    expect(h.store.getBlockCursor(chainId)).toEqual({
      lastConfirmed: 40,
      blockHash: makeHash(40),
    });

    const resumed = makeHarness({ startBlock: 5 });
    resumed.provider.chainHead = 41;
    resumed.provider.blockHashes.set(41, makeHash(41));
    resumed.provider.logs = [encodeEventLog('AgreementClosed', [401n], 41, 0, 1051)];
    resumed.store.setBlockCursor(chainId, 40, makeHash(40));

    await initialize(resumed.listener);
    await poll(resumed.listener);

    expect(resumed.provider.getLogsCalls[0]).toEqual({ fromBlock: 41, toBlock: 41 });
    expect(resumed.ingest).toHaveBeenCalledTimes(1);
  });

  it('starts from configured startBlock when cursor is missing', async () => {
    const h = makeHarness({ startBlock: 77 });
    h.provider.chainHead = 77;
    h.provider.blockHashes.set(77, makeHash(77));
    h.provider.logs = [encodeEventLog('AgreementClosed', [770n], 77, 0, 1060)];

    await initialize(h.listener);
    await poll(h.listener);

    expect(h.provider.getLogsCalls[0]).toEqual({ fromBlock: 77, toBlock: 77 });
  });

  it('waits when cursor is ahead of chain head', async () => {
    const h = makeHarness();
    h.store.setBlockCursor(chainId, 120, makeHash(120));
    h.provider.chainHead = 100;

    await initialize(h.listener);
    await poll(h.listener);

    expect(h.provider.getLogsCalls).toHaveLength(0);
    expect(h.logger.info).toHaveBeenCalled();
  });

  it('delivers events in strict (blockNumber, logIndex) order', async () => {
    const h = makeHarness({ startBlock: 10 });
    h.provider.chainHead = 11;
    h.provider.blockHashes.set(10, makeHash(10));
    h.provider.blockHashes.set(11, makeHash(11));
    h.provider.logs = [
      encodeEventLog('AgreementClosed', [1003n], 10, 3, 1073),
      encodeEventLog('AgreementClosed', [1001n], 10, 1, 1071),
      encodeEventLog('AgreementClosed', [1101n], 11, 1, 1081),
      encodeEventLog('AgreementClosed', [1002n], 10, 2, 1072),
    ];

    await initialize(h.listener);
    await poll(h.listener);

    const delivered = h.ingest.mock.calls.map((call) => {
      const event = call[0] as OnchainEvent;
      return `${event.blockNumber}:${event.logIndex}`;
    });

    expect(delivered).toEqual(['10:1', '10:2', '10:3', '11:1']);
  });

  it('keeps block cursor unchanged when ingestion throws mid-block (block-atomic cursor)', async () => {
    const h = makeHarness({ startBlock: 50 });
    h.provider.chainHead = 50;
    h.provider.blockHashes.set(50, makeHash(50));
    h.provider.logs = [
      encodeEventLog('AgreementClosed', [5001n], 50, 0, 1090),
      encodeEventLog('AgreementClosed', [5002n], 50, 1, 1091),
    ];

    h.ingest.mockImplementation(async (event: OnchainEvent) => {
      if (event.logIndex === 1) {
        throw new Error('ingest_failed_mid_block');
      }

      return {
        accepted: true,
        deduped: false,
        eventKey: `${event.chainId}:${event.blockNumber}:${event.logIndex}`,
        eventType: event.eventType,
        agreementId: event.agreementId,
        action: 'ok',
      };
    });

    await initialize(h.listener);
    await poll(h.listener);

    expect(h.store.getBlockCursor(chainId)).toBeUndefined();
    expect(h.logger.error).toHaveBeenCalled();
  });

  it('backs off on RPC failure and resets interval after recovery', async () => {
    const h = makeHarness({ pollIntervalMs: 5, maxRetryIntervalMs: 40 });
    h.provider.chainHead = 60;
    h.provider.blockHashes.set(60, makeHash(60));
    h.provider.logs = [encodeEventLog('AgreementClosed', [600n], 60, 0, 1100)];

    await initialize(h.listener);

    h.provider.failGetLogsCount = 1;
    await poll(h.listener);

    expect((h.listener as any).currentPollIntervalMs).toBe(10);
    expect(h.logger.warn).toHaveBeenCalled();

    await poll(h.listener);

    expect((h.listener as any).currentPollIntervalMs).toBe(5);
    expect(h.ingest).toHaveBeenCalledTimes(1);
  });

  it('gracefully stops: waits for in-flight poll and persists cursor', async () => {
    const h = makeHarness({ pollIntervalMs: 5, confirmationDepth: 0 });
    h.provider.chainHead = 70;
    h.provider.blockHashes.set(70, makeHash(70));
    h.provider.logs = [encodeEventLog('AgreementClosed', [700n], 70, 0, 1110)];

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    h.ingest.mockImplementation(async (event: OnchainEvent) => {
      await gate;
      return {
        accepted: true,
        deduped: false,
        eventKey: `${event.chainId}:${event.blockNumber}:${event.logIndex}`,
        eventType: event.eventType,
        agreementId: event.agreementId,
        action: 'ok',
      };
    });

    await h.listener.start();
    await waitFor(() => h.ingest.mock.calls.length === 1);

    const stopPromise = h.listener.stop();

    let settled = false;
    stopPromise.then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    release?.();
    await stopPromise;

    expect(h.store.getBlockCursor(chainId)).toEqual({
      lastConfirmed: 70,
      blockHash: makeHash(70),
    });
  });

  it('logs ProviderPayloadPublished but does not deliver it to ingestion worker', async () => {
    const h = makeHarness();
    h.provider.chainHead = 80;
    h.provider.blockHashes.set(80, makeHash(80));

    const envelopeHex = `0x${Buffer.from(JSON.stringify(validEnvelope), 'utf8').toString('hex')}`;
    h.provider.logs = [
      encodeEventLog(
        'ProviderPayloadPublished',
        [88n, '0x3333333333333333333333333333333333333333', envelopeHex],
        80,
        0,
        1120
      ),
    ];

    await initialize(h.listener);
    await poll(h.listener);

    expect(h.ingest).toHaveBeenCalledTimes(0);
    expect(h.logger.info).toHaveBeenCalled();
  });

  it('logs DrawExecuted/RepaymentApplied/NativeEncumbranceUpdated but does not deliver', async () => {
    const h = makeHarness();
    h.provider.chainHead = 81;
    h.provider.blockHashes.set(81, makeHash(81));
    h.provider.logs = [
      encodeEventLog('DrawExecuted', [1n, 2n, 3n, '0x4444444444444444444444444444444444444444'], 81, 0, 1130),
      encodeEventLog('RepaymentApplied', [1n, 20n, 5n, 6n, 9n], 81, 1, 1131),
      encodeEventLog('NativeEncumbranceUpdated', [1n, makeHash(1), 50n, 60n, makeHash(2)], 81, 2, 1132),
    ];

    await initialize(h.listener);
    await poll(h.listener);

    expect(h.ingest).toHaveBeenCalledTimes(0);
    expect(h.logger.info).toHaveBeenCalledTimes(3);
  });
});
