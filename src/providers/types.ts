export type ComputeProvider = 'lambda' | 'runpod' | 'venice' | 'bankr';

export type AdapterResultStatus = 'ok' | 'not_implemented' | 'error';

export interface ProvisionRequest {
  agreementId: string;
  traceId?: string;
  policy?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

export interface ProvisionResult {
  status: AdapterResultStatus;
  provider: ComputeProvider;
  providerResourceId?: string;
  connection?: Record<string, unknown>;
  message?: string;
  meta?: Record<string, unknown>;
}

export interface UsageRequest {
  agreementId: string;
  providerResourceId?: string;
  from?: string;
  to?: string;
}

export interface UsageResult {
  status: AdapterResultStatus;
  provider: ComputeProvider;
  usage: Array<{
    unitType: string;
    amount: string;
    observedAt: string;
    requestId?: string;
  }>;
  message?: string;
  meta?: Record<string, unknown>;
}

export interface TerminateRequest {
  agreementId: string;
  providerResourceId?: string;
  reason?: string;
}

export interface TerminateResult {
  status: AdapterResultStatus;
  provider: ComputeProvider;
  terminated: boolean;
  message?: string;
  meta?: Record<string, unknown>;
}

export interface ComputeProviderAdapter {
  readonly provider: ComputeProvider;
  provision(request: ProvisionRequest): Promise<ProvisionResult>;
  usage(request: UsageRequest): Promise<UsageResult>;
  terminate(request: TerminateRequest): Promise<TerminateResult>;
}
