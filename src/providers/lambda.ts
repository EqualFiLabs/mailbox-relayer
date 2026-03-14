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

export interface LambdaAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: FetchLike;
  sleepFn?: (ms: number) => Promise<void>;
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

type RequestResult<T> =
  | { ok: true; data: T; statusCode: number; requestId?: string }
  | {
      ok: false;
      error: string;
      statusCode?: number;
      requestId?: string;
      errorBody?: unknown;
    };

export const INSTANCE_TYPE_MAP: Record<string, string> = {
  a100_40gb: 'gpu_1x_a100',
  a100_80gb: 'gpu_1x_a100_sxm4',
  a100_80gb_2x: 'gpu_2x_a100',
  h100_80gb: 'gpu_1x_h100_pcie',
  h100_sxm_80gb: 'gpu_1x_h100_sxm5',
  a10_24gb: 'gpu_1x_a10',
};

export class LambdaComputeAdapter implements ComputeProviderAdapter {
  readonly provider = 'lambda' as const;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: LambdaAdapterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.LAMBDA_API_KEY;
    this.baseUrl = (options.baseUrl ?? process.env.LAMBDA_BASE_URL ?? 'https://cloud.lambdalabs.com/api/v1').replace(
      /\/$/,
      ''
    );
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn = options.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    if (!this.apiKey) {
      return {
        status: 'error',
        provider: this.provider,
        message: 'LAMBDA_API_KEY not configured',
        meta: { agreementId: request.agreementId },
      };
    }

    const policy = this.toRecord(request.policy);
    const payload = this.toRecord(request.payload);
    const requestedInstanceType = this.readString(policy, ['instanceType']);
    const instanceType = requestedInstanceType ? this.mapInstanceType(requestedInstanceType) : undefined;

    if (!instanceType) {
      return {
        status: 'error',
        provider: this.provider,
        message: 'unsupported_instance_type',
        meta: {
          agreementId: request.agreementId,
          traceId: request.traceId,
          ...(requestedInstanceType ? { requestedInstanceType } : {}),
        },
      };
    }

    const sshPublicKey = this.readString(payload, ['sshPublicKey']) ?? this.readString(policy, ['sshPublicKey']);
    if (!sshPublicKey) {
      return {
        status: 'error',
        provider: this.provider,
        message: 'sshPublicKey is required',
        meta: { agreementId: request.agreementId, traceId: request.traceId },
      };
    }

    let sshKeyName: string;
    try {
      sshKeyName = await this.ensureSshKey(request.agreementId, sshPublicKey);
    } catch (error) {
      return {
        status: 'error',
        provider: this.provider,
        message: error instanceof Error ? error.message : 'Failed to ensure SSH key',
        meta: { agreementId: request.agreementId, traceId: request.traceId },
      };
    }

    const region = this.readString(policy, ['region']) ?? 'us-west-1';
    const instanceName = request.traceId
      ? `equalfi-${request.agreementId}-${request.traceId}`
      : `equalfi-${request.agreementId}`;
    const launch = await this.request<Record<string, unknown>>('POST', '/instance-operations/launch', {
      body: {
        region_name: region,
        instance_type_name: instanceType,
        ssh_key_names: [sshKeyName],
        name: instanceName,
        quantity: 1,
      },
    });

    if (!launch.ok) {
      return {
        status: 'error',
        provider: this.provider,
        message: launch.error,
        meta: {
          agreementId: request.agreementId,
          traceId: request.traceId,
          statusCode: launch.statusCode,
          requestId: launch.requestId,
          errorBody: launch.errorBody,
        },
      };
    }

    const instanceIds = this.readStringArray(launch.data, ['instance_ids', 'instanceIds']);
    const instanceId = instanceIds[0];
    if (!instanceId) {
      return {
        status: 'error',
        provider: this.provider,
        message: 'Lambda launch response missing instance id',
        meta: {
          agreementId: request.agreementId,
          traceId: request.traceId,
          requestId: launch.requestId,
          launchData: launch.data,
        },
      };
    }

    const instance = await this.request<Record<string, unknown>>('GET', `/instances/${encodeURIComponent(instanceId)}`);
    if (!instance.ok) {
      return {
        status: 'error',
        provider: this.provider,
        message: instance.error,
        meta: {
          agreementId: request.agreementId,
          traceId: request.traceId,
          providerResourceId: instanceId,
          statusCode: instance.statusCode,
          requestId: instance.requestId,
          errorBody: instance.errorBody,
        },
      };
    }

    const instanceStatus = this.readString(instance.data, ['status'])?.toLowerCase();
    const sshHost =
      this.readString(instance.data, ['ip']) ??
      this.readString(instance.data, ['public_ip']) ??
      this.readString(instance.data, ['publicIp']);

    const baseMeta: Record<string, unknown> = {
      agreementId: request.agreementId,
      traceId: request.traceId,
      launchRequestId: launch.requestId,
      requestId: instance.requestId,
      instanceStatus: instanceStatus ?? 'unknown',
      instanceType,
      region,
    };

    if (instanceStatus !== 'active' || !sshHost) {
      return {
        status: 'ok',
        provider: this.provider,
        providerResourceId: instanceId,
        connectionPending: true,
        meta: baseMeta,
      };
    }

    return {
      status: 'ok',
      provider: this.provider,
      providerResourceId: instanceId,
      connection: {
        ssh_host: sshHost,
        ssh_port: 22,
        ssh_user: 'ubuntu',
      },
      meta: baseMeta,
    };
  }

  async usage(request: UsageRequest): Promise<UsageResult> {
    return {
      status: 'not_implemented',
      provider: this.provider,
      usage: [],
      message: 'Lambda usage metering adapter is scaffolded but not yet implemented.',
      meta: { agreementId: request.agreementId, providerResourceId: request.providerResourceId },
    };
  }

  async terminate(request: TerminateRequest): Promise<TerminateResult> {
    return {
      status: 'not_implemented',
      provider: this.provider,
      terminated: false,
      message: 'Lambda terminate adapter is scaffolded but not yet implemented.',
      meta: { agreementId: request.agreementId, providerResourceId: request.providerResourceId, reason: request.reason },
    };
  }

  mapInstanceType(canonical: string): string | undefined {
    if (canonical.startsWith('gpu_')) return canonical;
    return INSTANCE_TYPE_MAP[canonical];
  }

  getSupportedInstanceTypes(): Record<string, string> {
    return { ...INSTANCE_TYPE_MAP };
  }

  private async ensureSshKey(agreementId: string, publicKey: string): Promise<string> {
    const keyName = `equalfi-${agreementId}`;
    const listed = await this.request<unknown>('GET', '/ssh-keys');
    if (!listed.ok) {
      throw new Error(listed.error);
    }

    const existingKeys = this.toRecordArray(listed.data);
    const existing = existingKeys.some((key) => this.readString(key, ['name']) === keyName);
    if (existing) {
      return keyName;
    }

    const created = await this.request<unknown>('POST', '/ssh-keys', {
      body: {
        name: keyName,
        public_key: publicKey,
      },
    });

    if (!created.ok) {
      throw new Error(created.error);
    }

    return keyName;
  }

  private async request<T = unknown>(
    method: HttpMethod,
    path: string,
    opts: { body?: Record<string, unknown> } = {}
  ): Promise<RequestResult<T>> {
    if (!this.apiKey) {
      return { ok: false, error: 'LAMBDA_API_KEY not configured' };
    }

    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
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
        const requestId = this.extractRequestId(response.headers);
        const json = await this.parseJson(response);
        const data = this.unwrapData<T>(json);

        if (response.ok) {
          return { ok: true, data, statusCode, requestId };
        }

        const error = this.toErrorMessage(statusCode, json);
        if (statusCode === 429 && attempt < maxRetries) {
          await this.sleepFn(this.retryAfterMs(response.headers.get('Retry-After')));
          continue;
        }

        if (statusCode >= 500 && statusCode <= 599 && attempt < maxRetries) {
          await this.sleepFn(this.exponentialBackoffMs(attempt));
          continue;
        }

        return {
          ok: false,
          error,
          statusCode,
          requestId,
          errorBody: json,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Unknown Lambda request error',
        };
      }
    }

    return { ok: false, error: 'Lambda request failed after retries' };
  }

  private exponentialBackoffMs(attempt: number): number {
    return [1000, 2000, 4000][attempt] ?? 4000;
  }

  private retryAfterMs(retryAfterHeader: string | null): number {
    if (!retryAfterHeader) return 5000;
    const seconds = Number(retryAfterHeader);
    if (!Number.isNaN(seconds)) return Math.max(0, Math.floor(seconds * 1000));
    const retryDate = Date.parse(retryAfterHeader);
    if (Number.isNaN(retryDate)) return 5000;
    return Math.max(0, retryDate - Date.now());
  }

  private async parseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

  private unwrapData<T>(payload: unknown): T {
    if (payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)) {
      return (payload as Record<string, unknown>).data as T;
    }
    return payload as T;
  }

  private toErrorMessage(statusCode: number, payload: unknown): string {
    const body = this.toRecord(payload);
    const topLevelError = body ? body.error : undefined;

    if (typeof topLevelError === 'string') {
      return `Lambda API HTTP ${statusCode}: ${topLevelError}`;
    }

    if (topLevelError && typeof topLevelError === 'object') {
      const errObj = topLevelError as Record<string, unknown>;
      const message =
        (typeof errObj.message === 'string' && errObj.message) ||
        (typeof errObj.code === 'string' && errObj.code) ||
        (typeof errObj.suggestion === 'string' && errObj.suggestion);
      if (message) return `Lambda API HTTP ${statusCode}: ${message}`;
    }

    const message = body && typeof body.message === 'string' ? body.message : undefined;
    return message ? `Lambda API HTTP ${statusCode}: ${message}` : `Lambda API HTTP ${statusCode}`;
  }

  private extractRequestId(headers: Headers): string | undefined {
    return (
      headers.get('x-request-id') ??
      headers.get('x-amzn-requestid') ??
      headers.get('x-amz-request-id') ??
      undefined
    );
  }

  private toRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  }

  private toRecordArray(value: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(value)) {
      return value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
    }

    const record = this.toRecord(value);
    if (!record) return [];

    const candidates = [record.items, record.results, record.rows, record.keys, record.ssh_keys];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
      }
    }

    return [];
  }

  private readString(
    value: Record<string, unknown> | undefined,
    keys: string[],
    fallback?: string
  ): string | undefined {
    if (!value) return fallback;
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate;
      }
    }
    return fallback;
  }

  private readStringArray(value: Record<string, unknown> | undefined, keys: string[]): string[] {
    if (!value) return [];
    for (const key of keys) {
      const candidate = value[key];
      if (Array.isArray(candidate)) {
        return candidate.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
      }
    }
    return [];
  }
}
