import { z } from 'zod';
import { ComputeProvider } from './types';

export const computeProviderSchema = z.enum(['lambda', 'runpod', 'venice', 'bankr']);
export const computeModeSchema = z.enum(['dedicated', 'burst', 'api_inference']);

export type ComputeMode = z.infer<typeof computeModeSchema>;

export const computePolicySchema = z.object({
  provider: computeProviderSchema.optional(),
  computeMode: computeModeSchema.optional(),
  instanceType: z.string().optional(),
  region: z.string().optional(),
  model: z.string().optional(),
  maxWorkers: z.number().int().positive().optional(),
  minWorkers: z.number().int().nonnegative().optional(),
  idleTimeout: z.number().int().positive().optional(),
  executionTimeoutMs: z.number().int().positive().optional(),
  jobTtlMs: z.number().int().positive().optional(),
  webhookUrl: z.string().url().optional(),
  sshPublicKey: z.string().optional(),
  consumptionLimit: z.record(z.unknown()).optional(),
});

export type ComputePolicy = z.infer<typeof computePolicySchema>;

export const MODE_TO_PROVIDER: Record<ComputeMode, ComputeProvider> = {
  dedicated: 'lambda',
  burst: 'runpod',
  api_inference: 'venice',
};
