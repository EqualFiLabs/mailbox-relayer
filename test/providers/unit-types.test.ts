import { describe, expect, it } from 'vitest';
import {
  CANONICAL_UNIT_TYPES,
  getProviderUnitTypes,
  resolveCanonicalUnitType,
} from '../../src/providers/unit-types';

describe('Canonical unit type registry', () => {
  it('resolves canonical type for every provider-metric mapping in the registry', () => {
    for (const unitType of CANONICAL_UNIT_TYPES) {
      for (const provider of ['lambda', 'runpod', 'venice', 'bankr'] as const) {
        const metrics = unitType.providerMappings[provider] ?? [];
        for (const metric of metrics) {
          expect(resolveCanonicalUnitType(provider, metric)).toBe(unitType.id);
          expect(resolveCanonicalUnitType(provider, metric.toUpperCase())).toBe(unitType.id);
        }
      }
    }
  });

  it('returns undefined when metric does not map to a canonical unit type', () => {
    expect(resolveCanonicalUnitType('lambda', 'unknown_metric')).toBeUndefined();
    expect(resolveCanonicalUnitType('runpod', 'unknown_metric')).toBeUndefined();
    expect(resolveCanonicalUnitType('venice', 'unknown_metric')).toBeUndefined();
    expect(resolveCanonicalUnitType('bankr', 'unknown_metric')).toBeUndefined();
  });

  it('returns canonical unit IDs available for each provider', () => {
    expect(getProviderUnitTypes('lambda')).toEqual(['GPU_HOUR_A100', 'GPU_HOUR_H100', 'GPU_HOUR_A10']);
    expect(getProviderUnitTypes('runpod')).toEqual(['RUNPOD_GPU_SEC', 'RUNPOD_INFERENCE_REQUEST']);
    expect(getProviderUnitTypes('venice')).toEqual([
      'VENICE_TEXT_TOKEN_IN',
      'VENICE_TEXT_TOKEN_OUT',
      'VENICE_IMAGE_GEN',
      'VENICE_AUDIO_TTS_CHAR',
      'VENICE_AUDIO_STT_SEC',
    ]);
    expect(getProviderUnitTypes('bankr')).toEqual(['BANKR_TEXT_TOKEN_IN', 'BANKR_TEXT_TOKEN_OUT']);
  });
});
