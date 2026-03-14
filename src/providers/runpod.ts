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
type RunPodResourceType = 'endpoint' | 'pod';

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
  nowFn?: () => string;
  loadCompletionEvents?: (query: {
    agreementId: string;
    providerResourceId: string;
    from?: string;
    to?: string;
  }) => Promise<Array<Record<string, unknown>>>;
  loadInFlightJobIds?: (query: {
    agreementId: string;
    providerResourceId: string;
    from?: string;
    to?: string;
  }) => Promise<string[]>;
  resolveResourceType?: (query: {
    agreementId: string;
    providerResourceId: string;
  }) => RunPodResourceType | undefined;
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
  private readonly nowFn: () => string;
  private readonly loadCompletionEvents: RunPodAdapterOptions['loadCompletionEvents'];
  private readonly loadInFlightJobIds: RunPodAdapterOptions['loadInFlightJobIds'];
  private readonly resolveResourceType: RunPodAdapterOptions['resolveResourceType'];

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
    this.nowFn = options.nowFn ?? (() => new Date().toISOString());
    this.loadCompletionEvents = options.loadCompletionEvents;
    this.loadInFlightJobIds = options.loadInFlightJobIds;
    this.resolveResourceType = options.resolveResourceType;
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
    if (!this.apiKey) {
      return {
        status: 'error',
        provider: this.provider,
        usage: [],
        message: 'RUNPOD_API_KEY not configured',
        meta: { agreementId: request.agreementId, providerResourceId: request.providerResourceId },
      };
    }

    if (!request.providerResourceId) {
      return {
        status: 'error',
        provider: this.provider,
        usage: [],
        message: 'providerResourceId is required for RunPod usage',
        meta: { agreementId: request.agreementId },
      };
    }

    const resourceType =
      this.resolveResourceType?.({
        agreementId: request.agreementId,
        providerResourceId: request.providerResourceId,
      }) ?? this.inferResourceType(request.providerResourceId);

    if (resourceType === 'pod') {
      return this.usageForPod(request);
    }

    return this.usageForServerless(request);
  }

  async terminate(request: TerminateRequest): Promise<TerminateResult> {
    if (!this.apiKey) {
      return {
        status: 'error',
        provider: this.provider,
        terminated: false,
        message: 'RUNPOD_API_KEY not configured',
        meta: { agreementId: request.agreementId, providerResourceId: request.providerResourceId, reason: request.reason },
      };
    }

    if (!request.providerResourceId) {
      return {
        status: 'error',
        provider: this.provider,
        terminated: false,
        message: 'providerResourceId is required for RunPod termination',
        meta: { agreementId: request.agreementId, reason: request.reason },
      };
    }

    const resolvedType =
      this.resolveResourceType?.({
        agreementId: request.agreementId,
        providerResourceId: request.providerResourceId,
      }) ?? this.inferResourceType(request.providerResourceId);

    const firstType = resolvedType;
    const secondType: RunPodResourceType = firstType === 'pod' ? 'endpoint' : 'pod';

    const first = await this.deleteResourceByType(firstType, request.providerResourceId);
    if (first.ok || this.isNotFoundError(first.statusCode, first.error)) {
      return {
        status: 'ok',
        provider: this.provider,
        terminated: true,
        meta: {
          agreementId: request.agreementId,
          providerResourceId: request.providerResourceId,
          reason: request.reason,
          resourceType: firstType,
          requestId: first.requestId,
        },
      };
    }

    if (!this.isResourceTypeConflictError(first.statusCode, first.error)) {
      return {
        status: 'error',
        provider: this.provider,
        terminated: false,
        message: first.error,
        meta: {
          agreementId: request.agreementId,
          providerResourceId: request.providerResourceId,
          reason: request.reason,
          resourceType: firstType,
          statusCode: first.statusCode,
          requestId: first.requestId,
          errorBody: first.errorBody,
        },
      };
    }

    const second = await this.deleteResourceByType(secondType, request.providerResourceId);
    if (second.ok || this.isNotFoundError(second.statusCode, second.error)) {
      return {
        status: 'ok',
        provider: this.provider,
        terminated: true,
        meta: {
          agreementId: request.agreementId,
          providerResourceId: request.providerResourceId,
          reason: request.reason,
          resourceType: secondType,
          requestId: second.requestId,
        },
      };
    }

    return {
      status: 'error',
      provider: this.provider,
      terminated: false,
      message: second.error,
      meta: {
        agreementId: request.agreementId,
        providerResourceId: request.providerResourceId,
        reason: request.reason,
        resourceType: secondType,
        statusCode: second.statusCode,
        requestId: second.requestId,
        errorBody: second.errorBody,
      },
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

  private async usageForServerless(request: UsageRequest): Promise<UsageResult> {
    const fromIso = this.normalizeIso(request.from);
    if (request.from && !fromIso) {
      return {
        status: 'error',
        provider: this.provider,
        usage: [],
        message: 'invalid from timestamp',
        meta: { agreementId: request.agreementId, providerResourceId: request.providerResourceId },
      };
    }

    const toIso = this.normalizeIso(request.to ?? this.nowFn());
    if (!toIso) {
      return {
        status: 'error',
        provider: this.provider,
        usage: [],
        message: 'invalid to timestamp',
        meta: { agreementId: request.agreementId, providerResourceId: request.providerResourceId },
      };
    }

    const completionEvents =
      (await this.loadCompletionEvents?.({
        agreementId: request.agreementId,
        providerResourceId: request.providerResourceId!,
        ...(fromIso ? { from: fromIso } : {}),
        to: toIso,
      })) ?? [];

    const jobs = new Map<string, { observedAt: string; executionSeconds: number }>();

    for (const event of completionEvents) {
      const parsed = this.parseCompletedJob(event, fromIso, toIso);
      if (!parsed) continue;
      jobs.set(parsed.jobId, { observedAt: parsed.observedAt, executionSeconds: parsed.executionSeconds });
    }

    const inFlightJobIds =
      (await this.loadInFlightJobIds?.({
        agreementId: request.agreementId,
        providerResourceId: request.providerResourceId!,
        ...(fromIso ? { from: fromIso } : {}),
        to: toIso,
      })) ?? [];

    for (const jobId of inFlightJobIds) {
      if (!jobId || jobs.has(jobId)) continue;

      const status = await this.requestServerless<Record<string, unknown>>(
        'GET',
        `/${encodeURIComponent(request.providerResourceId!)}/status/${encodeURIComponent(jobId)}`
      );

      if (!status.ok) {
        if (this.isNotFoundError(status.statusCode, status.error)) {
          continue;
        }

        return {
          status: 'error',
          provider: this.provider,
          usage: [],
          message: status.error,
          meta: {
            agreementId: request.agreementId,
            providerResourceId: request.providerResourceId,
            statusCode: status.statusCode,
            requestId: status.requestId,
            errorBody: status.errorBody,
          },
        };
      }

      const parsed = this.parseCompletedJob(status.data, fromIso, toIso);
      if (!parsed) continue;
      jobs.set(parsed.jobId, { observedAt: parsed.observedAt, executionSeconds: parsed.executionSeconds });
    }

    if (jobs.size === 0) {
      return {
        status: 'ok',
        provider: this.provider,
        usage: [],
        meta: {
          agreementId: request.agreementId,
          providerResourceId: request.providerResourceId,
          completionEventsRead: completionEvents.length,
          polledJobCount: inFlightJobIds.length,
        },
      };
    }

    const requestCount = jobs.size;
    let gpuSeconds = 0;
    let latestObservedAt = fromIso ?? this.nowFn();

    for (const job of jobs.values()) {
      gpuSeconds += job.executionSeconds;
      if (Date.parse(job.observedAt) > Date.parse(latestObservedAt)) {
        latestObservedAt = job.observedAt;
      }
    }

    return {
      status: 'ok',
      provider: this.provider,
      usage: [
        {
          unitType: 'RUNPOD_INFERENCE_REQUEST',
          amount: String(requestCount),
          observedAt: latestObservedAt,
        },
        {
          unitType: 'RUNPOD_GPU_SEC',
          amount: this.formatDecimal(gpuSeconds),
          observedAt: latestObservedAt,
        },
      ],
      meta: {
        agreementId: request.agreementId,
        providerResourceId: request.providerResourceId,
        completionEventsRead: completionEvents.length,
        polledJobCount: inFlightJobIds.length,
        dedupedJobCount: jobs.size,
      },
    };
  }

  private async usageForPod(request: UsageRequest): Promise<UsageResult> {
    const fromIso = this.normalizeIso(request.from);
    if (request.from && !fromIso) {
      return {
        status: 'error',
        provider: this.provider,
        usage: [],
        message: 'invalid from timestamp',
        meta: { agreementId: request.agreementId, providerResourceId: request.providerResourceId },
      };
    }

    const toIso = this.normalizeIso(request.to ?? this.nowFn());
    if (!toIso) {
      return {
        status: 'error',
        provider: this.provider,
        usage: [],
        message: 'invalid to timestamp',
        meta: { agreementId: request.agreementId, providerResourceId: request.providerResourceId },
      };
    }

    const pod = await this.requestInfra<Record<string, unknown>>(
      'GET',
      `/pods/${encodeURIComponent(request.providerResourceId!)}`
    );

    if (!pod.ok) {
      return {
        status: 'error',
        provider: this.provider,
        usage: [],
        message: pod.error,
        meta: {
          agreementId: request.agreementId,
          providerResourceId: request.providerResourceId,
          statusCode: pod.statusCode,
          requestId: pod.requestId,
          errorBody: pod.errorBody,
        },
      };
    }

    const startMs = this.readTimestamp(pod.data, ['createdAt', 'created_at', 'startedAt', 'started_at']);
    if (startMs === undefined) {
      return {
        status: 'error',
        provider: this.provider,
        usage: [],
        message: 'RunPod pod response missing start time',
        meta: {
          agreementId: request.agreementId,
          providerResourceId: request.providerResourceId,
          requestId: pod.requestId,
        },
      };
    }

    const fromMs = fromIso ? Date.parse(fromIso) : undefined;
    const toMs = Date.parse(toIso);
    const nowMs = Date.now();
    let endMs = Math.min(toMs, nowMs);
    const podStatus = (this.readString(pod.data, ['desiredStatus', 'status']) ?? 'unknown').toLowerCase();

    if (this.isNonRunningStatus(podStatus)) {
      const stopMs = this.readTimestamp(pod.data, ['terminatedAt', 'terminated_at', 'stoppedAt', 'stopped_at', 'updatedAt', 'updated_at']);
      if (stopMs !== undefined) endMs = Math.min(endMs, stopMs);
    }

    const windowStartMs = Math.max(fromMs ?? startMs, startMs);
    const elapsedHours = Math.max(0, endMs - windowStartMs) / 3_600_000;
    const unitType = this.resolvePodGpuHourUnitType(pod.data);

    return {
      status: 'ok',
      provider: this.provider,
      usage: [
        {
          unitType,
          amount: elapsedHours.toFixed(18),
          observedAt: new Date(endMs).toISOString(),
        },
      ],
      meta: {
        agreementId: request.agreementId,
        providerResourceId: request.providerResourceId,
        podStatus,
        requestId: pod.requestId,
      },
    };
  }

  private parseCompletedJob(
    value: Record<string, unknown> | undefined,
    fromIso?: string,
    toIso?: string
  ): { jobId: string; observedAt: string; executionSeconds: number } | undefined {
    if (!value) return undefined;

    const status = (this.readString(value, ['status']) ?? '').toUpperCase();
    if (status && status !== 'COMPLETED') return undefined;

    const nestedData = this.toRecord(value.data);
    const source = nestedData ?? value;

    const jobId = this.readString(source, ['id', 'jobId', 'job_id']) ?? this.readString(value, ['id', 'jobId', 'job_id']);
    if (!jobId) return undefined;

    const observedAt =
      this.normalizeIso(this.readString(source, ['completedAt', 'completed_at', 'finishedAt', 'finished_at'])) ??
      this.normalizeIso(this.readString(source, ['updatedAt', 'updated_at', 'createdAt', 'created_at'])) ??
      this.nowFn();

    if (fromIso && Date.parse(observedAt) < Date.parse(fromIso)) return undefined;
    if (toIso && Date.parse(observedAt) > Date.parse(toIso)) return undefined;

    const executionSeconds = this.readExecutionSeconds(source);

    return {
      jobId,
      observedAt,
      executionSeconds,
    };
  }

  private readExecutionSeconds(value: Record<string, unknown>): number {
    const msFields = ['executionTimeMs', 'execution_time_ms'];
    for (const field of msFields) {
      const candidate = value[field];
      if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate / 1000;
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        const parsed = Number(candidate);
        if (!Number.isNaN(parsed)) return parsed / 1000;
      }
    }

    const secFields = ['executionTime', 'execution_time', 'executionSeconds', 'execution_seconds'];
    for (const field of secFields) {
      const candidate = value[field];
      if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        const parsed = Number(candidate);
        if (!Number.isNaN(parsed)) return parsed;
      }
    }

    return 0;
  }

  private deleteResourceByType(
    type: RunPodResourceType,
    providerResourceId: string
  ): Promise<RequestResult<Record<string, unknown>>> {
    const path =
      type === 'pod'
        ? `/pods/${encodeURIComponent(providerResourceId)}`
        : `/endpoints/${encodeURIComponent(providerResourceId)}`;
    return this.requestInfra<Record<string, unknown>>('DELETE', path);
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

  private normalizeIso(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return undefined;
    return new Date(parsed).toISOString();
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

  private readTimestamp(value: Record<string, unknown> | undefined, keys: string[]): number | undefined {
    if (!value) return undefined;
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return candidate > 1e12 ? candidate : candidate * 1000;
      }
      if (typeof candidate === 'string') {
        const parsed = Date.parse(candidate);
        if (!Number.isNaN(parsed)) return parsed;
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

  private inferResourceType(providerResourceId: string): RunPodResourceType {
    const normalized = providerResourceId.toLowerCase();
    if (normalized.startsWith('pod_') || normalized.startsWith('pod-') || normalized.includes('pod')) return 'pod';
    if (normalized.startsWith('ep_') || normalized.startsWith('ep-') || normalized.includes('endpoint')) return 'endpoint';
    return 'endpoint';
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

  private isNonRunningStatus(status: string): boolean {
    return ['stopped', 'stopping', 'terminated', 'failed', 'error'].includes(status);
  }

  private isNotFoundError(statusCode: number | undefined, error: string): boolean {
    if (statusCode === 404) return true;
    return /not found|does not exist|object-does-not-exist|already deleted/i.test(error);
  }

  private isResourceTypeConflictError(statusCode: number | undefined, error: string): boolean {
    if (statusCode === 404) return true;
    return /not found|does not exist|invalid endpoint|invalid pod/i.test(error);
  }

  private resolvePodGpuHourUnitType(pod: Record<string, unknown>): string {
    const gpuRecord = this.readRecord(pod, ['gpu']);
    const gpuLabel =
      this.readString(gpuRecord, ['displayName', 'name', 'id']) ??
      this.readString(pod, ['gpuTypeId', 'gpuType', 'gpuName', 'gpuTypeName']) ??
      'unknown';
    const normalized = gpuLabel.toLowerCase();
    if (normalized.includes('a100')) return 'GPU_HOUR_A100';
    if (normalized.includes('h100')) return 'GPU_HOUR_H100';
    if (normalized.includes('a10')) return 'GPU_HOUR_A10';

    const suffix = gpuLabel.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'UNKNOWN';
    return `GPU_HOUR_${suffix}`;
  }

  private formatDecimal(value: number): string {
    if (!Number.isFinite(value)) return '0';
    const fixed = value.toFixed(18);
    return fixed.replace(/\.?0+$/, '') || '0';
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
