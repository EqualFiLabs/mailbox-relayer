import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  agreementIdToUint256,
  scaleAmountToUint256,
  uint256ToAgreementId,
  uint256ToDecimalAmount,
} from '../src/conversion';
import { compareByBlockAndLogIndex, sortByBlockAndLogIndex } from '../src/event-listener';
import { DeterministicMeteringWorker } from '../src/metering';
import { NonceManager } from '../src/nonce-manager';
import { ComputeAdapterRegistry } from '../src/providers/registry';
import {
  ComputeProviderAdapter,
  ProvisionRequest,
  ProvisionResult,
  TerminateRequest,
  TerminateResult,
  UsageRequest,
  UsageResult,
} from '../src/providers/types';
import { InMemoryMessageStore } from '../src/store';

const UINT256_MAX = (1n << 256n) - 1n;

class StaticBankrUsageAdapter implements ComputeProviderAdapter {
  readonly provider = 'bankr' as const;

  constructor(private readonly rows: UsageResult['usage']) {}

  async provision(_request: ProvisionRequest): Promise<ProvisionResult> {
    return { status: 'ok', provider: this.provider, providerResourceId: 'bankr-resource' };
  }

  async usage(_request: UsageRequest): Promise<UsageResult> {
    return { status: 'ok', provider: this.provider, usage: this.rows };
  }

  async terminate(_request: TerminateRequest): Promise<TerminateResult> {
    return { status: 'ok', provider: this.provider, terminated: true };
  }
}

describe('Phase 2 property-based tests', () => {
  it('Property 8: Agreement ID encoding round-trip', async () => {
    await fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: UINT256_MAX }), (n) => {
        expect(agreementIdToUint256(uint256ToAgreementId(n))).toBe(n);
      }),
      { numRuns: 200 }
    );

    await fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: UINT256_MAX }), (n) => {
        const s = n.toString(10);
        expect(uint256ToAgreementId(agreementIdToUint256(s))).toBe(s);
      }),
      { numRuns: 200 }
    );

    expect(() => agreementIdToUint256('-1')).toThrowError('invalid_agreement_id');
    expect(() => agreementIdToUint256('abc')).toThrowError('invalid_agreement_id');
    expect(() => agreementIdToUint256('1.5')).toThrowError('invalid_agreement_id');
    expect(() => agreementIdToUint256('')).toThrowError('invalid_agreement_id');
  });

  it('Property 9: Usage amount scaling round-trip', async () => {
    const canonicalPositiveDecimal = fc
      .bigInt({ min: 1n, max: UINT256_MAX })
      .map((scaled) => uint256ToDecimalAmount(scaled));

    await fc.assert(
      fc.property(canonicalPositiveDecimal, (decimalAmount) => {
        expect(uint256ToDecimalAmount(scaleAmountToUint256(decimalAmount))).toBe(decimalAmount);
      }),
      { numRuns: 200 }
    );

    await fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: UINT256_MAX }), (scaled) => {
        expect(scaleAmountToUint256(uint256ToDecimalAmount(scaled))).toBe(scaled);
      }),
      { numRuns: 200 }
    );

    expect(scaleAmountToUint256('0.000000000000000001')).toBe(1n);
    expect(scaleAmountToUint256(uint256ToDecimalAmount(UINT256_MAX))).toBe(UINT256_MAX);
    expect(scaleAmountToUint256(uint256ToDecimalAmount(UINT256_MAX - 1n))).toBe(UINT256_MAX - 1n);

    expect(() => scaleAmountToUint256('0')).toThrowError('invalid_amount');
    expect(() => scaleAmountToUint256('-1')).toThrowError('invalid_amount');
    expect(() => scaleAmountToUint256((UINT256_MAX + 1n).toString(10))).toThrowError('amount_overflow');
  });

  it('Property 18: Event delivery ordering', async () => {
    const pairArb = fc.uniqueArray(
      fc.record({
        blockNumber: fc.integer({ min: 0, max: 1_000_000 }),
        logIndex: fc.integer({ min: 0, max: 100_000 }),
      }),
      {
        minLength: 1,
        maxLength: 400,
        selector: (v) => `${v.blockNumber}:${v.logIndex}`,
      }
    );

    await fc.assert(
      fc.property(pairArb, (pairs) => {
        const sorted = sortByBlockAndLogIndex(pairs);
        for (let i = 1; i < sorted.length; i += 1) {
          expect(compareByBlockAndLogIndex(sorted[i - 1], sorted[i])).toBeLessThan(0);
        }

        const inputSet = new Set(pairs.map((p) => `${p.blockNumber}:${p.logIndex}`));
        const outputSet = new Set(sorted.map((p) => `${p.blockNumber}:${p.logIndex}`));
        expect(outputSet).toEqual(inputSet);
      }),
      { numRuns: 150 }
    );
  });

  it('Property 13: Nonce monotonicity', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20_000 }),
        fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 30 }),
        async (startingNonce, concurrencyBatches) => {
          const provider = {
            getTransactionCount: async () => startingNonce,
          } as any;

          const manager = new NonceManager(provider, '0x1111111111111111111111111111111111111111');
          await manager.init();

          const allocated: number[] = [];
          for (const batchSize of concurrencyBatches) {
            const batch = await Promise.all(
              Array.from({ length: batchSize }, async () => manager.acquireNonce())
            );
            allocated.push(...batch);
          }

          const sorted = [...allocated].sort((a, b) => a - b);
          const expected = Array.from({ length: allocated.length }, (_, i) => startingNonce + i);

          expect(sorted).toEqual(expected);
          expect(new Set(allocated).size).toBe(allocated.length);
          expect(manager.currentNonce()).toBe(startingNonce + allocated.length);
        }
      ),
      { numRuns: 80 }
    );
  });

  it('Property 26: Provider callback dedup and metering consumption', async () => {
    const inputArb = fc.array(
      fc.record({
        externalEventId: fc.integer({ min: 0, max: 14 }).map((n) => `evt-${n}`),
        amount: fc.integer({ min: 1, max: 9 }),
        observedOffsetSec: fc.integer({ min: 0, max: 3_600 }),
      }),
      { minLength: 1, maxLength: 80 }
    );

    await fc.assert(
      fc.asyncProperty(inputArb, async (events) => {
        const store = new InMemoryMessageStore();
        const provider = 'bankr';
        const providerResourceId = 'bankr-resource-1';
        const baseMs = Date.parse('2026-03-11T00:00:00.000Z');

        let insertedCount = 0;
        const firstAmountById = new Map<string, number>();

        events.forEach((event, index) => {
          const observedAt = new Date(baseMs + event.observedOffsetSec * 1000).toISOString();
          const createdAt = new Date(baseMs + event.observedOffsetSec * 1000 + index + 1).toISOString();

          const inserted = store.upsertProviderEvent({
            provider,
            providerResourceId,
            externalEventId: event.externalEventId,
            payloadJson: JSON.stringify({
              usage: [
                {
                  unitType: 'BANKR_TEXT_TOKEN_IN',
                  amount: String(event.amount),
                  observedAt,
                  requestId: event.externalEventId,
                },
              ],
            }),
            observedAt,
            createdAt,
          });

          if (inserted) {
            insertedCount += 1;
            firstAmountById.set(event.externalEventId, event.amount);
          }
        });

        const expectedUniqueKeys = new Set(events.map((event) => `${provider}:${providerResourceId}:${event.externalEventId}`)).size;
        expect(insertedCount).toBe(expectedUniqueKeys);

        const persisted = store.listProviderEvents(provider, providerResourceId);
        expect(persisted).toHaveLength(expectedUniqueKeys);

        const adapterRows = persisted.map((row) => ({
          unitType: 'BANKR_TEXT_TOKEN_IN',
          amount: '999',
          observedAt: row.observedAt,
          requestId: row.externalEventId,
        }));

        const registry = new ComputeAdapterRegistry();
        registry.register(new StaticBankrUsageAdapter(adapterRows));

        store.setProviderLink({
          agreementId: 'agreement-prop-26',
          provider,
          providerResourceId,
          updatedAt: '2026-03-11T00:00:00.000Z',
        });

        const worker = new DeterministicMeteringWorker(store, registry);
        const result = await worker.runForAgreement('agreement-prop-26', {
          to: new Date(baseMs + 7_200_000).toISOString(),
        });

        const expectedTotal = [...firstAmountById.values()].reduce((sum, value) => sum + value, 0);
        expect(result.status).toBe('prepared');
        expect(result.usageRows).toBe(expectedUniqueKeys);
        expect(result.aggregatedItems).toEqual([
          { unitType: 'BANKR_TEXT_TOKEN_IN', amount: String(expectedTotal) },
        ]);
      }),
      { numRuns: 60 }
    );
  });
});
