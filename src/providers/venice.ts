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

  constructor(options: VeniceAdapterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.VENICE_API_KEY;
    this.baseUrl = (options.baseUrl ?? process.env.VENICE_BASE_URL ?? 'https://api.venice.ai/api/v1').replace(/\/$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
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

    const query = new URLSearchParams();
    if (request.from) query.set('from', request.from);
    if (request.to) query.set('to', request.to);

    const usageResp = await this.request<VeniceApiResponse<Record<string, unknown>>>(
      'GET',
      `/billing/usage${query.size > 0 ? `?${query}` : ''}`
    );

    if (!usageResp.ok || !usageResp.data) {
      return {
        status: 'error',
        provider: this.provider,
        usage: [],
        message: usageResp.error ?? 'Failed to fetch Venice usage.',
        meta: { agreementId: request.agreementId, statusCode: usageResp.statusCode },
      };
    }

    const rows = this.extractUsageRows(usageResp.data);

    const usage = rows.map((row) => {
      const unitTypeRaw = this.pickFirstString(row, ['unitType', 'sku', 'type', 'metric']) ?? 'UNKNOWN';
      const amount = this.pickFirstNumber(row, ['amount', 'value', 'quantity', 'units']) ?? 0;
      const observedAt =
        this.pickFirstString(row, ['observedAt', 'timestamp', 'createdAt', 'date']) ?? new Date().toISOString();
      const requestId = this.pickFirstString(row, ['requestId', 'id']);

      return {
        unitType: this.mapVeniceUnitType(unitTypeRaw),
        amount: String(amount),
        observedAt,
        ...(requestId ? { requestId } : {}),
      };
    });

    return {
      status: 'ok',
      provider: this.provider,
      usage,
      meta: {
        agreementId: request.agreementId,
        providerResourceId: request.providerResourceId,
        rowCount: rows.length,
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

    const nowIso = new Date().toISOString();

    // Best-effort clamp before delete.
    await this.request('PATCH', '/api_keys', {
      body: {
        id: request.providerResourceId,
        consumptionLimit: { usd: 0 },
        expiresAt: nowIso,
      },
    });

    const deleteAttempts = [
      await this.request('DELETE', `/api_keys/${request.providerResourceId}`),
      await this.request('DELETE', `/api_keys?id=${encodeURIComponent(request.providerResourceId)}`),
    ];

    const deleteOk = deleteAttempts.some((result) => result.ok);

    return {
      status: deleteOk ? 'ok' : 'error',
      provider: this.provider,
      terminated: deleteOk,
      message: deleteOk ? 'Venice key revoked.' : 'Failed to revoke Venice key.',
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

  private mapVeniceUnitType(raw: string): string {
    const normalized = raw.toUpperCase();

    if (normalized.includes('INPUT') || normalized.includes('PROMPT')) return 'VENICE_TEXT_TOKEN_IN';
    if (normalized.includes('OUTPUT') || normalized.includes('COMPLETION')) return 'VENICE_TEXT_TOKEN_OUT';
    if (normalized.includes('IMAGE')) return 'VENICE_IMAGE_GEN';
    if (normalized.includes('TTS') || normalized.includes('CHAR')) return 'VENICE_AUDIO_TTS_CHAR';
    if (normalized.includes('STT') || normalized.includes('AUDIO_SEC') || normalized.includes('SECOND')) {
      return 'VENICE_AUDIO_STT_SEC';
    }

    return `VENICE_${normalized.replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'UNKNOWN'}`;
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
