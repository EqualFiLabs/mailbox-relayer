import { LambdaComputeAdapter } from './lambda';
import { RunPodComputeAdapter } from './runpod';
import { VeniceComputeAdapter } from './venice';
import { ComputeProvider, ComputeProviderAdapter } from './types';

export class ComputeAdapterRegistry {
  private readonly adapters = new Map<ComputeProvider, ComputeProviderAdapter>();

  register(adapter: ComputeProviderAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  get(provider: ComputeProvider): ComputeProviderAdapter | undefined {
    return this.adapters.get(provider);
  }

  list(): ComputeProvider[] {
    return [...this.adapters.keys()];
  }
}

export function createDefaultComputeAdapterRegistry(): ComputeAdapterRegistry {
  const registry = new ComputeAdapterRegistry();
  registry.register(new LambdaComputeAdapter());
  registry.register(new RunPodComputeAdapter());
  registry.register(new VeniceComputeAdapter());
  return registry;
}
