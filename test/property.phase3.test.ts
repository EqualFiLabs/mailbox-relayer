import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BankrComputeAdapter } from '../src/providers/bankr';
import { LambdaComputeAdapter } from '../src/providers/lambda';
import { ComputePolicy, MODE_TO_PROVIDER } from '../src/providers/policy';
import { ComputeAdapterRegistry } from '../src/providers/registry';
import { RunPodComputeAdapter } from '../src/providers/runpod';
import { ComputeProvider, ComputeProviderAdapter, ProvisionRequest, ProvisionResult, TerminateRequest, TerminateResult, UsageRequest, UsageResult } from '../src/providers/types';
import { CANONICAL_UNIT_TYPES, resolveCanonicalUnitType } from '../src/providers/unit-types';
import { VeniceComputeAdapter } from '../src/providers/venice';

type MockResponseInit = {
  ok: boolean;
  status: number;
  json: unknown;
  headers?: Record<string, string>;
};

class StubAdapter implements ComputeProviderAdapter {
  constructor(readonly provider: ComputeProvider) {}

  async provision(_request: ProvisionRequest): Promise<ProvisionResult> {
    return { status: 'ok', provider: this.provider, providerResourceId: `${this.provider}-resource` };
  }

  async usage(_request: UsageRequest): Promise<UsageResult> {
    return { status: 'ok', provider: this.provider, usage: [] };
  }

  async terminate(_request: TerminateRequest): Promise<TerminateResult> {
    return { status: 'ok', provider: this.provider, terminated: true };
  }
}

function makeResponse(init: MockResponseInit): Response {
  return {
    ok: init.ok,
    status: init.status,
    headers: new Headers(init.headers ?? {}),
    json: async () => init.json,
  } as unknown as Response;
}

function canonicalSet(): Set<string> {
  return new Set(CANONICAL_UNIT_TYPES.map((unitType) => unitType.id));
}

describe('Phase 3 property-based tests', () => {
  it('14.1 Property 7: canonical unit mapping completeness for provider metrics', async () => {
    const entries = CANONICAL_UNIT_TYPES.flatMap((unitType) =>
      (Object.entries(unitType.providerMappings) as Array<[ComputeProvider, string[]]>).flatMap(([provider, metrics]) => {
        const allMetrics = [unitType.id, ...metrics];
        return allMetrics.map((metric) => ({ provider, metric, expected: unitType.id }));
      })
    );

    const knownCanonical = canonicalSet();

    await fc.assert(
      fc.property(
        fc.constantFrom(...entries),
        fc.constantFrom<'identity' | 'upper' | 'lower'>('identity', 'upper', 'lower'),
        fc.integer({ min: 0, max: 2 }),
        fc.integer({ min: 0, max: 2 }),
        (entry, casing, leftPad, rightPad) => {
          const casedMetric =
            casing === 'upper' ? entry.metric.toUpperCase() : casing === 'lower' ? entry.metric.toLowerCase() : entry.metric;
          const fuzzedMetric = `${' '.repeat(leftPad)}${casedMetric}${' '.repeat(rightPad)}`;
          const resolved = resolveCanonicalUnitType(entry.provider, fuzzedMetric);
          expect(resolved).toBe(entry.expected);
          expect(knownCanonical.has(entry.expected)).toBe(true);
        }
      ),
      { numRuns: 250 }
    );
  });

  it('14.1 Property 7: no adapter usage emits a unit type outside canonical registry', async () => {
    const knownCanonical = canonicalSet();

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<'venice' | 'bankr' | 'lambda' | 'runpod_serverless' | 'runpod_pod'>(
          'venice',
          'bankr',
          'lambda',
          'runpod_serverless',
          'runpod_pod'
        ),
        fc.integer({ min: 1, max: 999 }),
        async (adapterKind, amount) => {
          if (adapterKind === 'venice') {
            const metric = 'prompt_tokens';
            const adapter = new VeniceComputeAdapter({
              apiKey: 'venice-key',
              fetchFn: async () =>
                makeResponse({
                  ok: true,
                  status: 200,
                  json: {
                    data: [
                      {
                        metric,
                        amount: String(amount),
                        observedAt: '2026-03-13T10:00:00.000Z',
                        id: 'v-1',
                      },
                    ],
                    pagination: { hasNext: false },
                  },
                }),
            });

            const result = await adapter.usage({ agreementId: 'agreement-prop3-venice', to: '2026-03-13T12:00:00.000Z' });
            expect(result.status).toBe('ok');
            for (const row of result.usage) {
              expect(knownCanonical.has(row.unitType)).toBe(true);
            }
            return;
          }

          if (adapterKind === 'bankr') {
            const metric = 'completion_tokens';
            const adapter = new BankrComputeAdapter({
              apiKey: 'bankr-key',
              fetchFn: async () =>
                makeResponse({
                  ok: true,
                  status: 200,
                  json: {
                    data: [
                      {
                        metric,
                        amount: String(amount),
                        observedAt: '2026-03-13T10:00:00.000Z',
                        id: 'b-1',
                      },
                    ],
                    pagination: { hasNext: false },
                  },
                }),
            });

            const result = await adapter.usage({ agreementId: 'agreement-prop3-bankr', to: '2026-03-13T12:00:00.000Z' });
            expect(result.status).toBe('ok');
            for (const row of result.usage) {
              expect(knownCanonical.has(row.unitType)).toBe(true);
            }
            return;
          }

          if (adapterKind === 'lambda') {
            const adapter = new LambdaComputeAdapter({
              apiKey: 'lambda-key',
              fetchFn: async () =>
                makeResponse({
                  ok: true,
                  status: 200,
                  json: {
                    data: {
                      status: 'active',
                      launch_time: '2026-03-13T08:00:00.000Z',
                      instance_type_name: 'gpu_1x_a100',
                    },
                  },
                }),
            });

            const result = await adapter.usage({
              agreementId: 'agreement-prop3-lambda',
              providerResourceId: 'instance-prop3',
              from: '2026-03-13T08:00:00.000Z',
              to: '2026-03-13T09:00:00.000Z',
            });
            expect(result.status).toBe('ok');
            for (const row of result.usage) {
              expect(knownCanonical.has(row.unitType)).toBe(true);
            }
            return;
          }

          if (adapterKind === 'runpod_serverless') {
            const adapter = new RunPodComputeAdapter({
              apiKey: 'runpod-key',
              loadCompletionEvents: async () => [
                {
                  id: 'job-prop3-1',
                  executionTime: amount,
                  completedAt: '2026-03-13T10:05:00.000Z',
                },
              ],
              loadInFlightJobIds: async () => [],
              nowFn: () => '2026-03-13T10:10:00.000Z',
            });

            const result = await adapter.usage({
              agreementId: 'agreement-prop3-runpod-sls',
              providerResourceId: 'ep_prop3_1',
              from: '2026-03-13T10:00:00.000Z',
              to: '2026-03-13T11:00:00.000Z',
            });

            expect(result.status).toBe('ok');
            for (const row of result.usage) {
              expect(knownCanonical.has(row.unitType)).toBe(true);
            }
            return;
          }

          const adapter = new RunPodComputeAdapter({
            apiKey: 'runpod-key',
            fetchFn: async (input) => {
              const url = String(input);
              if (url.endsWith('/pods/pod_prop3_1')) {
                return makeResponse({
                  ok: true,
                  status: 200,
                  json: {
                    data: {
                      id: 'pod_prop3_1',
                      desiredStatus: 'RUNNING',
                      createdAt: '2026-03-13T07:00:00.000Z',
                      gpu: { displayName: 'NVIDIA H100 80GB' },
                    },
                  },
                });
              }
              return makeResponse({ ok: false, status: 404, json: { error: 'unexpected request' } });
            },
          });

          const result = await adapter.usage({
            agreementId: 'agreement-prop3-runpod-pod',
            providerResourceId: 'pod_prop3_1',
            from: '2026-03-13T08:00:00.000Z',
            to: '2026-03-13T10:00:00.000Z',
          });

          expect(result.status).toBe('ok');
          for (const row of result.usage) {
            expect(knownCanonical.has(row.unitType)).toBe(true);
          }
        }
      ),
      { numRuns: 60 }
    );
  });

  it('14.2 Property 8: adapter routing is deterministic for the same policy', async () => {
    await fc.assert(
      fc.property(
        fc.record({
          provider: fc.option(fc.constantFrom<ComputeProvider>('lambda', 'runpod', 'venice', 'bankr'), { nil: undefined }),
          computeMode: fc.option(fc.constantFrom<'dedicated' | 'burst' | 'api_inference'>('dedicated', 'burst', 'api_inference'), {
            nil: undefined,
          }),
          disableLambda: fc.boolean(),
          disableRunpod: fc.boolean(),
          disableVenice: fc.boolean(),
          disableBankr: fc.boolean(),
        }),
        (input) => {
          const registry = new ComputeAdapterRegistry({ info: () => undefined });
          registry.register(new StubAdapter('lambda'));
          registry.register(new StubAdapter('runpod'));
          registry.register(new StubAdapter('venice'));
          registry.register(new StubAdapter('bankr'));

          if (input.disableLambda) registry.disable('lambda');
          if (input.disableRunpod) registry.disable('runpod');
          if (input.disableVenice) registry.disable('venice');
          if (input.disableBankr) registry.disable('bankr');

          const policy: ComputePolicy = {
            ...(input.provider ? { provider: input.provider } : {}),
            ...(input.computeMode ? { computeMode: input.computeMode } : {}),
          };

          const first = registry.resolve(policy)?.provider;
          const second = registry.resolve(policy)?.provider;
          const third = registry.resolve({ ...policy })?.provider;

          const candidate = input.provider ?? (input.computeMode ? MODE_TO_PROVIDER[input.computeMode] : undefined);
          const disabled = candidate
            ? (candidate === 'lambda' && input.disableLambda) ||
              (candidate === 'runpod' && input.disableRunpod) ||
              (candidate === 'venice' && input.disableVenice) ||
              (candidate === 'bankr' && input.disableBankr)
            : false;

          const expected = candidate && !disabled ? candidate : undefined;

          expect(first).toBe(second);
          expect(second).toBe(third);
          expect(first).toBe(expected);
        }
      ),
      { numRuns: 250 }
    );
  });

  it('14.3 Properties 5/6: Lambda usage is deterministic for identical inputs', async () => {
    const instanceTypes = ['gpu_1x_a100', 'gpu_1x_h100_pcie', 'gpu_1x_a10'] as const;
    const statuses = ['active', 'terminated', 'error'] as const;
    const baseMs = Date.parse('2026-03-01T00:00:00.000Z');

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...instanceTypes),
        fc.constantFrom(...statuses),
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: -12, max: 48 }),
        fc.integer({ min: 1, max: 48 }),
        fc.option(fc.integer({ min: 1, max: 240 }), { nil: undefined }),
        async (instanceType, status, launchOffsetHours, fromOffsetHours, windowHours, stopOffsetHours) => {
          const launchMs = baseMs + launchOffsetHours * 3_600_000;
          const fromMs = launchMs + fromOffsetHours * 3_600_000;
          const toMs = fromMs + windowHours * 3_600_000;
          const stopMs = stopOffsetHours ? launchMs + stopOffsetHours * 3_600_000 : undefined;

          const adapter = new LambdaComputeAdapter({
            apiKey: 'lambda-key',
            fetchFn: async () =>
              makeResponse({
                ok: true,
                status: 200,
                json: {
                  data: {
                    status,
                    launch_time: new Date(launchMs).toISOString(),
                    instance_type_name: instanceType,
                    ...(stopMs ? { terminated_at: new Date(stopMs).toISOString() } : {}),
                  },
                },
              }),
          });

          const request = {
            agreementId: 'agreement-prop3-lambda-determinism',
            providerResourceId: 'instance-prop3-determinism',
            from: new Date(fromMs).toISOString(),
            to: new Date(toMs).toISOString(),
          };

          const first = await adapter.usage(request);
          const second = await adapter.usage(request);

          expect(first).toEqual(second);
        }
      ),
      { numRuns: 80 }
    );
  });

  it('14.3 Properties 5/6: RunPod usage is deterministic for identical inputs', async () => {
    const baseMs = Date.parse('2026-03-10T00:00:00.000Z');

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 400 }),
        fc.integer({ min: 1, max: 400 }),
        fc.integer({ min: 1, max: 600 }),
        fc.constantFrom('NVIDIA A100 80GB', 'NVIDIA H100 80GB', 'NVIDIA A10'),
        async (eventOffsetA, eventOffsetB, execSeconds, gpuLabel) => {
          const completionEvents = [
            {
              id: 'job-a',
              status: 'COMPLETED',
              executionTime: execSeconds,
              completedAt: new Date(baseMs + eventOffsetA * 1000).toISOString(),
            },
            {
              id: 'job-b',
              status: 'COMPLETED',
              executionTime: execSeconds,
              completedAt: new Date(baseMs + eventOffsetB * 1000).toISOString(),
            },
          ];

          const runpodServerless = new RunPodComputeAdapter({
            apiKey: 'runpod-key',
            loadCompletionEvents: async () => completionEvents,
            loadInFlightJobIds: async () => ['job-b'],
            fetchFn: async (input) => {
              const url = String(input);
              if (url.includes('/status/job-b')) {
                return makeResponse({
                  ok: true,
                  status: 200,
                  json: {
                    data: {
                      id: 'job-b',
                      status: 'COMPLETED',
                      executionTime: execSeconds,
                      completedAt: completionEvents[1].completedAt,
                    },
                  },
                });
              }
              return makeResponse({ ok: false, status: 404, json: { error: 'unexpected request' } });
            },
            nowFn: () => '2026-03-10T12:00:00.000Z',
          });

          const usageRequest = {
            agreementId: 'agreement-prop3-runpod-sls-determinism',
            providerResourceId: 'ep_prop3_determinism',
            from: '2026-03-10T00:00:00.000Z',
            to: '2026-03-10T23:00:00.000Z',
          };

          const firstServerless = await runpodServerless.usage(usageRequest);
          const secondServerless = await runpodServerless.usage(usageRequest);
          expect(firstServerless).toEqual(secondServerless);

          const runpodPod = new RunPodComputeAdapter({
            apiKey: 'runpod-key',
            fetchFn: async (input) => {
              const url = String(input);
              if (url.endsWith('/pods/pod_prop3_determinism')) {
                return makeResponse({
                  ok: true,
                  status: 200,
                  json: {
                    data: {
                      id: 'pod_prop3_determinism',
                      desiredStatus: 'RUNNING',
                      createdAt: '2026-03-10T01:00:00.000Z',
                      gpu: { displayName: gpuLabel },
                    },
                  },
                });
              }
              return makeResponse({ ok: false, status: 404, json: { error: 'unexpected request' } });
            },
          });

          const podRequest = {
            agreementId: 'agreement-prop3-runpod-pod-determinism',
            providerResourceId: 'pod_prop3_determinism',
            from: '2026-03-10T02:00:00.000Z',
            to: '2026-03-10T03:00:00.000Z',
          };
          const firstPod = await runpodPod.usage(podRequest);
          const secondPod = await runpodPod.usage(podRequest);
          expect(firstPod).toEqual(secondPod);
        }
      ),
      { numRuns: 70 }
    );
  });
});
