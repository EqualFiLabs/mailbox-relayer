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
  it('persists message, provider link, and usage checkpoint across restarts', () => {
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

    const storeB = new SQLiteMessageStore(dbPath);

    const message = storeB.get('msg-1');
    const link = storeB.getProviderLink('agreement-1');
    const checkpoint = storeB.getUsageCheckpoint('agreement-1');

    expect(message?.id).toBe('msg-1');
    expect(link?.providerResourceId).toBe('key_123');
    expect(checkpoint?.lastUsageDigest).toBe('digest-1');
  });

  it('enforces processed event idempotency', () => {
    const dbPath = createDbPath();
    const store = new SQLiteMessageStore(dbPath);

    expect(store.markEventProcessed('evt-1', 100, 2)).toBe(true);
    expect(store.markEventProcessed('evt-1', 100, 2)).toBe(false);
  });
});
