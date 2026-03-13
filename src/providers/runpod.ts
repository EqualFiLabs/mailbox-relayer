import {
  ComputeProviderAdapter,
  ProvisionRequest,
  ProvisionResult,
  TerminateRequest,
  TerminateResult,
  UsageRequest,
  UsageResult,
} from './types';

export class RunPodComputeAdapter implements ComputeProviderAdapter {
  readonly provider = 'runpod' as const;

  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    return {
      status: 'not_implemented',
      provider: this.provider,
      message: 'RunPod provision adapter is scaffolded but not yet implemented.',
      meta: { agreementId: request.agreementId },
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
}
