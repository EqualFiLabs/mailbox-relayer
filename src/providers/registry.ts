import { LambdaComputeAdapter } from './lambda';
import { RunPodComputeAdapter } from './runpod';
import { VeniceComputeAdapter } from './venice';
import { BankrComputeAdapter } from './bankr';
import { ComputeProvider, ComputeProviderAdapter } from './types';
import { ComputePolicy, MODE_TO_PROVIDER } from './policy';

interface RoutingLogger {
  info?: (payload: Record<string, unknown>, message?: string) => void;
}

export class ComputeAdapterRegistry {
  private readonly adapters = new Map<ComputeProvider, ComputeProviderAdapter>();
  private readonly disabledProviders = new Set<ComputeProvider>();

  constructor(private readonly logger: RoutingLogger = console) {}

  register(adapter: ComputeProviderAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  get(provider: ComputeProvider): ComputeProviderAdapter | undefined {
    return this.adapters.get(provider);
  }

  list(): ComputeProvider[] {
    return [...this.adapters.keys()];
  }

  resolve(policy: ComputePolicy): ComputeProviderAdapter | undefined {
    const explicitProvider = policy.provider;
    const modeProvider = policy.computeMode ? MODE_TO_PROVIDER[policy.computeMode] : undefined;
    const resolvedProvider = explicitProvider ?? modeProvider;
    const routeSource = explicitProvider ? 'provider' : modeProvider ? 'computeMode' : 'none';
    const disabled = resolvedProvider ? this.disabledProviders.has(resolvedProvider) : false;
    const adapter = resolvedProvider && !disabled ? this.adapters.get(resolvedProvider) : undefined;

    this.logger.info?.(
      {
        agreementId: this.readAgreementId(policy),
        provider: explicitProvider ?? null,
        computeMode: policy.computeMode ?? null,
        resolvedProvider: resolvedProvider ?? null,
        routeSource,
        disabled,
        adapterRegistered: resolvedProvider ? this.adapters.has(resolvedProvider) : false,
      },
      'compute adapter routing decision'
    );

    return adapter;
  }

  disable(provider: ComputeProvider): void {
    this.disabledProviders.add(provider);
  }

  enable(provider: ComputeProvider): void {
    this.disabledProviders.delete(provider);
  }

  isEnabled(provider: ComputeProvider): boolean {
    return !this.disabledProviders.has(provider);
  }

  private readAgreementId(policy: ComputePolicy): string | undefined {
    const value = (policy as Record<string, unknown>).agreementId;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}

export function createDefaultComputeAdapterRegistry(): ComputeAdapterRegistry {
  const registry = new ComputeAdapterRegistry();
  registry.register(new LambdaComputeAdapter());
  registry.register(new RunPodComputeAdapter());
  registry.register(new VeniceComputeAdapter());
  registry.register(new BankrComputeAdapter());
  return registry;
}
