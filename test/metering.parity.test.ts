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

function computeDebtDelta(
  items: Array<{ unitType: string; amount: string }>,
  prices: Record<string, bigint>
): bigint {
  return items.reduce((sum, item) => {
    const price = prices[item.unitType];
    if (price === undefined) {
      throw new Error(`missing price for ${item.unitType}`);
    }
    return sum + BigInt(item.amount) * price;
  }, 0n);
}

describe('provider differential parity', () => {
  it('computes equivalent expected debt delta for synthetic venice vs bankr traces', async () => {
    const store = new InMemoryMessageStore();
    const registry = new ComputeAdapterRegistry();

    registry.register(
      new StaticUsageAdapter('venice', [
        { unitType: 'VENICE_TEXT_TOKEN_OUT', amount: '20', observedAt: '2026-03-11T00:00:02.000Z', requestId: 'v2' },
        { unitType: 'VENICE_TEXT_TOKEN_IN', amount: '70', observedAt: '2026-03-11T00:00:01.000Z', requestId: 'v1' },
        { unitType: 'VENICE_TEXT_TOKEN_IN', amount: '30', observedAt: '2026-03-11T00:00:03.000Z', requestId: 'v3' },
        { unitType: 'VENICE_TEXT_TOKEN_OUT', amount: '30', observedAt: '2026-03-11T00:00:04.000Z', requestId: 'v4' },
      ])
    );

    registry.register(
      new StaticUsageAdapter('bankr', [
        { unitType: 'BANKR_TEXT_TOKEN_OUT', amount: '20', observedAt: '2026-03-11T00:00:02.000Z', requestId: 'b2' },
        { unitType: 'BANKR_TEXT_TOKEN_IN', amount: '40', observedAt: '2026-03-11T00:00:01.000Z', requestId: 'b1' },
        { unitType: 'BANKR_TEXT_TOKEN_IN', amount: '10', observedAt: '2026-03-11T00:00:03.000Z', requestId: 'b3' },
        { unitType: 'BANKR_TEXT_TOKEN_OUT', amount: '5', observedAt: '2026-03-11T00:00:04.000Z', requestId: 'b4' },
      ])
    );

    store.setProviderLink({
      agreementId: 'agreement-parity-venice-1',
      provider: 'venice',
      providerResourceId: 'venice-key-1',
      updatedAt: '2026-03-11T00:00:00.000Z',
    });

    store.setProviderLink({
      agreementId: 'agreement-parity-bankr-1',
      provider: 'bankr',
      providerResourceId: 'bankr-key-1',
      updatedAt: '2026-03-11T00:00:00.000Z',
    });

    const worker = new DeterministicMeteringWorker(store, registry);

    const venice = await worker.runForAgreement('agreement-parity-venice-1', { to: '2026-03-11T00:01:00.000Z' });
    const bankr = await worker.runForAgreement('agreement-parity-bankr-1', { to: '2026-03-11T00:01:00.000Z' });

    expect(venice.status).toBe('prepared');
    expect(bankr.status).toBe('prepared');
    expect(venice.aggregatedItems).toEqual([
      { unitType: 'VENICE_TEXT_TOKEN_IN', amount: '100' },
      { unitType: 'VENICE_TEXT_TOKEN_OUT', amount: '50' },
    ]);
    expect(bankr.aggregatedItems).toEqual([
      { unitType: 'BANKR_TEXT_TOKEN_IN', amount: '50' },
      { unitType: 'BANKR_TEXT_TOKEN_OUT', amount: '25' },
    ]);

    const prices: Record<string, bigint> = {
      VENICE_TEXT_TOKEN_IN: 2n,
      VENICE_TEXT_TOKEN_OUT: 3n,
      BANKR_TEXT_TOKEN_IN: 5n,
      BANKR_TEXT_TOKEN_OUT: 4n,
    };

    const veniceDelta = computeDebtDelta(venice.aggregatedItems, prices);
    const bankrDelta = computeDebtDelta(bankr.aggregatedItems, prices);

    expect(veniceDelta).toBe(350n);
    expect(bankrDelta).toBe(350n);
    expect(veniceDelta).toBe(bankrDelta);
  });

  it('does not impact venice metering when bankr adapter is disabled', async () => {
    const store = new InMemoryMessageStore();
    const registry = new ComputeAdapterRegistry();
    registry.register(
      new StaticUsageAdapter('venice', [
        { unitType: 'VENICE_TEXT_TOKEN_IN', amount: '10', observedAt: '2026-03-11T01:00:01.000Z', requestId: 'v1' },
      ])
    );

    store.setProviderLink({
      agreementId: 'agreement-disable-bankr-venice-1',
      provider: 'venice',
      providerResourceId: 'venice-key-1',
      updatedAt: '2026-03-11T01:00:00.000Z',
    });

    store.setProviderLink({
      agreementId: 'agreement-disable-bankr-bankr-1',
      provider: 'bankr',
      providerResourceId: 'bankr-key-1',
      updatedAt: '2026-03-11T01:00:00.000Z',
    });

    const worker = new DeterministicMeteringWorker(store, registry);

    const venice = await worker.runForAgreement('agreement-disable-bankr-venice-1', { to: '2026-03-11T01:01:00.000Z' });
    const bankr = await worker.runForAgreement('agreement-disable-bankr-bankr-1', { to: '2026-03-11T01:01:00.000Z' });

    expect(venice.status).toBe('prepared');
    expect(venice.provider).toBe('venice');
    expect(bankr.status).toBe('error');
    expect(bankr.message).toBe('provider_not_supported');
  });

  it('does not impact bankr metering when venice adapter is disabled', async () => {
    const store = new InMemoryMessageStore();
    const registry = new ComputeAdapterRegistry();
    registry.register(
      new StaticUsageAdapter('bankr', [
        { unitType: 'BANKR_TEXT_TOKEN_IN', amount: '7', observedAt: '2026-03-11T02:00:01.000Z', requestId: 'b1' },
      ])
    );

    store.setProviderLink({
      agreementId: 'agreement-disable-venice-bankr-1',
      provider: 'bankr',
      providerResourceId: 'bankr-key-1',
      updatedAt: '2026-03-11T02:00:00.000Z',
    });

    store.setProviderLink({
      agreementId: 'agreement-disable-venice-venice-1',
      provider: 'venice',
      providerResourceId: 'venice-key-1',
      updatedAt: '2026-03-11T02:00:00.000Z',
    });

    const worker = new DeterministicMeteringWorker(store, registry);

    const bankr = await worker.runForAgreement('agreement-disable-venice-bankr-1', { to: '2026-03-11T02:01:00.000Z' });
    const venice = await worker.runForAgreement('agreement-disable-venice-venice-1', { to: '2026-03-11T02:01:00.000Z' });

    expect(bankr.status).toBe('prepared');
    expect(bankr.provider).toBe('bankr');
    expect(venice.status).toBe('error');
    expect(venice.message).toBe('provider_not_supported');
  });
});
