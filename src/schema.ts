import { z } from 'zod';

const hexRegex = /^[a-fA-F0-9]+$/;

const evenHexString = z
  .string()
  .regex(hexRegex, 'must be hex without 0x prefix')
  .refine((value) => value.length % 2 === 0, 'hex string must have even length');

export const mailboxCipherSchema = z.object({
  // 16-byte IV serialized to 32 hex chars by eth-crypto
  iv: z.string().regex(/^[a-fA-F0-9]{32}$/, 'iv must be 32 hex chars'),
  // EthCrypto typically returns uncompressed ephem key with 04 prefix (130 hex chars)
  ephemPublicKey: z
    .string()
    .regex(/^[a-fA-F0-9]+$/, 'ephemPublicKey must be hex without 0x prefix')
    .refine((value) => value.length === 128 || value.length === 130, 'ephemPublicKey must be 128 or 130 hex chars'),
  ciphertext: evenHexString,
  // 32-byte MAC serialized to 64 hex chars
  mac: z.string().regex(/^[a-fA-F0-9]{64}$/, 'mac must be 64 hex chars'),
});

export const canonicalEnvelopeSchema = z
  .object({
    version: z.literal('equalfi.mailbox.ecies.eth-crypto.v1'),
    recipient: z.string().min(1),
    cipher: mailboxCipherSchema,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
    traceId: z.string().min(1).optional(),
  })
  .refine(
    (value) => !value.expiresAt || Date.parse(value.expiresAt) > Date.parse(value.createdAt),
    'expiresAt must be after createdAt'
  );

export const ackSchema = z.object({
  provider: z.string().min(1).optional(),
  meta: z.record(z.unknown()).optional(),
});

export const demoVerticalFlowSchema = z.object({
  provider: z.enum(['lambda', 'runpod', 'venice', 'bankr']).default('venice'),
  agreementId: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
});

export const onchainEventSchema = z.object({
  chainId: z.number().int().positive(),
  blockNumber: z.number().int().nonnegative(),
  logIndex: z.number().int().nonnegative(),
  txHash: z.string().min(1).optional(),
  eventType: z.enum([
    'activation',
    'mailbox',
    'breach',
    'default',
    'risk_covenant_breached',
    'risk_draw_terminated',
    'risk_defaulted',
    'agreement_closed',
  ]),
  agreementId: z.string().min(1),
  provider: z.enum(['lambda', 'runpod', 'venice', 'bankr']).optional(),
  traceId: z.string().min(1).optional(),
  envelope: canonicalEnvelopeSchema.optional(),
  policy: z.record(z.unknown()).optional(),
  payload: z.record(z.unknown()).optional(),
  reason: z.string().min(1).optional(),
});

export const onchainEventBatchSchema = z.object({
  events: z.array(onchainEventSchema).min(1),
});
