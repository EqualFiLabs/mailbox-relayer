import { describe, expect, it } from 'vitest';
import { DeterministicMeteringWorker } from '../src/metering';
import { ComputeAdapterRegistry } from '../src/providers';
import {
  ComputeProvider,
  ComputeProviderAdapter,
  ProvisionRequest,
  ProvisionResult,
  TerminateRequest,
  TerminateResult,
  UsageRequest,
  UsageResult,
} from '../src/providers/types';
import { InMemoryMessageStore } from '../src/store';

class StaticUsageAdapter implements ComputeProviderAdapter {
  readonly provider: ComputeProvider;
  private readonly rows: UsageResult['usage'];

  constructor(provider: ComputeProvider, rows: UsageResult['usage']) {
    this.provider = provider;
    this.rows = rows;
  }

  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    return {
      status: 'ok',
      provider: this.provider,
      providerResourceId: `${this.provider}-${request.agreementId}`,
    };
  }

  async usage(_request: UsageRequest): Promise<UsageResult> {
    return {
      status: 'ok',
      provider: this.provider,
      usage: this.rows,
    };
  }

  async terminate(_request: TerminateRequest): Promise<TerminateResult> {
    return {
      status: 'ok',
      provider: this.provider,
      terminated: true,
    };
  }
}

const UNIT_PRICES: Record<string, bigint> = {
  VENICE_TEXT_TOKEN_IN: 4n,
  VENICE_TEXT_TOKEN_OUT: 9n,
  BANKR_TEXT_TOKEN_IN: 4n,
  BANKR_TEXT_TOKEN_OUT: 9n,
  GPU_HOUR_A100: 100n,
  RUNPOD_INFERENCE_REQUEST: 50n,
  RUNPOD_GPU_SEC: 2n,
};

function computePrincipalDrawn(items: Array<{ unitType: string; amount: string }>): bigint {
  return items.reduce((total, item) => {
    const price = UNIT_PRICES[item.unitType];
    if (price === undefined) {
      throw new Error(`missing unit price for ${item.unitType}`);
    }
    return total + BigInt(item.amount) * price;
  }, 0n);
}

function setAgreementLink(
  store: InMemoryMessageStore,
  agreementId: string,
  provider: ComputeProvider,
  providerResourceId: string
): void {
  store.setProviderLink({
    agreementId,
    provider,
    providerResourceId,
    updatedAt: '2026-03-14T09:00:00.000Z',
  });
}

function buildTraceRows(
  unitType: string,
  amounts: number[],
  requestIdPrefix: string
): UsageResult['usage'] {
  return amounts.map((amount, index) => ({
    unitType,
    amount: String(amount),
    observedAt: `2026-03-14T09:00:${String(index).padStart(2, '0')}.000Z`,
    requestId: `${requestIdPrefix}-${String(index + 1).padStart(2, '0')}`,
  }));
}

function buildApiInferenceTrace(provider: 'venice' | 'bankr'): UsageResult['usage'] {
  const inUnit = provider === 'venice' ? 'VENICE_TEXT_TOKEN_IN' : 'BANKR_TEXT_TOKEN_IN';
  const outUnit = provider === 'venice' ? 'VENICE_TEXT_TOKEN_OUT' : 'BANKR_TEXT_TOKEN_OUT';

  return [
    ...buildTraceRows(inUnit, [100, 120, 140, 160, 180], `${provider}-in`),
    ...buildTraceRows(outUnit, [40, 50, 60, 70, 80], `${provider}-out`),
  ];
}

function buildLambdaTrace(): UsageResult['usage'] {
  return buildTraceRows('GPU_HOUR_A100', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'lambda-gpu-hour');
}

function buildRunPodBurstTrace(): UsageResult['usage'] {
  return [
    ...buildTraceRows('RUNPOD_INFERENCE_REQUEST', [10, 10, 10, 10, 10], 'runpod-req'),
    ...buildTraceRows('RUNPOD_GPU_SEC', [300, 300, 300, 300, 300], 'runpod-gpu-sec'),
  ];
}

describe('differential accounting equivalence', () => {
  it('12.1 API inference adapters (Venice + Bankr) match Lambda principalDrawn for same synthetic trace', async () => {
    const store = new InMemoryMessageStore();
    const registry = new ComputeAdapterRegistry();

    registry.register(new StaticUsageAdapter('venice', buildApiInferenceTrace('venice')));
    registry.register(new StaticUsageAdapter('bankr', buildApiInferenceTrace('bankr')));
    registry.register(new StaticUsageAdapter('lambda', buildLambdaTrace()));

    setAgreementLink(store, 'agreement-diff-venice-lambda', 'venice', 'venice-key-diff-1');
    setAgreementLink(store, 'agreement-diff-bankr-lambda', 'bankr', 'bankr-key-diff-1');
    setAgreementLink(store, 'agreement-diff-lambda-1', 'lambda', 'lambda-instance-diff-1');

    const worker = new DeterministicMeteringWorker(store, registry);
    const to = '2026-03-14T10:00:00.000Z';

    const venice = await worker.runForAgreement('agreement-diff-venice-lambda', { to });
    const bankr = await worker.runForAgreement('agreement-diff-bankr-lambda', { to });
    const lambda = await worker.runForAgreement('agreement-diff-lambda-1', { to });

    expect(venice.status).toBe('prepared');
    expect(bankr.status).toBe('prepared');
    expect(lambda.status).toBe('prepared');
    expect(venice.usageRows).toBe(10);
    expect(bankr.usageRows).toBe(10);
    expect(lambda.usageRows).toBe(10);

    const venicePrincipalDrawn = computePrincipalDrawn(venice.aggregatedItems);
    const bankrPrincipalDrawn = computePrincipalDrawn(bankr.aggregatedItems);
    const lambdaPrincipalDrawn = computePrincipalDrawn(lambda.aggregatedItems);

    expect(venicePrincipalDrawn).toBe(lambdaPrincipalDrawn);
    expect(bankrPrincipalDrawn).toBe(lambdaPrincipalDrawn);
    expect(venicePrincipalDrawn - lambdaPrincipalDrawn).toBe(0n);
    expect(bankrPrincipalDrawn - lambdaPrincipalDrawn).toBe(0n);
  });

  it('12.2 API inference adapters (Venice + Bankr) match RunPod burst principalDrawn for same synthetic trace', async () => {
    const store = new InMemoryMessageStore();
    const registry = new ComputeAdapterRegistry();

    registry.register(new StaticUsageAdapter('venice', buildApiInferenceTrace('venice')));
    registry.register(new StaticUsageAdapter('bankr', buildApiInferenceTrace('bankr')));
    registry.register(new StaticUsageAdapter('runpod', buildRunPodBurstTrace()));

    setAgreementLink(store, 'agreement-diff-venice-runpod', 'venice', 'venice-key-diff-2');
    setAgreementLink(store, 'agreement-diff-bankr-runpod', 'bankr', 'bankr-key-diff-2');
    setAgreementLink(store, 'agreement-diff-runpod-burst-1', 'runpod', 'runpod-endpoint-diff-1');

    const worker = new DeterministicMeteringWorker(store, registry);
    const to = '2026-03-14T10:00:00.000Z';

    const venice = await worker.runForAgreement('agreement-diff-venice-runpod', { to });
    const bankr = await worker.runForAgreement('agreement-diff-bankr-runpod', { to });
    const runpod = await worker.runForAgreement('agreement-diff-runpod-burst-1', { to });

    expect(venice.status).toBe('prepared');
    expect(bankr.status).toBe('prepared');
    expect(runpod.status).toBe('prepared');
    expect(venice.usageRows).toBe(10);
    expect(bankr.usageRows).toBe(10);
    expect(runpod.usageRows).toBe(10);

    const venicePrincipalDrawn = computePrincipalDrawn(venice.aggregatedItems);
    const bankrPrincipalDrawn = computePrincipalDrawn(bankr.aggregatedItems);
    const runpodPrincipalDrawn = computePrincipalDrawn(runpod.aggregatedItems);

    expect(venicePrincipalDrawn).toBe(runpodPrincipalDrawn);
    expect(bankrPrincipalDrawn).toBe(runpodPrincipalDrawn);
    expect(venicePrincipalDrawn - runpodPrincipalDrawn).toBe(0n);
    expect(bankrPrincipalDrawn - runpodPrincipalDrawn).toBe(0n);
  });

  it('12.3 Lambda and RunPod match principalDrawn for same synthetic trace', async () => {
    const store = new InMemoryMessageStore();
    const registry = new ComputeAdapterRegistry();

    registry.register(new StaticUsageAdapter('lambda', buildLambdaTrace()));
    registry.register(new StaticUsageAdapter('runpod', buildRunPodBurstTrace()));

    setAgreementLink(store, 'agreement-diff-lambda-runpod', 'lambda', 'lambda-instance-diff-2');
    setAgreementLink(store, 'agreement-diff-runpod-lambda', 'runpod', 'runpod-endpoint-diff-2');

    const worker = new DeterministicMeteringWorker(store, registry);
    const to = '2026-03-14T10:00:00.000Z';

    const lambda = await worker.runForAgreement('agreement-diff-lambda-runpod', { to });
    const runpod = await worker.runForAgreement('agreement-diff-runpod-lambda', { to });

    expect(lambda.status).toBe('prepared');
    expect(runpod.status).toBe('prepared');
    expect(lambda.usageRows).toBe(10);
    expect(runpod.usageRows).toBe(10);

    const lambdaPrincipalDrawn = computePrincipalDrawn(lambda.aggregatedItems);
    const runpodPrincipalDrawn = computePrincipalDrawn(runpod.aggregatedItems);

    expect(lambdaPrincipalDrawn).toBe(runpodPrincipalDrawn);
    expect(lambdaPrincipalDrawn - runpodPrincipalDrawn).toBe(0n);
  });
});
