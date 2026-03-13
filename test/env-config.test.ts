import { describe, expect, it } from 'vitest';
import { validatePhase2Env } from '../src/env-config';

const baseEnv = {
  RPC_URL: 'https://example-rpc.local',
  DIAMOND_ADDRESS: '0x1111111111111111111111111111111111111111',
  CHAIN_ID: '84532',
  RELAYER_PRIVATE_KEY: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as const;

describe('phase2 env config', () => {
  it('parses required env and applies defaults', () => {
    const parsed = validatePhase2Env({ ...baseEnv });

    expect(parsed.CHAIN_ID).toBe(84532);
    expect(parsed.EVENT_LISTENER_START_BLOCK).toBe(0);
    expect(parsed.CONFIRMATION_DEPTH).toBe(12);
    expect(parsed.EVENT_POLL_INTERVAL_MS).toBe(2000);
    expect(parsed.TX_TIMEOUT_MS).toBe(60000);
    expect(parsed.GAS_LIMIT_MULTIPLIER).toBe(1.2);
    expect(parsed.MAX_GAS_PRICE_GWEI).toBe(100);
    expect(parsed.LOW_BALANCE_THRESHOLD_ETH).toBe(0.01);
    expect(parsed.IDENTITY_MODE).toBe('none');
    expect(parsed.IDENTITY_PROOF_MAX_SKEW_SECONDS).toBe(60);
  });

  it('accepts explicit optional values', () => {
    const parsed = validatePhase2Env({
      ...baseEnv,
      EVENT_LISTENER_START_BLOCK: '50',
      CONFIRMATION_DEPTH: '8',
      EVENT_POLL_INTERVAL_MS: '1000',
      TX_TIMEOUT_MS: '45000',
      GAS_LIMIT_MULTIPLIER: '1.5',
      MAX_GAS_PRICE_GWEI: '90',
      LOW_BALANCE_THRESHOLD_ETH: '0.05',
      PROVIDER_EVENT_AUTH_TOKEN: 'secret',
      RELAYER_ENCRYPTION_PRIVATE_KEY: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });

    expect(parsed.EVENT_LISTENER_START_BLOCK).toBe(50);
    expect(parsed.CONFIRMATION_DEPTH).toBe(8);
    expect(parsed.EVENT_POLL_INTERVAL_MS).toBe(1000);
    expect(parsed.TX_TIMEOUT_MS).toBe(45000);
    expect(parsed.GAS_LIMIT_MULTIPLIER).toBe(1.5);
    expect(parsed.MAX_GAS_PRICE_GWEI).toBe(90);
    expect(parsed.LOW_BALANCE_THRESHOLD_ETH).toBe(0.05);
    expect(parsed.PROVIDER_EVENT_AUTH_TOKEN).toBe('secret');
  });

  it('fails when required keys are missing', () => {
    expect(() => validatePhase2Env({ ...baseEnv, RPC_URL: undefined })).toThrow();
    expect(() => validatePhase2Env({ ...baseEnv, DIAMOND_ADDRESS: undefined })).toThrow();
    expect(() => validatePhase2Env({ ...baseEnv, CHAIN_ID: undefined })).toThrow();
    expect(() => validatePhase2Env({ ...baseEnv, RELAYER_PRIVATE_KEY: undefined })).toThrow();
  });

  it('fails key separation when signing and encryption keys are identical', () => {
    expect(() =>
      validatePhase2Env({
        ...baseEnv,
        RELAYER_ENCRYPTION_PRIVATE_KEY: baseEnv.RELAYER_PRIVATE_KEY,
      })
    ).toThrow('must be different');
  });

  it('requires ERC-8004 resolver env vars when IDENTITY_MODE=erc8004_offchain', () => {
    expect(() =>
      validatePhase2Env({
        ...baseEnv,
        IDENTITY_MODE: 'erc8004_offchain',
      })
    ).toThrow('ERC8004_RPC_URL is required');
  });

  it('accepts resolver env vars when IDENTITY_MODE=erc8004_offchain', () => {
    const parsed = validatePhase2Env({
      ...baseEnv,
      IDENTITY_MODE: 'erc8004_offchain',
      ERC8004_RPC_URL: 'https://base-rpc.example',
      ERC8004_CHAIN_ID: '84532',
      ERC8004_REGISTRY_ADDRESS: '0x2222222222222222222222222222222222222222',
      IDENTITY_PROOF_MAX_SKEW_SECONDS: '120',
    });

    expect(parsed.IDENTITY_MODE).toBe('erc8004_offchain');
    expect(parsed.ERC8004_RPC_URL).toBe('https://base-rpc.example');
    expect(parsed.ERC8004_CHAIN_ID).toBe(84532);
    expect(parsed.ERC8004_REGISTRY_ADDRESS).toBe('0x2222222222222222222222222222222222222222');
    expect(parsed.IDENTITY_PROOF_MAX_SKEW_SECONDS).toBe(120);
  });
});
