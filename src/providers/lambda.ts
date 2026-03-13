import {
  ComputeProviderAdapter,
  ProvisionRequest,
  ProvisionResult,
  TerminateRequest,
  TerminateResult,
  UsageRequest,
  UsageResult,
} from './types';

export class LambdaComputeAdapter implements ComputeProviderAdapter {
  readonly provider = 'lambda' as const;

  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    return {
      status: 'not_implemented',
      provider: this.provider,
      message: 'Lambda provision adapter is scaffolded but not yet implemented.',
      meta: { agreementId: request.agreementId },
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
}
