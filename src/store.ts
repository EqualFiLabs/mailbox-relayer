import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { StoredMessage } from './types';

export interface ProviderResourceLink {
  agreementId: string;
  provider: string;
  providerResourceId: string;
  updatedAt: string;
}

export interface UsageCheckpoint {
  agreementId: string;
  provider: string;
  lastUsageTimestamp?: string;
  lastUsageDigest?: string;
  updatedAt: string;
}

export interface MessageStore {
  save(message: StoredMessage): StoredMessage;
  get(id: string): StoredMessage | undefined;
  update(id: string, updater: (existing: StoredMessage) => StoredMessage): StoredMessage | undefined;

  setProviderLink(link: ProviderResourceLink): void;
  getProviderLink(agreementId: string): ProviderResourceLink | undefined;

  setUsageCheckpoint(checkpoint: UsageCheckpoint): void;
  getUsageCheckpoint(agreementId: string): UsageCheckpoint | undefined;

  markEventProcessed(eventKey: string, blockNumber: number, logIndex: number): boolean;
}

export class InMemoryMessageStore implements MessageStore {
  private readonly messages = new Map<string, StoredMessage>();
  private readonly providerLinks = new Map<string, ProviderResourceLink>();
  private readonly usageCheckpoints = new Map<string, UsageCheckpoint>();
  private readonly processedEvents = new Set<string>();

  save(message: StoredMessage): StoredMessage {
    this.messages.set(message.id, message);
    return message;
  }

  get(id: string): StoredMessage | undefined {
    return this.messages.get(id);
  }

  update(id: string, updater: (existing: StoredMessage) => StoredMessage): StoredMessage | undefined {
    const existing = this.messages.get(id);
    if (!existing) return undefined;
    const next = updater(existing);
    this.messages.set(id, next);
    return next;
  }

  setProviderLink(link: ProviderResourceLink): void {
    this.providerLinks.set(link.agreementId, link);
  }

  getProviderLink(agreementId: string): ProviderResourceLink | undefined {
    return this.providerLinks.get(agreementId);
  }

  setUsageCheckpoint(checkpoint: UsageCheckpoint): void {
    this.usageCheckpoints.set(checkpoint.agreementId, checkpoint);
  }

  getUsageCheckpoint(agreementId: string): UsageCheckpoint | undefined {
    return this.usageCheckpoints.get(agreementId);
  }

  markEventProcessed(eventKey: string): boolean {
    if (this.processedEvents.has(eventKey)) return false;
    this.processedEvents.add(eventKey);
    return true;
  }
}

export class SQLiteMessageStore implements MessageStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        envelope_json TEXT NOT NULL,
        status TEXT NOT NULL,
        delivered_at TEXT,
        ack_json TEXT
      );

      CREATE TABLE IF NOT EXISTS provider_links (
        agreement_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_resource_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_checkpoints (
        agreement_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        last_usage_timestamp TEXT,
        last_usage_digest TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS processed_events (
        event_key TEXT PRIMARY KEY,
        block_number INTEGER NOT NULL,
        log_index INTEGER NOT NULL,
        processed_at TEXT NOT NULL
      );
    `);
  }

  save(message: StoredMessage): StoredMessage {
    this.db
      .prepare(
        `INSERT INTO messages (id, envelope_json, status, delivered_at, ack_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           envelope_json = excluded.envelope_json,
           status = excluded.status,
           delivered_at = excluded.delivered_at,
           ack_json = excluded.ack_json`
      )
      .run(
        message.id,
        JSON.stringify(message.envelope),
        message.status,
        message.deliveredAt ?? null,
        message.ack ? JSON.stringify(message.ack) : null
      );

    return message;
  }

  get(id: string): StoredMessage | undefined {
    const row = this.db
      .prepare(`SELECT id, envelope_json, status, delivered_at, ack_json FROM messages WHERE id = ?`)
      .get(id) as
      | {
          id: string;
          envelope_json: string;
          status: StoredMessage['status'];
          delivered_at: string | null;
          ack_json: string | null;
        }
      | undefined;

    if (!row) return undefined;

    return {
      id: row.id,
      envelope: JSON.parse(row.envelope_json),
      status: row.status,
      ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
      ...(row.ack_json ? { ack: JSON.parse(row.ack_json) } : {}),
    };
  }

  update(id: string, updater: (existing: StoredMessage) => StoredMessage): StoredMessage | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const next = updater(existing);
    return this.save(next);
  }

  setProviderLink(link: ProviderResourceLink): void {
    this.db
      .prepare(
        `INSERT INTO provider_links (agreement_id, provider, provider_resource_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agreement_id) DO UPDATE SET
           provider = excluded.provider,
           provider_resource_id = excluded.provider_resource_id,
           updated_at = excluded.updated_at`
      )
      .run(link.agreementId, link.provider, link.providerResourceId, link.updatedAt);
  }

  getProviderLink(agreementId: string): ProviderResourceLink | undefined {
    const row = this.db
      .prepare(
        `SELECT agreement_id, provider, provider_resource_id, updated_at
         FROM provider_links WHERE agreement_id = ?`
      )
      .get(agreementId) as
      | {
          agreement_id: string;
          provider: string;
          provider_resource_id: string;
          updated_at: string;
        }
      | undefined;

    if (!row) return undefined;

    return {
      agreementId: row.agreement_id,
      provider: row.provider,
      providerResourceId: row.provider_resource_id,
      updatedAt: row.updated_at,
    };
  }

  setUsageCheckpoint(checkpoint: UsageCheckpoint): void {
    this.db
      .prepare(
        `INSERT INTO usage_checkpoints
         (agreement_id, provider, last_usage_timestamp, last_usage_digest, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agreement_id) DO UPDATE SET
           provider = excluded.provider,
           last_usage_timestamp = excluded.last_usage_timestamp,
           last_usage_digest = excluded.last_usage_digest,
           updated_at = excluded.updated_at`
      )
      .run(
        checkpoint.agreementId,
        checkpoint.provider,
        checkpoint.lastUsageTimestamp ?? null,
        checkpoint.lastUsageDigest ?? null,
        checkpoint.updatedAt
      );
  }

  getUsageCheckpoint(agreementId: string): UsageCheckpoint | undefined {
    const row = this.db
      .prepare(
        `SELECT agreement_id, provider, last_usage_timestamp, last_usage_digest, updated_at
         FROM usage_checkpoints WHERE agreement_id = ?`
      )
      .get(agreementId) as
      | {
          agreement_id: string;
          provider: string;
          last_usage_timestamp: string | null;
          last_usage_digest: string | null;
          updated_at: string;
        }
      | undefined;

    if (!row) return undefined;

    return {
      agreementId: row.agreement_id,
      provider: row.provider,
      ...(row.last_usage_timestamp ? { lastUsageTimestamp: row.last_usage_timestamp } : {}),
      ...(row.last_usage_digest ? { lastUsageDigest: row.last_usage_digest } : {}),
      updatedAt: row.updated_at,
    };
  }

  markEventProcessed(eventKey: string, blockNumber: number, logIndex: number): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO processed_events (event_key, block_number, log_index, processed_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(eventKey, blockNumber, logIndex, new Date().toISOString());
      return true;
    } catch {
      return false;
    }
  }
}

export function createDefaultStore(): MessageStore {
  const dbPath = process.env.RELAYER_DB_PATH;
  if (dbPath) {
    return new SQLiteMessageStore(dbPath);
  }

  return new InMemoryMessageStore();
}
