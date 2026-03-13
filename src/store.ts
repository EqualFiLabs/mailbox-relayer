import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { ComputeProvider } from './providers/types';
import { AdapterResultStatus } from './providers';
import { StoredMessage } from './types';

export interface ProviderResourceLink {
  agreementId: string;
  provider: ComputeProvider;
  providerResourceId: string;
  updatedAt: string;
}

export interface UsageCheckpoint {
  agreementId: string;
  provider: ComputeProvider;
  lastUsageTimestamp?: string;
  lastUsageDigest?: string;
  updatedAt: string;
}

export type AgreementState =
  | 'active'
  | 'activation_failed'
  | 'mailbox_received'
  | 'breach_detected'
  | 'default_detected';

export interface AgreementStateRecord {
  agreementId: string;
  state: AgreementState;
  updatedAt: string;
  traceId?: string;
}

export interface UsageSubmissionRecord {
  id: string;
  agreementId: string;
  provider: ComputeProvider;
  to: string;
  usageDigest: string;
  items: Array<{
    unitType: string;
    amount: string;
  }>;
  finalPass: boolean;
  createdAt: string;
  from?: string;
}

export interface UsageSettlementAttemptRecord {
  id: string;
  submissionId: string;
  agreementId: string;
  provider: ComputeProvider;
  attempt: number;
  status: AdapterResultStatus;
  settled: boolean;
  at: string;
  txHash?: string;
  message?: string;
  nextRetryAt?: string;
}

export interface KillSwitchRecord {
  agreementId: string;
  active: boolean;
  reason: string;
  triggeredBy: 'breach' | 'default' | 'manual' | 'retry';
  activatedAt: string;
  updatedAt: string;
  provider?: ComputeProvider;
  sourceEventKey?: string;
  lastTerminationStatus?: AdapterResultStatus;
}

export interface TerminationAttemptRecord {
  id: string;
  agreementId: string;
  provider: ComputeProvider;
  attempt: number;
  status: AdapterResultStatus;
  terminated: boolean;
  reason: string;
  at: string;
  providerResourceId?: string;
  message?: string;
  nextRetryAt?: string;
}

export interface MessageStore {
  save(message: StoredMessage): StoredMessage;
  get(id: string): StoredMessage | undefined;
  update(id: string, updater: (existing: StoredMessage) => StoredMessage): StoredMessage | undefined;

  setProviderLink(link: ProviderResourceLink): void;
  getProviderLink(agreementId: string): ProviderResourceLink | undefined;
  listProviderLinks(): ProviderResourceLink[];

  setUsageCheckpoint(checkpoint: UsageCheckpoint): void;
  getUsageCheckpoint(agreementId: string): UsageCheckpoint | undefined;

  addUsageSubmission(record: UsageSubmissionRecord): void;
  getUsageSubmission(id: string): UsageSubmissionRecord | undefined;
  listUsageSubmissions(limit?: number): UsageSubmissionRecord[];
  listUnattemptedUsageSubmissions(limit?: number): UsageSubmissionRecord[];

  addUsageSettlementAttempt(record: UsageSettlementAttemptRecord): void;
  getLatestUsageSettlementAttempt(submissionId: string): UsageSettlementAttemptRecord | undefined;
  listUsageSettlementAttempts(submissionId?: string, limit?: number): UsageSettlementAttemptRecord[];
  listDueUsageSettlementRetries(nowIso: string, limit?: number): UsageSettlementAttemptRecord[];

  setAgreementState(record: AgreementStateRecord): void;
  getAgreementState(agreementId: string): AgreementStateRecord | undefined;

  setKillSwitch(record: KillSwitchRecord): void;
  getKillSwitch(agreementId: string): KillSwitchRecord | undefined;
  listActiveKillSwitches(limit?: number): KillSwitchRecord[];

  addTerminationAttempt(record: TerminationAttemptRecord): void;
  getLatestTerminationAttempt(agreementId: string): TerminationAttemptRecord | undefined;
  listTerminationAttempts(agreementId?: string, limit?: number): TerminationAttemptRecord[];
  listDueTerminationRetries(nowIso: string, limit?: number): TerminationAttemptRecord[];

  markEventProcessed(eventKey: string, blockNumber: number, logIndex: number): boolean;
}

export class InMemoryMessageStore implements MessageStore {
  private readonly messages = new Map<string, StoredMessage>();
  private readonly providerLinks = new Map<string, ProviderResourceLink>();
  private readonly usageCheckpoints = new Map<string, UsageCheckpoint>();
  private readonly usageSubmissions: UsageSubmissionRecord[] = [];
  private readonly usageSettlementAttempts: UsageSettlementAttemptRecord[] = [];
  private readonly agreementStates = new Map<string, AgreementStateRecord>();
  private readonly killSwitches = new Map<string, KillSwitchRecord>();
  private readonly terminationAttempts: TerminationAttemptRecord[] = [];
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

  listProviderLinks(): ProviderResourceLink[] {
    return [...this.providerLinks.values()].sort((a, b) => a.agreementId.localeCompare(b.agreementId));
  }

  setUsageCheckpoint(checkpoint: UsageCheckpoint): void {
    this.usageCheckpoints.set(checkpoint.agreementId, checkpoint);
  }

  getUsageCheckpoint(agreementId: string): UsageCheckpoint | undefined {
    return this.usageCheckpoints.get(agreementId);
  }

  addUsageSubmission(record: UsageSubmissionRecord): void {
    this.usageSubmissions.push(record);
  }

  getUsageSubmission(id: string): UsageSubmissionRecord | undefined {
    return this.usageSubmissions.find((s) => s.id === id);
  }

  listUsageSubmissions(limit = 50): UsageSubmissionRecord[] {
    return this.usageSubmissions.slice(-limit).reverse();
  }

  listUnattemptedUsageSubmissions(limit = 20): UsageSubmissionRecord[] {
    const attempted = new Set(this.usageSettlementAttempts.map((a) => a.submissionId));
    return this.usageSubmissions.filter((s) => !attempted.has(s.id)).slice(0, limit);
  }

  addUsageSettlementAttempt(record: UsageSettlementAttemptRecord): void {
    this.usageSettlementAttempts.push(record);
  }

  getLatestUsageSettlementAttempt(submissionId: string): UsageSettlementAttemptRecord | undefined {
    return this.usageSettlementAttempts
      .filter((r) => r.submissionId === submissionId)
      .sort((a, b) => {
        if (a.at === b.at) return b.attempt - a.attempt;
        return b.at.localeCompare(a.at);
      })[0];
  }

  listUsageSettlementAttempts(submissionId?: string, limit = 50): UsageSettlementAttemptRecord[] {
    const filtered = submissionId
      ? this.usageSettlementAttempts.filter((r) => r.submissionId === submissionId)
      : this.usageSettlementAttempts;

    return [...filtered]
      .sort((a, b) => {
        if (a.at === b.at) return b.attempt - a.attempt;
        return b.at.localeCompare(a.at);
      })
      .slice(0, limit);
  }

  listDueUsageSettlementRetries(nowIso: string, limit = 20): UsageSettlementAttemptRecord[] {
    const now = Date.parse(nowIso);
    if (Number.isNaN(now)) return [];

    const latestBySubmission = new Map<string, UsageSettlementAttemptRecord>();

    for (const attempt of this.usageSettlementAttempts) {
      const existing = latestBySubmission.get(attempt.submissionId);
      if (!existing || attempt.at > existing.at || (attempt.at === existing.at && attempt.attempt > existing.attempt)) {
        latestBySubmission.set(attempt.submissionId, attempt);
      }
    }

    return [...latestBySubmission.values()]
      .filter((attempt) => {
        if (attempt.settled) return false;
        if (!attempt.nextRetryAt) return false;
        return Date.parse(attempt.nextRetryAt) <= now;
      })
      .sort((a, b) => (a.nextRetryAt ?? '').localeCompare(b.nextRetryAt ?? ''))
      .slice(0, limit);
  }

  setAgreementState(record: AgreementStateRecord): void {
    this.agreementStates.set(record.agreementId, record);
  }

  getAgreementState(agreementId: string): AgreementStateRecord | undefined {
    return this.agreementStates.get(agreementId);
  }

  setKillSwitch(record: KillSwitchRecord): void {
    this.killSwitches.set(record.agreementId, record);
  }

  getKillSwitch(agreementId: string): KillSwitchRecord | undefined {
    return this.killSwitches.get(agreementId);
  }

  listActiveKillSwitches(limit = 50): KillSwitchRecord[] {
    return [...this.killSwitches.values()]
      .filter((ks) => ks.active)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  addTerminationAttempt(record: TerminationAttemptRecord): void {
    this.terminationAttempts.push(record);
  }

  getLatestTerminationAttempt(agreementId: string): TerminationAttemptRecord | undefined {
    return this.terminationAttempts
      .filter((r) => r.agreementId === agreementId)
      .sort((a, b) => b.at.localeCompare(a.at))[0];
  }

  listTerminationAttempts(agreementId?: string, limit = 50): TerminationAttemptRecord[] {
    const filtered = agreementId
      ? this.terminationAttempts.filter((r) => r.agreementId === agreementId)
      : this.terminationAttempts;

    return [...filtered].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }

  listDueTerminationRetries(nowIso: string, limit = 20): TerminationAttemptRecord[] {
    const now = Date.parse(nowIso);
    if (Number.isNaN(now)) return [];

    const latestByAgreement = new Map<string, TerminationAttemptRecord>();

    for (const attempt of this.terminationAttempts) {
      const existing = latestByAgreement.get(attempt.agreementId);
      if (!existing || attempt.at > existing.at) {
        latestByAgreement.set(attempt.agreementId, attempt);
      }
    }

    return [...latestByAgreement.values()]
      .filter((attempt) => {
        if (attempt.terminated) return false;
        if (!attempt.nextRetryAt) return false;
        if (Date.parse(attempt.nextRetryAt) > now) return false;
        const ks = this.killSwitches.get(attempt.agreementId);
        return Boolean(ks?.active);
      })
      .sort((a, b) => (a.nextRetryAt ?? '').localeCompare(b.nextRetryAt ?? ''))
      .slice(0, limit);
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

      CREATE TABLE IF NOT EXISTS usage_submissions (
        id TEXT PRIMARY KEY,
        agreement_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        from_ts TEXT,
        to_ts TEXT NOT NULL,
        usage_digest TEXT NOT NULL,
        items_json TEXT NOT NULL,
        final_pass INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_settlement_attempts (
        id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL,
        agreement_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        settled INTEGER NOT NULL,
        tx_hash TEXT,
        message TEXT,
        next_retry_at TEXT,
        at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agreement_states (
        agreement_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        trace_id TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kill_switches (
        agreement_id TEXT PRIMARY KEY,
        active INTEGER NOT NULL,
        reason TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        provider TEXT,
        source_event_key TEXT,
        last_termination_status TEXT,
        activated_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS termination_attempts (
        id TEXT PRIMARY KEY,
        agreement_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_resource_id TEXT,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        terminated INTEGER NOT NULL,
        reason TEXT NOT NULL,
        message TEXT,
        next_retry_at TEXT,
        at TEXT NOT NULL
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
          provider: ComputeProvider;
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

  listProviderLinks(): ProviderResourceLink[] {
    const rows = this.db
      .prepare(
        `SELECT agreement_id, provider, provider_resource_id, updated_at
         FROM provider_links
         ORDER BY agreement_id ASC`
      )
      .all() as Array<{
      agreement_id: string;
      provider: ComputeProvider;
      provider_resource_id: string;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      agreementId: row.agreement_id,
      provider: row.provider,
      providerResourceId: row.provider_resource_id,
      updatedAt: row.updated_at,
    }));
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
          provider: ComputeProvider;
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

  addUsageSubmission(record: UsageSubmissionRecord): void {
    this.db
      .prepare(
        `INSERT INTO usage_submissions
         (id, agreement_id, provider, from_ts, to_ts, usage_digest, items_json, final_pass, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.agreementId,
        record.provider,
        record.from ?? null,
        record.to,
        record.usageDigest,
        JSON.stringify(record.items),
        record.finalPass ? 1 : 0,
        record.createdAt
      );
  }

  getUsageSubmission(id: string): UsageSubmissionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, agreement_id, provider, from_ts, to_ts, usage_digest, items_json, final_pass, created_at
         FROM usage_submissions WHERE id = ?`
      )
      .get(id) as
      | {
          id: string;
          agreement_id: string;
          provider: ComputeProvider;
          from_ts: string | null;
          to_ts: string;
          usage_digest: string;
          items_json: string;
          final_pass: number;
          created_at: string;
        }
      | undefined;

    return row ? rowToUsageSubmission(row) : undefined;
  }

  listUsageSubmissions(limit = 50): UsageSubmissionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, agreement_id, provider, from_ts, to_ts, usage_digest, items_json, final_pass, created_at
         FROM usage_submissions
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as Array<{
      id: string;
      agreement_id: string;
      provider: ComputeProvider;
      from_ts: string | null;
      to_ts: string;
      usage_digest: string;
      items_json: string;
      final_pass: number;
      created_at: string;
    }>;

    return rows.map(rowToUsageSubmission);
  }

  listUnattemptedUsageSubmissions(limit = 20): UsageSubmissionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.agreement_id, s.provider, s.from_ts, s.to_ts, s.usage_digest, s.items_json, s.final_pass, s.created_at
         FROM usage_submissions s
         LEFT JOIN usage_settlement_attempts a ON a.submission_id = s.id
         WHERE a.submission_id IS NULL
         ORDER BY s.created_at ASC
         LIMIT ?`
      )
      .all(limit) as Array<{
      id: string;
      agreement_id: string;
      provider: ComputeProvider;
      from_ts: string | null;
      to_ts: string;
      usage_digest: string;
      items_json: string;
      final_pass: number;
      created_at: string;
    }>;

    return rows.map(rowToUsageSubmission);
  }

  addUsageSettlementAttempt(record: UsageSettlementAttemptRecord): void {
    this.db
      .prepare(
        `INSERT INTO usage_settlement_attempts
         (id, submission_id, agreement_id, provider, attempt, status, settled, tx_hash, message, next_retry_at, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.submissionId,
        record.agreementId,
        record.provider,
        record.attempt,
        record.status,
        record.settled ? 1 : 0,
        record.txHash ?? null,
        record.message ?? null,
        record.nextRetryAt ?? null,
        record.at
      );
  }

  getLatestUsageSettlementAttempt(submissionId: string): UsageSettlementAttemptRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, submission_id, agreement_id, provider, attempt, status, settled, tx_hash, message, next_retry_at, at
         FROM usage_settlement_attempts
         WHERE submission_id = ?
         ORDER BY at DESC, attempt DESC
         LIMIT 1`
      )
      .get(submissionId) as
      | {
          id: string;
          submission_id: string;
          agreement_id: string;
          provider: ComputeProvider;
          attempt: number;
          status: AdapterResultStatus;
          settled: number;
          tx_hash: string | null;
          message: string | null;
          next_retry_at: string | null;
          at: string;
        }
      | undefined;

    return row ? rowToUsageSettlementAttempt(row) : undefined;
  }

  listUsageSettlementAttempts(submissionId?: string, limit = 50): UsageSettlementAttemptRecord[] {
    const rows = submissionId
      ? (this.db
          .prepare(
            `SELECT id, submission_id, agreement_id, provider, attempt, status, settled, tx_hash, message, next_retry_at, at
             FROM usage_settlement_attempts
             WHERE submission_id = ?
             ORDER BY at DESC, attempt DESC
             LIMIT ?`
          )
          .all(submissionId, limit) as Array<{
          id: string;
          submission_id: string;
          agreement_id: string;
          provider: ComputeProvider;
          attempt: number;
          status: AdapterResultStatus;
          settled: number;
          tx_hash: string | null;
          message: string | null;
          next_retry_at: string | null;
          at: string;
        }>)
      : (this.db
          .prepare(
            `SELECT id, submission_id, agreement_id, provider, attempt, status, settled, tx_hash, message, next_retry_at, at
             FROM usage_settlement_attempts
             ORDER BY at DESC, attempt DESC
             LIMIT ?`
          )
          .all(limit) as Array<{
          id: string;
          submission_id: string;
          agreement_id: string;
          provider: ComputeProvider;
          attempt: number;
          status: AdapterResultStatus;
          settled: number;
          tx_hash: string | null;
          message: string | null;
          next_retry_at: string | null;
          at: string;
        }>);

    return rows.map(rowToUsageSettlementAttempt);
  }

  listDueUsageSettlementRetries(nowIso: string, limit = 20): UsageSettlementAttemptRecord[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.submission_id, a.agreement_id, a.provider, a.attempt, a.status, a.settled, a.tx_hash, a.message, a.next_retry_at, a.at
         FROM usage_settlement_attempts a
         INNER JOIN (
           SELECT submission_id, MAX(attempt) AS max_attempt
           FROM usage_settlement_attempts
           GROUP BY submission_id
         ) latest ON latest.submission_id = a.submission_id AND latest.max_attempt = a.attempt
         WHERE a.settled = 0
           AND a.next_retry_at IS NOT NULL
           AND a.next_retry_at <= ?
         ORDER BY a.next_retry_at ASC
         LIMIT ?`
      )
      .all(nowIso, limit) as Array<{
      id: string;
      submission_id: string;
      agreement_id: string;
      provider: ComputeProvider;
      attempt: number;
      status: AdapterResultStatus;
      settled: number;
      tx_hash: string | null;
      message: string | null;
      next_retry_at: string | null;
      at: string;
    }>;

    return rows.map(rowToUsageSettlementAttempt);
  }

  setAgreementState(record: AgreementStateRecord): void {
    this.db
      .prepare(
        `INSERT INTO agreement_states (agreement_id, state, trace_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agreement_id) DO UPDATE SET
           state = excluded.state,
           trace_id = excluded.trace_id,
           updated_at = excluded.updated_at`
      )
      .run(record.agreementId, record.state, record.traceId ?? null, record.updatedAt);
  }

  getAgreementState(agreementId: string): AgreementStateRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT agreement_id, state, trace_id, updated_at
         FROM agreement_states WHERE agreement_id = ?`
      )
      .get(agreementId) as
      | {
          agreement_id: string;
          state: AgreementState;
          trace_id: string | null;
          updated_at: string;
        }
      | undefined;

    if (!row) return undefined;

    return {
      agreementId: row.agreement_id,
      state: row.state,
      ...(row.trace_id ? { traceId: row.trace_id } : {}),
      updatedAt: row.updated_at,
    };
  }

  setKillSwitch(record: KillSwitchRecord): void {
    this.db
      .prepare(
        `INSERT INTO kill_switches
         (agreement_id, active, reason, triggered_by, provider, source_event_key, last_termination_status, activated_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agreement_id) DO UPDATE SET
           active = excluded.active,
           reason = excluded.reason,
           triggered_by = excluded.triggered_by,
           provider = excluded.provider,
           source_event_key = excluded.source_event_key,
           last_termination_status = excluded.last_termination_status,
           activated_at = excluded.activated_at,
           updated_at = excluded.updated_at`
      )
      .run(
        record.agreementId,
        record.active ? 1 : 0,
        record.reason,
        record.triggeredBy,
        record.provider ?? null,
        record.sourceEventKey ?? null,
        record.lastTerminationStatus ?? null,
        record.activatedAt,
        record.updatedAt
      );
  }

  getKillSwitch(agreementId: string): KillSwitchRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT agreement_id, active, reason, triggered_by, provider, source_event_key, last_termination_status, activated_at, updated_at
         FROM kill_switches WHERE agreement_id = ?`
      )
      .get(agreementId) as
      | {
          agreement_id: string;
          active: number;
          reason: string;
          triggered_by: KillSwitchRecord['triggeredBy'];
          provider: ComputeProvider | null;
          source_event_key: string | null;
          last_termination_status: AdapterResultStatus | null;
          activated_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) return undefined;

    return {
      agreementId: row.agreement_id,
      active: Boolean(row.active),
      reason: row.reason,
      triggeredBy: row.triggered_by,
      ...(row.provider ? { provider: row.provider } : {}),
      ...(row.source_event_key ? { sourceEventKey: row.source_event_key } : {}),
      ...(row.last_termination_status ? { lastTerminationStatus: row.last_termination_status } : {}),
      activatedAt: row.activated_at,
      updatedAt: row.updated_at,
    };
  }

  listActiveKillSwitches(limit = 50): KillSwitchRecord[] {
    const rows = this.db
      .prepare(
        `SELECT agreement_id, active, reason, triggered_by, provider, source_event_key, last_termination_status, activated_at, updated_at
         FROM kill_switches
         WHERE active = 1
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(limit) as Array<{
      agreement_id: string;
      active: number;
      reason: string;
      triggered_by: KillSwitchRecord['triggeredBy'];
      provider: ComputeProvider | null;
      source_event_key: string | null;
      last_termination_status: AdapterResultStatus | null;
      activated_at: string;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      agreementId: row.agreement_id,
      active: Boolean(row.active),
      reason: row.reason,
      triggeredBy: row.triggered_by,
      ...(row.provider ? { provider: row.provider } : {}),
      ...(row.source_event_key ? { sourceEventKey: row.source_event_key } : {}),
      ...(row.last_termination_status ? { lastTerminationStatus: row.last_termination_status } : {}),
      activatedAt: row.activated_at,
      updatedAt: row.updated_at,
    }));
  }

  addTerminationAttempt(record: TerminationAttemptRecord): void {
    this.db
      .prepare(
        `INSERT INTO termination_attempts
         (id, agreement_id, provider, provider_resource_id, attempt, status, terminated, reason, message, next_retry_at, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.agreementId,
        record.provider,
        record.providerResourceId ?? null,
        record.attempt,
        record.status,
        record.terminated ? 1 : 0,
        record.reason,
        record.message ?? null,
        record.nextRetryAt ?? null,
        record.at
      );
  }

  getLatestTerminationAttempt(agreementId: string): TerminationAttemptRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, agreement_id, provider, provider_resource_id, attempt, status, terminated, reason, message, next_retry_at, at
         FROM termination_attempts
         WHERE agreement_id = ?
         ORDER BY at DESC, attempt DESC
         LIMIT 1`
      )
      .get(agreementId) as
      | {
          id: string;
          agreement_id: string;
          provider: ComputeProvider;
          provider_resource_id: string | null;
          attempt: number;
          status: AdapterResultStatus;
          terminated: number;
          reason: string;
          message: string | null;
          next_retry_at: string | null;
          at: string;
        }
      | undefined;

    return row ? rowToTerminationAttempt(row) : undefined;
  }

  listTerminationAttempts(agreementId?: string, limit = 50): TerminationAttemptRecord[] {
    const rows = agreementId
      ? (this.db
          .prepare(
            `SELECT id, agreement_id, provider, provider_resource_id, attempt, status, terminated, reason, message, next_retry_at, at
             FROM termination_attempts
             WHERE agreement_id = ?
             ORDER BY at DESC, attempt DESC
             LIMIT ?`
          )
          .all(agreementId, limit) as Array<{
          id: string;
          agreement_id: string;
          provider: ComputeProvider;
          provider_resource_id: string | null;
          attempt: number;
          status: AdapterResultStatus;
          terminated: number;
          reason: string;
          message: string | null;
          next_retry_at: string | null;
          at: string;
        }>)
      : (this.db
          .prepare(
            `SELECT id, agreement_id, provider, provider_resource_id, attempt, status, terminated, reason, message, next_retry_at, at
             FROM termination_attempts
             ORDER BY at DESC, attempt DESC
             LIMIT ?`
          )
          .all(limit) as Array<{
          id: string;
          agreement_id: string;
          provider: ComputeProvider;
          provider_resource_id: string | null;
          attempt: number;
          status: AdapterResultStatus;
          terminated: number;
          reason: string;
          message: string | null;
          next_retry_at: string | null;
          at: string;
        }>);

    return rows.map(rowToTerminationAttempt);
  }

  listDueTerminationRetries(nowIso: string, limit = 20): TerminationAttemptRecord[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.agreement_id, t.provider, t.provider_resource_id, t.attempt, t.status, t.terminated, t.reason, t.message, t.next_retry_at, t.at
         FROM termination_attempts t
         INNER JOIN (
           SELECT agreement_id, MAX(attempt) AS max_attempt
           FROM termination_attempts
           GROUP BY agreement_id
         ) latest ON latest.agreement_id = t.agreement_id AND latest.max_attempt = t.attempt
         INNER JOIN kill_switches ks ON ks.agreement_id = t.agreement_id AND ks.active = 1
         WHERE t.terminated = 0
           AND t.next_retry_at IS NOT NULL
           AND t.next_retry_at <= ?
         ORDER BY t.next_retry_at ASC
         LIMIT ?`
      )
      .all(nowIso, limit) as Array<{
      id: string;
      agreement_id: string;
      provider: ComputeProvider;
      provider_resource_id: string | null;
      attempt: number;
      status: AdapterResultStatus;
      terminated: number;
      reason: string;
      message: string | null;
      next_retry_at: string | null;
      at: string;
    }>;

    return rows.map(rowToTerminationAttempt);
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

function rowToUsageSubmission(row: {
  id: string;
  agreement_id: string;
  provider: ComputeProvider;
  from_ts: string | null;
  to_ts: string;
  usage_digest: string;
  items_json: string;
  final_pass: number;
  created_at: string;
}): UsageSubmissionRecord {
  return {
    id: row.id,
    agreementId: row.agreement_id,
    provider: row.provider,
    ...(row.from_ts ? { from: row.from_ts } : {}),
    to: row.to_ts,
    usageDigest: row.usage_digest,
    items: JSON.parse(row.items_json),
    finalPass: Boolean(row.final_pass),
    createdAt: row.created_at,
  };
}

function rowToUsageSettlementAttempt(row: {
  id: string;
  submission_id: string;
  agreement_id: string;
  provider: ComputeProvider;
  attempt: number;
  status: AdapterResultStatus;
  settled: number;
  tx_hash: string | null;
  message: string | null;
  next_retry_at: string | null;
  at: string;
}): UsageSettlementAttemptRecord {
  return {
    id: row.id,
    submissionId: row.submission_id,
    agreementId: row.agreement_id,
    provider: row.provider,
    attempt: row.attempt,
    status: row.status,
    settled: Boolean(row.settled),
    ...(row.tx_hash ? { txHash: row.tx_hash } : {}),
    ...(row.message ? { message: row.message } : {}),
    ...(row.next_retry_at ? { nextRetryAt: row.next_retry_at } : {}),
    at: row.at,
  };
}

function rowToTerminationAttempt(row: {
  id: string;
  agreement_id: string;
  provider: ComputeProvider;
  provider_resource_id: string | null;
  attempt: number;
  status: AdapterResultStatus;
  terminated: number;
  reason: string;
  message: string | null;
  next_retry_at: string | null;
  at: string;
}): TerminationAttemptRecord {
  return {
    id: row.id,
    agreementId: row.agreement_id,
    provider: row.provider,
    ...(row.provider_resource_id ? { providerResourceId: row.provider_resource_id } : {}),
    attempt: row.attempt,
    status: row.status,
    terminated: Boolean(row.terminated),
    reason: row.reason,
    ...(row.message ? { message: row.message } : {}),
    ...(row.next_retry_at ? { nextRetryAt: row.next_retry_at } : {}),
    at: row.at,
  };
}

export function createDefaultStore(): MessageStore {
  const dbPath = process.env.RELAYER_DB_PATH;
  if (dbPath) {
    return new SQLiteMessageStore(dbPath);
  }

  return new InMemoryMessageStore();
}
