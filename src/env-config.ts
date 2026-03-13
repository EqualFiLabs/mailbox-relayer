import { z } from 'zod';

const privateKeySchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'must be a 32-byte hex private key with 0x prefix');

const numericFromEnv = <T extends z.ZodTypeAny>(schema: T, fallback?: number) =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }

    if (typeof value === 'number') {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    }

    return value;
  }, schema);

export const phase2EnvSchema = z
  .object({
    RPC_URL: z.string().url(),
    DIAMOND_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 20-byte hex address with 0x prefix'),
    CHAIN_ID: numericFromEnv(z.number().int().positive()),

    EVENT_LISTENER_START_BLOCK: numericFromEnv(z.number().int().nonnegative(), 0),
    CONFIRMATION_DEPTH: numericFromEnv(z.number().int().nonnegative(), 12),
    EVENT_POLL_INTERVAL_MS: numericFromEnv(z.number().int().positive(), 2000),

    RELAYER_PRIVATE_KEY: privateKeySchema,
    RELAYER_ENCRYPTION_PRIVATE_KEY: privateKeySchema.optional(),

    TX_TIMEOUT_MS: numericFromEnv(z.number().int().positive(), 60000),
    GAS_LIMIT_MULTIPLIER: numericFromEnv(z.number().positive(), 1.2),
    MAX_GAS_PRICE_GWEI: numericFromEnv(z.number().positive(), 100),
    LOW_BALANCE_THRESHOLD_ETH: numericFromEnv(z.number().positive(), 0.01),

    PROVIDER_EVENT_AUTH_TOKEN: z.string().min(1).optional(),
    IDENTITY_MODE: z.enum(['none', 'erc8004_offchain']).default('none'),
    ERC8004_RPC_URL: z.string().url().optional(),
    ERC8004_CHAIN_ID: numericFromEnv(z.number().int().positive()).optional(),
    ERC8004_REGISTRY_ADDRESS: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 20-byte hex address with 0x prefix')
      .optional(),
    IDENTITY_PROOF_MAX_SKEW_SECONDS: numericFromEnv(z.number().int().nonnegative(), 60),
  })
  .superRefine((value, ctx) => {
    if (
      value.RELAYER_ENCRYPTION_PRIVATE_KEY &&
      value.RELAYER_ENCRYPTION_PRIVATE_KEY.toLowerCase() === value.RELAYER_PRIVATE_KEY.toLowerCase()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RELAYER_ENCRYPTION_PRIVATE_KEY'],
        message: 'RELAYER_PRIVATE_KEY and RELAYER_ENCRYPTION_PRIVATE_KEY must be different',
      });
    }

    if (value.IDENTITY_MODE === 'erc8004_offchain') {
      if (!value.ERC8004_RPC_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ERC8004_RPC_URL'],
          message: 'ERC8004_RPC_URL is required when IDENTITY_MODE=erc8004_offchain',
        });
      }

      if (!value.ERC8004_CHAIN_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ERC8004_CHAIN_ID'],
          message: 'ERC8004_CHAIN_ID is required when IDENTITY_MODE=erc8004_offchain',
        });
      }

      if (!value.ERC8004_REGISTRY_ADDRESS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ERC8004_REGISTRY_ADDRESS'],
          message: 'ERC8004_REGISTRY_ADDRESS is required when IDENTITY_MODE=erc8004_offchain',
        });
      }
    }
  });

export type Phase2Env = z.infer<typeof phase2EnvSchema>;

export function validatePhase2Env(env: Record<string, string | undefined>): Phase2Env {
  return phase2EnvSchema.parse(env);
}
