import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ComputeProviderAdapter,
  ProvisionRequest,
  ProvisionResult,
  TerminateRequest,
  TerminateResult,
  UsageRequest,
  UsageResult,
} from './types';

type FetchLike = typeof fetch;

export interface BankrKeyPoolEntry {
  id: string;
  apiKey: string;
}

interface BankrAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  usagePath?: string;
  fetchFn?: FetchLike;
  maxUsagePages?: number;
  strictKeyPerAgreement?: boolean;
  keyPool?: BankrKeyPoolEntry[];
}

interface BankrAssignment {
  credentialId: string;
  apiKey: string;
  fingerprint: string;
}

interface BankrApiResponse<T = unknown> {
  data?: T;
  [key: string]: unknown;
}

export class BankrComputeAdapter implements ComputeProviderAdapter {
  readonly provider = 'bankr' as const;

  private readonly defaultApiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly usagePath: string;
  private readonly fetchFn: FetchLike;
  private readonly maxUsagePages: number;
  private readonly strictKeyPerAgreement: boolean;
  private readonly keyPool: BankrAssignment[];

  private readonly assignmentByAgreement = new Map<string, BankrAssignment>();
  private readonly agreementByCredential = new Map<string, string>();
  private readonly agreementByFingerprint = new Map<string, string>();

  constructor(options: BankrAdapterOptions = {}) {
    this.defaultApiKey = options.apiKey ?? process.env.BANKR_LLM_KEY;
    this.baseUrl = (options.baseUrl ?? process.env.BANKR_LLM_BASE_URL ?? 'https://llm.bankr.bot').replace(/\/$/, '');
    this.usagePath = options.usagePath ?? process.env.BANKR_USAGE_PATH ?? '/usage';
    this.fetchFn = options.fetchFn ?? fetch;
    this.maxUsagePages = options.maxUsagePages ?? Number(process.env.BANKR_USAGE_MAX_PAGES ?? 50);
    this.strictKeyPerAgreement = options.strictKeyPerAgreement ?? process.env.BANKR_KEY_POOL_STRICT !== 'false';
    this.keyPool = this.normalizeKeyPool(options.keyPool ?? this.readKeyPoolFromEnv());
  }

  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    const existing = this.assignmentByAgreement.get(request.agreementId);
    if (existing) {
      return this.successProvision(request, existing, 'existing_assignment');
    }

    const selected = this.selectAssignment(request);
    if (!selected.ok) {
      return {
        status: 'error',
        provider: this.provider,
        message: selected.error,
        meta: { agreementId: request.agreementId },
      };
    }

    const conflictByCredential = this.agreementByCredential.get(selected.assignment.credentialId);
    if (conflictByCredential && conflictByCredential !== request.agreementId) {
      return {
        status: 'error',
        provider: this.provider,
        message: `credential '${selected.assignment.credentialId}' is already assigned to agreement ${conflictByCredential}`,
        meta: {
          agreementId: request.agreementId,
          conflictingAgreementId: conflictByCredential,
          providerResourceId: selected.assignment.credentialId,
        },
      };
    }

    if (this.strictKeyPerAgreement) {
      const conflictByFingerprint = this.agreementByFingerprint.get(selected.assignment.fingerprint);
      if (conflictByFingerprint && conflictByFingerprint !== request.agreementId) {
        return {
          status: 'error',
          provider: this.provider,
          message: 'key fingerprint already assigned to another active agreement',
          meta: {
            agreementId: request.agreementId,
            conflictingAgreementId: conflictByFingerprint,
            keyFingerprint: selected.assignment.fingerprint,
          },
        };
      }
    }

    this.assignmentByAgreement.set(request.agreementId, selected.assignment);
    this.agreementByCredential.set(selected.assignment.credentialId, request.agreementId);
    if (this.strictKeyPerAgreement) {
      this.agreementByFingerprint.set(selected.assignment.fingerprint, request.agreementId);
    }

    return this.successProvision(request, selected.assignment, selected.source);
  }

  async usage(request: UsageRequest): Promise<UsageResult> {
    const assignment = this.resolveAssignment(request.agreementId, request.providerResourceId);
    const apiKey = assignment?.apiKey ?? this.defaultApiKey;

    if (!apiKey) {
      return {
        status: 'error',
        provider: this.provider,
        usage: [],
        message: 'Bankr API key is not configured (BANKR_LLM_KEY or key pool required).',
        meta: { agreementId: request.agreementId },
      };
    }

    const pageResult = await this.fetchUsagePages(request, apiKey);
    if (!pageResult.ok) {
      return {
        status: 'error',
        provider: this.provider,
        usage: [],
        message: pageResult.error ?? 'Failed to fetch Bankr usage.',
        meta: {
          agreementId: request.agreementId,
          ...(request.providerResourceId ? { providerResourceId: request.providerResourceId } : {}),
          ...(pageResult.statusCode !== undefined ? { statusCode: pageResult.statusCode } : {}),
        },
      };
    }

    const usage: UsageResult['usage'] = [];
    const quarantined: Array<{ reason: string; row: Record<string, unknown> }> = [];

    for (const row of pageResult.rows) {
      const normalized = this.normalizeUsageRow(row);
      if (normalized.ok) {
        usage.push(normalized.row);
      } else {
        quarantined.push({ reason: normalized.reason, row });
      }
    }

    if (quarantined.length > 0) {
      return {
        status: 'error',
        provider: this.provider,
        usage: [],
        message: 'Usage rows quarantined due to unmappable/invalid fields.',
        meta: {
          agreementId: request.agreementId,
          ...(request.providerResourceId ? { providerResourceId: request.providerResourceId } : {}),
          rowCount: pageResult.rows.length,
          quarantinedCount: quarantined.length,
          quarantinedSample: quarantined.slice(0, 5),
        },
      };
    }

    return {
      status: 'ok',
      provider: this.provider,
      usage,
      meta: {
        agreementId: request.agreementId,
        ...(request.providerResourceId ? { providerResourceId: request.providerResourceId } : {}),
        rowCount: pageResult.rows.length,
        pagesFetched: pageResult.pagesFetched,
      },
    };
  }

  async terminate(request: TerminateRequest): Promise<TerminateResult> {
    const assignment = this.resolveAssignment(request.agreementId, request.providerResourceId);
    const providerResourceId = request.providerResourceId ?? assignment?.credentialId;

    this.releaseAssignment(request.agreementId);

    return {
      status: 'ok',
      provider: this.provider,
      terminated: true,
      message: 'Bankr soft kill applied; hard revoke follow-up required.',
      meta: {
        agreementId: request.agreementId,
        ...(providerResourceId ? { providerResourceId } : {}),
        reason: request.reason,
        softKill: true,
        providerAccessDisabled: true,
        hardRevokeFollowUpRequired: true,
      },
    };
  }

  private successProvision(request: ProvisionRequest, assignment: BankrAssignment, source: string): ProvisionResult {
    return {
      status: 'ok',
      provider: this.provider,
      providerResourceId: assignment.credentialId,
      connection: {
        baseUrl: this.baseUrl,
        apiKey: assignment.apiKey,
        headers: {
          Authorization: `Bearer ${assignment.apiKey}`,
          'X-API-Key': assignment.apiKey,
        },
      },
      meta: {
        agreementId: request.agreementId,
        traceId: request.traceId,
        keySource: source,
        keyFingerprint: assignment.fingerprint,
      },
    };
  }

  private resolveAssignment(agreementId: string, providerResourceId?: string): BankrAssignment | undefined {
    const byAgreement = this.assignmentByAgreement.get(agreementId);
    if (byAgreement) return byAgreement;

    if (providerResourceId) {
      const owner = this.agreementByCredential.get(providerResourceId);
      if (owner) {
        return this.assignmentByAgreement.get(owner);
      }
      return this.keyPool.find((entry) => entry.credentialId === providerResourceId);
    }

    return undefined;
  }

  private releaseAssignment(agreementId: string): void {
    const current = this.assignmentByAgreement.get(agreementId);
    if (!current) return;

    this.assignmentByAgreement.delete(agreementId);

    const credentialOwner = this.agreementByCredential.get(current.credentialId);
    if (credentialOwner === agreementId) {
      this.agreementByCredential.delete(current.credentialId);
    }

    const fingerprintOwner = this.agreementByFingerprint.get(current.fingerprint);
    if (fingerprintOwner === agreementId) {
      this.agreementByFingerprint.delete(current.fingerprint);
    }
  }

  private selectAssignment(
    request: ProvisionRequest
  ): { ok: true; assignment: BankrAssignment; source: string } | { ok: false; error: string } {
    const explicitId =
      this.readString(request.payload, ['bankrCredentialId', 'credentialId']) ??
      this.readString(request.policy, ['bankrCredentialId', 'credentialId']);
    const explicitKey =
      this.readString(request.payload, ['bankrLlmKey', 'llmKey', 'apiKey']) ??
      this.readString(request.policy, ['bankrLlmKey', 'llmKey', 'apiKey']);

    if (explicitId && explicitKey) {
      return {
        ok: true,
        assignment: this.toAssignment(explicitId, explicitKey),
        source: 'request_payload',
      };
    }

    if (explicitId) {
      const explicitEntry = this.keyPool.find((entry) => entry.credentialId === explicitId);
      if (!explicitEntry) {
        return { ok: false, error: `requested credential '${explicitId}' not found in configured key pool` };
      }
      return { ok: true, assignment: explicitEntry, source: 'key_pool_explicit' };
    }

    if (this.keyPool.length > 0) {
      const available = this.keyPool.find((entry) => {
        const usedByCredential = this.agreementByCredential.has(entry.credentialId);
        const usedByFingerprint = this.strictKeyPerAgreement && this.agreementByFingerprint.has(entry.fingerprint);
        return !usedByCredential && !usedByFingerprint;
      });

      if (!available) {
        return { ok: false, error: 'no unassigned Bankr key pool credential is available' };
      }

      return { ok: true, assignment: available, source: 'key_pool' };
    }

    if (this.defaultApiKey) {
      const credentialId = explicitId ?? `bankr:${request.agreementId}`;
      return {
        ok: true,
        assignment: this.toAssignment(credentialId, this.defaultApiKey),
        source: 'default_env_key',
      };
    }

    return {
      ok: false,
      error: 'Bankr provisioning requires BANKR_LLM_KEY or configured BANKR_KEY_POOL_* credentials.',
    };
  }

  private async fetchUsagePages(
    request: UsageRequest,
    apiKey: string
  ): Promise<
    | { ok: true; rows: Array<Record<string, unknown>>; pagesFetched: number }
    | { ok: false; error: string; statusCode?: number }
  > {
    const rows: Array<Record<string, unknown>> = [];

    let page = 1;
    let pagesFetched = 0;

    while (page <= this.maxUsagePages) {
      const query = new URLSearchParams();
      query.set('agreementId', request.agreementId);
      if (request.providerResourceId) query.set('providerResourceId', request.providerResourceId);
      if (request.from) query.set('from', request.from);
      if (request.to) query.set('to', request.to);
      if (page > 1) query.set('page', String(page));

      const path = this.usagePath.startsWith('/')
        ? `${this.usagePath}?${query.toString()}`
        : `/${this.usagePath}?${query.toString()}`;

      const result = await this.request<BankrApiResponse>(apiKey, 'GET', path);
      if (!result.ok || !result.data) {
        return {
          ok: false,
          error: result.error ?? 'bankr usage request failed',
          ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
        };
      }

      const pageRows = this.extractUsageRows(result.data);
      rows.push(...pageRows);
      pagesFetched += 1;

      const pagination = this.extractPagination(result.data);
      if (!pagination.hasNext) break;
      page = pagination.nextPage;
    }

    return { ok: true, rows, pagesFetched };
  }

  private async request<T = unknown>(
    apiKey: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    opts: { body?: Record<string, unknown> } = {}
  ): Promise<{ ok: boolean; data?: T; error?: string; statusCode?: number }> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
        },
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      });

      const statusCode = response.status;
      let json: T | undefined;
      try {
        json = (await response.json()) as T;
      } catch {
        json = undefined;
      }

      if (!response.ok) {
        const message =
          (json &&
          typeof json === 'object' &&
          json &&
          'error' in json &&
          typeof (json as Record<string, unknown>).error === 'string'
            ? ((json as Record<string, unknown>).error as string)
            : undefined) ?? `HTTP ${statusCode}`;
        return { ok: false, error: message, statusCode };
      }

      return json === undefined ? { ok: true, statusCode } : { ok: true, data: json, statusCode };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown Bankr request error',
      };
    }
  }

  private extractUsageRows(input: unknown): Array<Record<string, unknown>> {
    if (!input || typeof input !== 'object') return [];

    const obj = input as Record<string, unknown>;
    const candidates = [obj.data, obj.usage, obj.items, obj.results, obj.rows];

    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
      }

      if (candidate && typeof candidate === 'object') {
        const nested = candidate as Record<string, unknown>;
        for (const nestedKey of ['items', 'data', 'results', 'rows', 'usage']) {
          const maybe = nested[nestedKey];
          if (Array.isArray(maybe)) {
            return maybe.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
          }
        }
      }
    }

    return [];
  }

  private extractPagination(input: unknown): { hasNext: boolean; nextPage: number } {
    if (!input || typeof input !== 'object') return { hasNext: false, nextPage: 0 };
    const obj = input as Record<string, unknown>;

    const pagination = (obj.pagination && typeof obj.pagination === 'object'
      ? (obj.pagination as Record<string, unknown>)
      : undefined) ??
      (obj.meta && typeof obj.meta === 'object' ? (obj.meta as Record<string, unknown>) : undefined);

    if (!pagination) return { hasNext: false, nextPage: 0 };

    const page = this.readNumber(pagination, ['page']) ?? 1;
    const totalPages = this.readNumber(pagination, ['totalPages', 'pages']) ?? page;
    const hasNextFlag = this.readBoolean(pagination, ['hasNext']);

    if (hasNextFlag === true) return { hasNext: true, nextPage: page + 1 };
    if (page < totalPages) return { hasNext: true, nextPage: page + 1 };

    return { hasNext: false, nextPage: 0 };
  }

  private normalizeUsageRow(
    row: Record<string, unknown>
  ): { ok: true; row: UsageResult['usage'][number] } | { ok: false; reason: string } {
    const rawUnit = this.readString(row, ['unitType', 'metric', 'sku', 'type', 'name']);
    const unitType = rawUnit ? this.mapBankrUnitType(rawUnit) : undefined;
    if (!unitType) {
      return { ok: false, reason: 'unmappable_unit_type' };
    }

    const amountRaw = this.readString(row, ['amount']) ?? this.readNumber(row, ['amount'])?.toString();
    if (!amountRaw || !/^[-+]?\d+(\.\d+)?$/.test(amountRaw)) {
      return { ok: false, reason: 'invalid_amount' };
    }

    const observedAt =
      this.readString(row, ['observedAt', 'timestamp', 'at', 'createdAt']) ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(observedAt))) {
      return { ok: false, reason: 'invalid_observed_at' };
    }

    const requestId = this.readString(row, ['requestId', 'id', 'eventId']);

    return {
      ok: true,
      row: {
        unitType,
        amount: amountRaw,
        observedAt,
        ...(requestId ? { requestId } : {}),
      },
    };
  }

  private mapBankrUnitType(raw: string): string | undefined {
    const normalized = raw.toUpperCase();
    if (
      normalized.includes('PROMPT') ||
      normalized.includes('INPUT') ||
      normalized.includes('TOKEN_IN') ||
      normalized.includes('TOKENS_IN')
    ) {
      return 'BANKR_TEXT_TOKEN_IN';
    }
    if (
      normalized.includes('COMPLETION') ||
      normalized.includes('OUTPUT') ||
      normalized.includes('TOKEN_OUT') ||
      normalized.includes('TOKENS_OUT')
    ) {
      return 'BANKR_TEXT_TOKEN_OUT';
    }
    return undefined;
  }

  private readKeyPoolFromEnv(): BankrKeyPoolEntry[] {
    const entries: BankrKeyPoolEntry[] = [];

    const fromJson = process.env.BANKR_KEY_POOL_JSON;
    if (fromJson) {
      entries.push(...this.parseKeyPoolJson(fromJson));
    }

    const fromPath = process.env.BANKR_KEY_POOL_PATH;
    if (fromPath) {
      try {
        const text = readFileSync(fromPath, 'utf8');
        entries.push(...this.parseKeyPoolJson(text));
      } catch {
        // ignore malformed file path in v1; adapter will fall back to remaining sources.
      }
    }

    const prefix = process.env.BANKR_KEY_POOL_ENV_PREFIX ?? 'BANKR_KEY_POOL_KEY_';
    const prefixed = Object.entries(process.env)
      .filter(([key, value]) => key.startsWith(prefix) && typeof value === 'string' && value.trim().length > 0)
      .sort(([a], [b]) => a.localeCompare(b));

    for (const [envKey, envValue] of prefixed) {
      entries.push({
        id: envKey.slice(prefix.length).toLowerCase() || envKey.toLowerCase(),
        apiKey: envValue as string,
      });
    }

    return entries;
  }

  private parseKeyPoolJson(input: string): BankrKeyPoolEntry[] {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (!Array.isArray(parsed)) return [];

      const out: BankrKeyPoolEntry[] = [];
      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        if (typeof item === 'string' && item.trim().length > 0) {
          out.push({ id: `json-${i + 1}`, apiKey: item });
          continue;
        }

        if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          const id = this.readString(obj, ['id', 'credentialId']) ?? `json-${i + 1}`;
          const apiKey = this.readString(obj, ['apiKey', 'key', 'llmKey']);
          if (apiKey) {
            out.push({ id, apiKey });
          }
        }
      }

      return out;
    } catch {
      return [];
    }
  }

  private normalizeKeyPool(entries: BankrKeyPoolEntry[]): BankrAssignment[] {
    const out: BankrAssignment[] = [];
    for (const entry of entries) {
      if (!entry.id || !entry.apiKey) continue;
      out.push(this.toAssignment(entry.id, entry.apiKey));
    }
    return out;
  }

  private toAssignment(credentialId: string, apiKey: string): BankrAssignment {
    const fingerprint = createHash('sha256').update(apiKey).digest('hex').slice(0, 24);
    return { credentialId, apiKey, fingerprint };
  }

  private readString(input: unknown, keys: string[]): string | undefined {
    if (!input || typeof input !== 'object') return undefined;
    const obj = input as Record<string, unknown>;
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }
    return undefined;
  }

  private readNumber(input: unknown, keys: string[]): number | undefined {
    if (!input || typeof input !== 'object') return undefined;
    const obj = input as Record<string, unknown>;
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return undefined;
  }

  private readBoolean(input: unknown, keys: string[]): boolean | undefined {
    if (!input || typeof input !== 'object') return undefined;
    const obj = input as Record<string, unknown>;
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        if (value.toLowerCase() === 'true') return true;
        if (value.toLowerCase() === 'false') return false;
      }
    }
    return undefined;
  }
}
