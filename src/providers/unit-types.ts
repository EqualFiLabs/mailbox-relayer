import { ComputeProvider } from './types';

export interface CanonicalUnitType {
  id: string;
  name: string;
  providerMappings: Partial<Record<ComputeProvider, string[]>>;
}

export const CANONICAL_UNIT_TYPES: CanonicalUnitType[] = [
  {
    id: 'GPU_HOUR_A100',
    name: 'A100 GPU Hour',
    providerMappings: {
      lambda: ['gpu_1x_a100', 'gpu_1x_a100_sxm4'],
    },
  },
  {
    id: 'GPU_HOUR_H100',
    name: 'H100 GPU Hour',
    providerMappings: {
      lambda: ['gpu_1x_h100_pcie', 'gpu_1x_h100_sxm5'],
    },
  },
  {
    id: 'GPU_HOUR_A10',
    name: 'A10 GPU Hour',
    providerMappings: {
      lambda: ['gpu_1x_a10'],
    },
  },
  {
    id: 'RUNPOD_GPU_SEC',
    name: 'RunPod GPU Second',
    providerMappings: {
      runpod: ['gpu_second', 'gpu_seconds'],
    },
  },
  {
    id: 'RUNPOD_INFERENCE_REQUEST',
    name: 'RunPod Inference Request',
    providerMappings: {
      runpod: ['inference_request', 'request'],
    },
  },
  {
    id: 'VENICE_TEXT_TOKEN_IN',
    name: 'Venice Text Input Token',
    providerMappings: {
      venice: ['input', 'prompt', 'prompt_tokens'],
    },
  },
  {
    id: 'VENICE_TEXT_TOKEN_OUT',
    name: 'Venice Text Output Token',
    providerMappings: {
      venice: ['output', 'completion', 'completion_tokens'],
    },
  },
  {
    id: 'VENICE_IMAGE_GEN',
    name: 'Venice Image Generation',
    providerMappings: {
      venice: ['image', 'image_generation'],
    },
  },
  {
    id: 'VENICE_AUDIO_TTS_CHAR',
    name: 'Venice TTS Character',
    providerMappings: {
      venice: ['tts', 'char', 'tts_characters'],
    },
  },
  {
    id: 'VENICE_AUDIO_STT_SEC',
    name: 'Venice STT Second',
    providerMappings: {
      venice: ['stt', 'audio_sec', 'second', 'stt_seconds'],
    },
  },
  {
    id: 'BANKR_TEXT_TOKEN_IN',
    name: 'Bankr Text Input Token',
    providerMappings: {
      bankr: ['input', 'prompt', 'prompt_tokens'],
    },
  },
  {
    id: 'BANKR_TEXT_TOKEN_OUT',
    name: 'Bankr Text Output Token',
    providerMappings: {
      bankr: ['output', 'completion', 'completion_tokens'],
    },
  },
];

function normalizeMetric(metric: string): string {
  return metric.trim().toLowerCase();
}

export function resolveCanonicalUnitType(provider: ComputeProvider, providerMetric: string): string | undefined {
  const normalizedMetric = normalizeMetric(providerMetric);

  for (const unitType of CANONICAL_UNIT_TYPES) {
    const mappings = unitType.providerMappings[provider];
    if (!mappings || mappings.length === 0) continue;

    if (normalizeMetric(unitType.id) === normalizedMetric) return unitType.id;

    if (mappings.some((metric) => normalizeMetric(metric) === normalizedMetric)) {
      return unitType.id;
    }
  }

  return undefined;
}

export function getProviderUnitTypes(provider: ComputeProvider): string[] {
  return CANONICAL_UNIT_TYPES.filter((unitType) => (unitType.providerMappings[provider] ?? []).length > 0).map(
    (unitType) => unitType.id
  );
}
