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
  podPollIntervalMs?: number;
  podPollMaxAttempts?: number;
}

export class RunPodComputeAdapter implements ComputeProviderAdapter {
  readonly provider = 'runpod' as const;
  private readonly apiKey: string | undefined;
  private readonly serverlessBaseUrl: string;
  private readonly infraBaseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly podPollIntervalMs: number;
  private readonly podPollMaxAttempts: number;

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
    this.podPollIntervalMs = options.podPollIntervalMs ?? 2000;
    this.podPollMaxAttempts = options.podPollMaxAttempts ?? 10;
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
    const policy = this.toRecord(request.policy);
    const gpuTypeIds = this.readStringArray(policy, ['gpuTypeIds', 'gpuIds']);
    const gpuCount = this.readInt(policy, ['gpuCount']) ?? 1;
    const volumeInGb = this.readInt(policy, ['volumeInGb']);
    const imageName = this.readString(policy, ['imageName', 'image']) ?? 'runpod/pytorch:latest';

    const createBody: Record<string, unknown> = {
      name: `equalfi-${request.agreementId}`,
      ...(gpuTypeIds.length > 0 ? { gpuTypeIds } : {}),
      gpuCount,
      imageName,
      ...(volumeInGb !== undefined ? { volumeInGb } : {}),
    };

    const created = await this.requestInfra<Record<string, unknown>>('POST', '/pods', {
      body: createBody,
    });

    if (!created.ok) {
      return {
        status: 'error',
        provider: this.provider,
        message: created.error,
        meta: {
          agreementId: request.agreementId,
          traceId: request.traceId,
          statusCode: created.statusCode,
          requestId: created.requestId,
          errorBody: created.errorBody,
        },
      };
    }

    const podId = this.readString(created.data, ['pod_id', 'podId', 'id']);
    if (!podId) {
      return {
        status: 'error',
        provider: this.provider,
        message: 'RunPod pod creation response missing pod id',
        meta: {
          agreementId: request.agreementId,
          traceId: request.traceId,
          requestId: created.requestId,
          response: created.data,
        },
      };
    }

    let lastPodState: Record<string, unknown> | undefined;
    let lastRequestId: string | undefined;

    for (let attempt = 0; attempt < this.podPollMaxAttempts; attempt += 1) {
      const pod = await this.requestInfra<Record<string, unknown>>('GET', `/pods/${encodeURIComponent(podId)}`);
      if (!pod.ok) {
        return {
          status: 'error',
          provider: this.provider,
          message: pod.error,
          meta: {
            agreementId: request.agreementId,
            traceId: request.traceId,
            providerResourceId: podId,
            statusCode: pod.statusCode,
            requestId: pod.requestId,
            errorBody: pod.errorBody,
          },
        };
      }

      lastPodState = pod.data;
      lastRequestId = pod.requestId;

      if (this.isPodRunning(pod.data)) {
        return {
          status: 'ok',
          provider: this.provider,
          providerResourceId: podId,
          connection: this.buildPodConnection(pod.data),
          meta: {
            agreementId: request.agreementId,
            traceId: request.traceId,
            requestId: pod.requestId ?? created.requestId,
            pollAttempts: attempt + 1,
          },
        };
      }

      if (attempt < this.podPollMaxAttempts - 1) {
        await this.sleepFn(this.podPollIntervalMs);
      }
    }

    return {
      status: 'ok',
      provider: this.provider,
      providerResourceId: podId,
      connectionPending: true,
      connection: this.buildPodConnection(lastPodState),
      meta: {
        agreementId: request.agreementId,
        traceId: request.traceId,
        requestId: lastRequestId ?? created.requestId,
        pollAttempts: this.podPollMaxAttempts,
      },
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

  private readRecord(value: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> | undefined {
    if (!value) return undefined;
    for (const key of keys) {
      const candidate = this.toRecord(value[key]);
      if (candidate) return candidate;
    }
    return undefined;
  }

  private readPortMapPort(value: Record<string, unknown> | undefined, keys: string[], port: string): number | undefined {
    const map = this.readRecord(value, keys);
    if (!map) return undefined;
    const candidate = map[port];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      const parsed = Number(candidate);
      if (!Number.isNaN(parsed) && Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  }

  private isPodRunning(pod: Record<string, unknown>): boolean {
    const desired = this.readString(pod, ['desiredStatus']);
    const runtime = this.readString(pod, ['status']);
    const normalized = (desired ?? runtime ?? '').toLowerCase();
    return normalized === 'running' || normalized === 'active';
  }

  private buildPodConnection(pod: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!pod) return {};

    const podUrl = this.readString(pod, ['pod_url', 'podUrl', 'url']);
    const sshHost = this.readString(pod, ['ssh_host', 'sshHost', 'publicIp', 'public_ip']);
    const sshPort =
      this.readInt(pod, ['sshPort', 'ssh_port']) ?? this.readPortMapPort(pod, ['portMappings', 'ports'], '22');

    return {
      ...(podUrl ? { pod_url: podUrl } : {}),
      ...(sshHost ? { ssh_host: sshHost } : {}),
      ...(sshPort !== undefined ? { ssh_port: sshPort } : {}),
    };
  }
}
