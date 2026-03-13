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

interface VeniceAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: FetchLike;
  maxUsagePages?: number;
}

interface VeniceApiResponse<T = unknown> {
  data?: T;
  [key: string]: unknown;
}

export class VeniceComputeAdapter implements ComputeProviderAdapter {
  readonly provider = 'venice' as const;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly maxUsagePages: number;

  constructor(options: VeniceAdapterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.VENICE_API_KEY;
    this.baseUrl = (options.baseUrl ?? process.env.VENICE_BASE_URL ?? 'https://api.venice.ai/api/v1').replace(/\/$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
    this.maxUsagePages = options.maxUsagePages ?? 50;
  }

  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    if (!this.apiKey) {
      return {
        status: 'error',
        provider: this.provider,
        message: 'VENICE_API_KEY not configured.',
        meta: { agreementId: request.agreementId },
      };
    }

    const description =
      this.readString(request.policy, ['description']) ?? `equalfi-${request.agreementId}-${Date.now()}`;

    const apiKeyType = this.readString(request.policy, ['apiKeyType']) ?? 'INFERENCE';

    const expiresAt = this.readString(request.policy, ['expiresAt']);

    const consumptionLimit = this.readRecord(request.policy, ['consumptionLimit']) ?? { usd: 5 };

    const body: Record<string, unknown> = {
      description,
      apiKeyType,
      consumptionLimit,
      ...(expiresAt ? { expiresAt } : {}),
    };

    const create = await this.request<VeniceApiResponse<Record<string, unknown>>>('POST', '/api_keys', { body });

    if (!create.ok || !create.data) {
      return {
        status: 'error',
        provider: this.provider,
        message: create.error ?? 'Failed to create Venice API key.',
        meta: { agreementId: request.agreementId, statusCode: create.statusCode },
      };
    }

    const keyData = this.unwrapRecord(create.data);
    const keyId =
      this.pickFirstString(keyData, ['id', 'apiKeyId', 'keyId']) ?? this.pickFirstString(create.data, ['id', 'apiKeyId']);

    const secretKey = this.pickFirstString(keyData, ['apiKey', 'key', 'token', 'value', 'secret']) ?? undefined;

    if (!keyId || !secretKey) {
      return {
        status: 'error',
        provider: this.provider,
        message: 'Venice create key response missing key id or secret.',
        meta: { agreementId: request.agreementId, raw: create.data },
      };
    }

    return {
      status: 'ok',
      provider: this.provider,
      providerResourceId: keyId,
      connection: {
        baseUrl: this.baseUrl,
        apiKey: secretKey,
      },
      meta: {
        agreementId: request.agreementId,
        traceId: request.traceId,
        expiresAt,
      },
    };
  }

  async usage(request: UsageRequest): Promise<UsageResult> {
    if (!this.apiKey) {
      return {
        status: 'error',
        provider: this.provider,
        usage: [],
        message: 'VENICE_API_KEY not configured.',
        meta: { agreementId: request.agreementId },
      };
    }

    const baseQuery = new URLSearchParams();
    if (request.from) baseQuery.set('startDate', request.from);
    if (request.to) baseQuery.set('endDate', request.to);

    const pages = await this.fetchUsagePages(baseQuery);
    if (!pages.ok) {
      return {
        status: 'error',
        provider: this.provider,
        usage: [],
        message: pages.error ?? 'Failed to fetch Venice usage.',
        meta: {
          agreementId: request.agreementId,
          ...(pages.statusCode !== undefined ? { statusCode: pages.statusCode } : {}),
        },
      };
    }

    const usage: UsageResult['usage'] = [];
    const quarantined: Array<{ reason: string; row: Record<string, unknown> }> = [];

    for (const row of pages.rows) {
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
          providerResourceId: request.providerResourceId,
          rowCount: pages.rows.length,
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
        providerResourceId: request.providerResourceId,
        rowCount: pages.rows.length,
        pagesFetched: pages.pagesFetched,
      },
    };
  }

  async terminate(request: TerminateRequest): Promise<TerminateResult> {
    if (!this.apiKey) {
      return {
        status: 'error',
        provider: this.provider,
        terminated: false,
        message: 'VENICE_API_KEY not configured.',
        meta: { agreementId: request.agreementId },
      };
    }

    if (!request.providerResourceId) {
      return {
        status: 'error',
        provider: this.provider,
        terminated: false,
        message: 'providerResourceId is required for Venice key termination.',
        meta: { agreementId: request.agreementId },
      };
    }

    // Best-effort clamp before delete.
    await this.request('PATCH', '/api_keys', {
      body: {
        id: request.providerResourceId,
        consumptionLimit: { usd: 0 },
      },
    });

    const deleteAttempts = [
      await this.request('DELETE', `/api_keys?id=${encodeURIComponent(request.providerResourceId)}`),
      // Fallback for potential future path-style variants.
      await this.request('DELETE', `/api_keys/${request.providerResourceId}`),
    ];

    const deleteOk = deleteAttempts.some((result) => result.ok);
    const deleteNotFound = deleteAttempts.some(
      (result) => !result.ok && /could not be found|not found/i.test(result.error ?? '')
    );
    const terminated = deleteOk || deleteNotFound;

    return {
      status: terminated ? 'ok' : 'error',
      provider: this.provider,
      terminated,
      message: terminated ? 'Venice key revoked.' : 'Failed to revoke Venice key.',
      meta: {
        agreementId: request.agreementId,
        providerResourceId: request.providerResourceId,
        reason: request.reason,
      },
    };
  }

  private async request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    opts: { body?: Record<string, unknown> } = {}
  ): Promise<{ ok: boolean; data?: T; error?: string; statusCode?: number }> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
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
          (json && typeof json === 'object' && json && 'error' in json && typeof (json as Record<string, unknown>).error === 'string'
            ? ((json as Record<string, unknown>).error as string)
            : undefined) ?? `HTTP ${statusCode}`;

        return { ok: false, error: message, statusCode };
      }

      return json === undefined ? { ok: true, statusCode } : { ok: true, data: json, statusCode };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown Venice request error',
      };
    }
  }

  private unwrapRecord(input: unknown): Record<string, unknown> {
    if (input && typeof input === 'object') {
      const obj = input as Record<string, unknown>;
      if (obj.data && typeof obj.data === 'object') {
        return obj.data as Record<string, unknown>;
      }
      return obj;
    }
    return {};
  }

  private extractUsageRows(input: unknown): Array<Record<string, unknown>> {
    if (!input || typeof input !== 'object') return [];

    const obj = input as Record<string, unknown>;
    const candidates = [obj.data, obj.usage, obj.items, obj.results, obj.rows];

    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
      }

      if (candidate && typeof candidate === 'object') {
        const nested = candidate as Record<string, unknown>;
        for (const nestedKey of ['items', 'data', 'results', 'rows', 'usage']) {
          const maybe = nested[nestedKey];
          if (Array.isArray(maybe)) {
            return maybe.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
          }
        }
      }
    }

    return [];
  }

  private mapVeniceUnitType(raw: string): string | undefined {
    const normalized = raw.toUpperCase();

    if (normalized.includes('INPUT') || normalized.includes('PROMPT')) return 'VENICE_TEXT_TOKEN_IN';
    if (normalized.includes('OUTPUT') || normalized.includes('COMPLETION')) return 'VENICE_TEXT_TOKEN_OUT';
    if (normalized.includes('IMAGE')) return 'VENICE_IMAGE_GEN';
    if (normalized.includes('TTS') || normalized.includes('CHAR')) return 'VENICE_AUDIO_TTS_CHAR';
    if (normalized.includes('STT') || normalized.includes('AUDIO_SEC') || normalized.includes('SECOND')) {
      return 'VENICE_AUDIO_STT_SEC';
    }

    return undefined;
  }

  private pickFirstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return undefined;
  }

  private pickFirstNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
    }
    return undefined;
  }

  private normalizeUsageRow(
    row: Record<string, unknown>
  ): { ok: true; row: UsageResult['usage'][number] } | { ok: false; reason: string } {
    const unitTypeRaw = this.pickFirstString(row, ['unitType', 'sku', 'type', 'metric']);
    if (!unitTypeRaw) {
      return { ok: false, reason: 'missing_unit_type' };
    }

    const unitType = this.mapVeniceUnitType(unitTypeRaw);
    if (!unitType) {
      return { ok: false, reason: 'unmappable_unit_type' };
    }

    const amountRaw = row.amount ?? row.value ?? row.quantity ?? row.units;
    const amount = this.toDecimalString(amountRaw);
    if (!amount) {
      return { ok: false, reason: 'invalid_amount' };
    }

    const observedAtRaw = this.pickFirstString(row, ['observedAt', 'timestamp', 'createdAt', 'date']);
    if (!observedAtRaw || Number.isNaN(Date.parse(observedAtRaw))) {
      return { ok: false, reason: 'invalid_observed_at' };
    }

    const requestId = this.pickFirstString(row, ['requestId', 'id']);

    return {
      ok: true,
      row: {
        unitType,
        amount,
        observedAt: observedAtRaw,
        ...(requestId ? { requestId } : {}),
      },
    };
  }

  private toDecimalString(value: unknown): string | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value < 0) return undefined;
      return String(value);
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
      return trimmed;
    }

    return undefined;
  }

  private async fetchUsagePages(
    baseQuery: URLSearchParams
  ): Promise<{ ok: true; rows: Array<Record<string, unknown>>; pagesFetched: number } | {
    ok: false;
    error?: string;
    statusCode?: number;
  }> {
    const rows: Array<Record<string, unknown>> = [];
    const visitedTokens = new Set<string>();
    let pagesFetched = 0;
    let cursor: string | undefined;
    let page = 1;

    while (pagesFetched < this.maxUsagePages) {
      const query = new URLSearchParams(baseQuery);
      if (cursor) {
        query.set('cursor', cursor);
      } else if (page > 1) {
        query.set('page', String(page));
      }

      const usageResp = await this.request<Record<string, unknown>>(
        'GET',
        `/billing/usage${query.size > 0 ? `?${query}` : ''}`
      );

      if (!usageResp.ok || !usageResp.data) {
        const errorResult: { ok: false; error?: string; statusCode?: number } = {
          ok: false,
          error: usageResp.error ?? 'Failed to fetch Venice usage.',
          ...(usageResp.statusCode !== undefined ? { statusCode: usageResp.statusCode } : {}),
        };

        return {
          ...errorResult,
        };
      }

      rows.push(...this.extractUsageRows(usageResp.data));
      pagesFetched += 1;

      const nextCursor = this.extractNextCursor(usageResp.data);
      if (nextCursor) {
        if (visitedTokens.has(nextCursor)) break;
        visitedTokens.add(nextCursor);
        cursor = nextCursor;
        continue;
      }

      if (this.extractHasMorePages(usageResp.data)) {
        page += 1;
        continue;
      }

      break;
    }

    return { ok: true, rows, pagesFetched };
  }

  private extractNextCursor(input: unknown): string | undefined {
    if (!input || typeof input !== 'object') return undefined;
    const root = input as Record<string, unknown>;

    const direct = this.pickFirstString(root, ['nextCursor', 'next_cursor', 'cursor', 'nextPageToken', 'after']);
    if (direct) return direct;

    const containers = [root.pagination, root.meta, root.data];
    for (const container of containers) {
      if (!container || typeof container !== 'object' || Array.isArray(container)) continue;
      const next = this.pickFirstString(container as Record<string, unknown>, [
        'nextCursor',
        'next_cursor',
        'cursor',
        'nextPageToken',
        'after',
      ]);
      if (next) return next;
    }

    return undefined;
  }

  private extractHasMorePages(input: unknown): boolean {
    if (!input || typeof input !== 'object') return false;
    const root = input as Record<string, unknown>;
    const containers = [root, root.pagination, root.meta, root.data];

    for (const container of containers) {
      if (!container || typeof container !== 'object' || Array.isArray(container)) continue;
      const obj = container as Record<string, unknown>;

      if (typeof obj.hasMore === 'boolean') return obj.hasMore;
      if (typeof obj.has_more === 'boolean') return obj.has_more;

      const currentPage = this.pickFirstNumber(obj, ['page', 'currentPage', 'current_page']);
      const totalPages = this.pickFirstNumber(obj, ['totalPages', 'total_pages', 'pages']);
      if (currentPage !== undefined && totalPages !== undefined) {
        return currentPage < totalPages;
      }
    }

    return false;
  }

  private readString(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
    if (!source) return undefined;
    return this.pickFirstString(source, keys);
  }

  private readRecord(source: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> | undefined {
    if (!source) return undefined;
    for (const key of keys) {
      const value = source[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    }
    return undefined;
  }
}
