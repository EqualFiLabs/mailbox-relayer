import {
  ComputeProviderAdapter,
  ProvisionRequest,
  ProvisionResult,
  TerminateRequest,
  TerminateResult,
  UsageRequest,
  UsageResult,
} from './types';
import { ComputePolicy } from './policy';

type FetchLike = typeof fetch;
type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type ApiSurface = 'serverless' | 'infra';

type RequestResult<T> =
  | { ok: true; data: T; statusCode: number; requestId?: string }
  | {
      ok: false;
      error: string;
      statusCode?: number;
      requestId?: string;
      errorBody?: unknown;
    };

export interface RunPodAdapterOptions {
  apiKey?: string;
  serverlessBaseUrl?: string;
  infraBaseUrl?: string;
  fetchFn?: FetchLike;
  sleepFn?: (ms: number) => Promise<void>;
}

export class RunPodComputeAdapter implements ComputeProviderAdapter {
  readonly provider = 'runpod' as const;
  private readonly apiKey: string | undefined;
  private readonly serverlessBaseUrl: string;
  private readonly infraBaseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: RunPodAdapterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.RUNPOD_API_KEY;
    this.serverlessBaseUrl = (
      options.serverlessBaseUrl ??
      process.env.RUNPOD_SERVERLESS_BASE_URL ??
      'https://api.runpod.ai/v2'
    ).replace(/\/$/, '');
    this.infraBaseUrl = (options.infraBaseUrl ?? process.env.RUNPOD_INFRA_BASE_URL ?? 'https://rest.runpod.io/v1').replace(
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
        message: 'RUNPOD_API_KEY not configured',
        meta: { agreementId: request.agreementId },
      };
    }

    const policy = this.toRecord(request.policy);
    const computeMode = this.readString(policy, ['computeMode']) as ComputePolicy['computeMode'] | undefined;

    if (computeMode === 'dedicated') {
      return this.provisionDedicatedPod(request);
    }

    const minWorkers = this.readInt(policy, ['minWorkers']) ?? 0;
    const maxWorkers = this.readInt(policy, ['maxWorkers']) ?? 1;
    const idleTimeout = this.readInt(policy, ['idleTimeout']) ?? 60;
    const executionTimeoutMs = this.readInt(policy, ['executionTimeoutMs']) ?? 600000;
    const jobTtlMs = this.readInt(policy, ['jobTtlMs']) ?? 86400000;
    const webhookUrl = this.readString(policy, ['webhookUrl']);
    const model = this.readString(policy, ['model']);
    const gpuIds = this.readStringArray(policy, ['gpuIds', 'gpuTypeIds']);

    const create = await this.requestInfra<Record<string, unknown>>('POST', '/endpoints', {
      body: {
        name: `equalfi-${request.agreementId}`,
        ...(gpuIds.length > 0 ? { gpuIds } : {}),
        ...(model ? { model } : {}),
        minWorkers,
        maxWorkers,
        idleTimeout,
        executionTimeoutMs,
        jobTtlMs,
        ...(webhookUrl ? { webhookUrl } : {}),
      },
    });

    if (!create.ok) {
      return {
        status: 'error',
        provider: this.provider,
        message: create.error,
        meta: {
          agreementId: request.agreementId,
          traceId: request.traceId,
          statusCode: create.statusCode,
          requestId: create.requestId,
          errorBody: create.errorBody,
        },
      };
    }

    const endpointId =
      this.readString(create.data, ['endpoint_id', 'endpointId', 'id']) ??
      this.readString(this.toRecord(create.data?.data), ['endpoint_id', 'endpointId', 'id']);

    if (!endpointId) {
      return {
        status: 'error',
        provider: this.provider,
        message: 'RunPod endpoint creation response missing endpoint id',
        meta: {
          agreementId: request.agreementId,
          traceId: request.traceId,
          requestId: create.requestId,
          response: create.data,
        },
      };
    }

    return {
      status: 'ok',
      provider: this.provider,
      providerResourceId: endpointId,
      connection: {
        endpoint_url: `${this.serverlessBaseUrl}/${endpointId}`,
        api_key: this.apiKey,
      },
      meta: {
        agreementId: request.agreementId,
        traceId: request.traceId,
        requestId: create.requestId,
      },
    };
  }

  async usage(request: UsageRequest): Promise<UsageResult> {
    return {
      status: 'not_implemented',
      provider: this.provider,
      usage: [],
      message: 'RunPod usage metering adapter is scaffolded but not yet implemented.',
      meta: { agreementId: request.agreementId, providerResourceId: request.providerResourceId },
    };
  }

  async terminate(request: TerminateRequest): Promise<TerminateResult> {
    return {
      status: 'not_implemented',
      provider: this.provider,
      terminated: false,
      message: 'RunPod terminate adapter is scaffolded but not yet implemented.',
      meta: { agreementId: request.agreementId, providerResourceId: request.providerResourceId, reason: request.reason },
    };
  }

  private async provisionDedicatedPod(request: ProvisionRequest): Promise<ProvisionResult> {
    return {
      status: 'not_implemented',
      provider: this.provider,
      message: 'RunPod dedicated mode provisioning is not implemented yet (task 7.1).',
      meta: { agreementId: request.agreementId, traceId: request.traceId, computeMode: 'dedicated' },
    };
  }

  private async requestServerless<T = unknown>(
    method: HttpMethod,
    path: string,
    opts: { body?: Record<string, unknown> } = {}
  ): Promise<RequestResult<T>> {
    return this.request<T>('serverless', method, path, opts);
  }

  private async requestInfra<T = unknown>(
    method: HttpMethod,
    path: string,
    opts: { body?: Record<string, unknown> } = {}
  ): Promise<RequestResult<T>> {
    return this.request<T>('infra', method, path, opts);
  }

  private async request<T = unknown>(
    surface: ApiSurface,
    method: HttpMethod,
    path: string,
    opts: { body?: Record<string, unknown> } = {}
  ): Promise<RequestResult<T>> {
    if (!this.apiKey) {
      return { ok: false, error: 'RUNPOD_API_KEY not configured' };
    }

    const baseUrl = surface === 'infra' ? this.infraBaseUrl : this.serverlessBaseUrl;
    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await this.fetchFn(`${baseUrl}${path}`, {
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

        const error = this.toErrorMessage(surface, statusCode, json);
        if ((statusCode === 429 || (statusCode >= 500 && statusCode <= 599)) && attempt < maxRetries) {
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
          error: error instanceof Error ? error.message : `Unknown RunPod ${surface} request error`,
        };
      }
    }

    return { ok: false, error: `RunPod ${surface} request failed after retries` };
  }

  private exponentialBackoffMs(attempt: number): number {
    return [1000, 2000, 4000][attempt] ?? 4000;
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

  private toErrorMessage(surface: ApiSurface, statusCode: number, payload: unknown): string {
    const body = this.toRecord(payload);
    const message =
      this.readString(body, ['error', 'message']) ??
      this.readString(this.toRecord(body?.error), ['message', 'code']) ??
      this.readString(this.toRecord(body?.errors), ['message']) ??
      `HTTP ${statusCode}`;

    return `RunPod ${surface} API HTTP ${statusCode}: ${message}`;
  }

  private extractRequestId(headers: Headers): string | undefined {
    return (
      headers.get('x-request-id') ??
      headers.get('x-runpod-request-id') ??
      headers.get('x-amzn-requestid') ??
      headers.get('x-amz-request-id') ??
      undefined
    );
  }

  private toRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
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

  private readInt(value: Record<string, unknown> | undefined, keys: string[]): number | undefined {
    if (!value) return undefined;
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate === 'number' && Number.isInteger(candidate)) {
        return candidate;
      }
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        const parsed = Number(candidate);
        if (!Number.isNaN(parsed) && Number.isInteger(parsed)) {
          return parsed;
        }
      }
    }
    return undefined;
  }

  private readStringArray(value: Record<string, unknown> | undefined, keys: string[]): string[] {
    if (!value) return [];
    for (const key of keys) {
      const candidate = value[key];
      if (Array.isArray(candidate)) {
        return candidate.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
      }
    }
    return [];
  }
}
