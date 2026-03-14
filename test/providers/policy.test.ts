import { describe, expect, it } from 'vitest';
import { computePolicySchema, MODE_TO_PROVIDER } from '../../src/providers/policy';

describe('computePolicySchema', () => {
  it('accepts valid compute policies', () => {
    const parsed = computePolicySchema.parse({
      provider: 'bankr',
      computeMode: 'api_inference',
      instanceType: 'gpu_1x_h100_pcie',
      region: 'us-west-1',
      model: 'llama-3.3-70b',
      maxWorkers: 4,
      minWorkers: 0,
      idleTimeout: 60,
      executionTimeoutMs: 600000,
      jobTtlMs: 86400000,
      webhookUrl: 'https://example.com/hooks/runpod',
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK',
      consumptionLimit: { usd: 100 },
    });

    expect(parsed.provider).toBe('bankr');
    expect(parsed.computeMode).toBe('api_inference');
    expect(parsed.maxWorkers).toBe(4);
    expect(parsed.minWorkers).toBe(0);
  });

  it('rejects invalid compute policies', () => {
    const invalidProvider = computePolicySchema.safeParse({ provider: 'modal' });
    expect(invalidProvider.success).toBe(false);

    const invalidComputeMode = computePolicySchema.safeParse({ computeMode: 'batch' });
    expect(invalidComputeMode.success).toBe(false);

    const invalidWebhook = computePolicySchema.safeParse({ webhookUrl: 'not-a-url' });
    expect(invalidWebhook.success).toBe(false);

    const invalidMaxWorkers = computePolicySchema.safeParse({ maxWorkers: 0 });
    expect(invalidMaxWorkers.success).toBe(false);

    const invalidMinWorkers = computePolicySchema.safeParse({ minWorkers: -1 });
    expect(invalidMinWorkers.success).toBe(false);
  });

  it('defines compute mode to default provider routing map', () => {
    expect(MODE_TO_PROVIDER).toEqual({
      dedicated: 'lambda',
      burst: 'runpod',
      api_inference: 'venice',
    });
  });
});
