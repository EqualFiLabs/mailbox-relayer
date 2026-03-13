import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteMessageStore } from '../../src/store';

const testDirs: string[] = [];

function createDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mailbox-relayer-'));
  testDirs.push(dir);
  return join(dir, 'state.db');
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('SQLiteMessageStore', () => {
  it('persists message, provider link, usage checkpoint, and block cursor across restarts', () => {
    const dbPath = createDbPath();

    const storeA = new SQLiteMessageStore(dbPath);
    storeA.save({
      id: 'msg-1',
      status: 'queued',
      envelope: {
        version: 'equalfi.mailbox.ecies.eth-crypto.v1',
        recipient: 'agent:base:0xabc',
        cipher: {
          iv: '45ec7da7123f5562935ecd4cf0f3139e',
          ephemPublicKey:
            '045ea7b6221a026bafa1adcf2c727d8ebaf5395b40a932bf85c1e991467113ba8867fbcca8e242864e0ea02342deb475e17f384095208dd7e34b1a9162ac647323',
          mac: '0957308398294e8c9f03482c7c0ba49c9aa7d3252dabe4af8224279d9be220c1',
          ciphertext: '9971dc361b6cd776ffc3fdb0a7d74149',
        },
        createdAt: '2026-03-10T20:00:00.000Z',
      },
    });

    storeA.setProviderLink({
      agreementId: 'agreement-1',
      provider: 'venice',
      providerResourceId: 'key_123',
      updatedAt: '2026-03-10T20:00:00.000Z',
    });

    storeA.setUsageCheckpoint({
      agreementId: 'agreement-1',
      provider: 'venice',
      lastUsageTimestamp: '2026-03-10T20:05:00.000Z',
      lastUsageDigest: 'digest-1',
      updatedAt: '2026-03-10T20:05:00.000Z',
    });
    storeA.setBlockCursor(84532, 12345, '0xabc');

    const storeB = new SQLiteMessageStore(dbPath);

    const message = storeB.get('msg-1');
    const link = storeB.getProviderLink('agreement-1');
    const checkpoint = storeB.getUsageCheckpoint('agreement-1');
    const cursor = storeB.getBlockCursor(84532);

    expect(message?.id).toBe('msg-1');
    expect(link?.providerResourceId).toBe('key_123');
    expect(checkpoint?.lastUsageDigest).toBe('digest-1');
    expect(cursor).toEqual({ lastConfirmed: 12345, blockHash: '0xabc' });
  });

  it('stores provider events idempotently and supports observedAt filtering', () => {
    const dbPath = createDbPath();
    const store = new SQLiteMessageStore(dbPath);

    const base = {
      provider: 'bankr',
      providerResourceId: 'resource-1',
      payloadJson: '{"ok":true}',
      createdAt: '2026-03-10T20:00:00.000Z',
    };

    const firstInsert = store.upsertProviderEvent({
      ...base,
      externalEventId: 'evt-1',
      observedAt: '2026-03-10T20:00:01.000Z',
    });
    const duplicateInsert = store.upsertProviderEvent({
      ...base,
      externalEventId: 'evt-1',
      observedAt: '2026-03-10T20:00:01.000Z',
    });
    const secondInsert = store.upsertProviderEvent({
      ...base,
      externalEventId: 'evt-2',
      observedAt: '2026-03-10T20:05:00.000Z',
    });

    expect(firstInsert).toBe(true);
    expect(duplicateInsert).toBe(false);
    expect(secondInsert).toBe(true);

    const all = store.listProviderEvents('bankr', 'resource-1');
    const filtered = store.listProviderEvents(
      'bankr',
      'resource-1',
      '2026-03-10T20:04:00.000Z',
      '2026-03-10T20:06:00.000Z'
    );

    expect(all).toHaveLength(2);
    expect(all[0].externalEventId).toBe('evt-1');
    expect(all[1].externalEventId).toBe('evt-2');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].externalEventId).toBe('evt-2');
  });

  it('enforces processed event idempotency', () => {
    const dbPath = createDbPath();
    const store = new SQLiteMessageStore(dbPath);

    expect(store.markEventProcessed('evt-1', 100, 2)).toBe(true);
    expect(store.markEventProcessed('evt-1', 100, 2)).toBe(false);
  });
});
