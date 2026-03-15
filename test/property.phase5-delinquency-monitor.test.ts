import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Interface } from 'ethers';
import { DelinquencyMonitor } from '../src/schedulers/DelinquencyMonitor';

const AGREEMENT_IFACE = new Interface([
  'function getAgreementsByStatus(uint8 status) view returns (uint256[] agreementIds)',
]);

const RISK_IFACE = new Interface([
  'function detectDelinquency(uint256 agreementId)',
  'function triggerDefault(uint256 agreementId)',
]);

const AGREEMENT_ADDRESS = `0x${'11'.repeat(20)}`;
const RISK_ADDRESS = `0x${'22'.repeat(20)}`;

type TxOutcome = 'ok' | 'fatal' | 'expected';

function encodeAgreementIds(ids: bigint[]): string {
  return AGREEMENT_IFACE.encodeFunctionResult('getAgreementsByStatus', [ids]);
}

function decodeTxFunction(data: string): 'detectDelinquency' | 'triggerDefault' {
  const selector = data.slice(0, 10);
  if (selector === RISK_IFACE.getFunction('detectDelinquency')!.selector) {
    return 'detectDelinquency';
  }
  return 'triggerDefault';
}

describe('Phase 5 property-based tests (Delinquency Monitor)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('P5-26: failed transactions do not halt monitor liveness across cycles', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 25 }),
        fc.array(fc.constantFrom<TxOutcome>('ok', 'fatal', 'expected'), { minLength: 1, maxLength: 25 }),
        fc.array(fc.constantFrom<TxOutcome>('ok', 'fatal', 'expected'), { minLength: 1, maxLength: 25 }),
        async (cycles, detectOutcomeTemplate, defaultOutcomeTemplate) => {
          const provider = {
            call: async ({ data }: { data: string }) => {
              const decoded = AGREEMENT_IFACE.decodeFunctionData('getAgreementsByStatus', data);
              const status = Number(decoded.status);
              if (status === 0) return encodeAgreementIds([1n]);
              if (status === 2) return encodeAgreementIds([2n]);
              throw new Error('unexpected_status');
            },
          };

          let detectAttempts = 0;
          let defaultAttempts = 0;
          let fatalCount = 0;
          let onErrorCount = 0;

          const signer = {
            sendTransaction: async ({ data }: { data: string }) => {
              const fn = decodeTxFunction(data);
              if (fn === 'detectDelinquency') {
                const outcome = detectOutcomeTemplate[detectAttempts % detectOutcomeTemplate.length] ?? 'ok';
                detectAttempts += 1;
                if (outcome === 'fatal') {
                  fatalCount += 1;
                  throw new Error('rpc_timeout');
                }
                if (outcome === 'expected') {
                  throw new Error('NotDelinquent');
                }
              } else {
                const outcome = defaultOutcomeTemplate[defaultAttempts % defaultOutcomeTemplate.length] ?? 'ok';
                defaultAttempts += 1;
                if (outcome === 'fatal') {
                  fatalCount += 1;
                  throw new Error('network_error');
                }
                if (outcome === 'expected') {
                  throw new Error('CurePeriodNotExpired');
                }
              }

              return {
                hash: '0xtx',
                wait: async () => ({ status: 1 }),
              };
            },
          };

          const monitor = new DelinquencyMonitor(
            provider as never,
            signer as never,
            RISK_ADDRESS,
            AGREEMENT_ADDRESS,
            900_000,
            () => {
              onErrorCount += 1;
            }
          );

          for (let i = 0; i < cycles; i += 1) {
            await monitor.runCycle();
          }

          expect(detectAttempts).toBe(cycles);
          expect(defaultAttempts).toBe(cycles);
          expect(onErrorCount).toBe(fatalCount);
          expect(monitor.status().running).toBe(false);
        }
      ),
      { numRuns: 80 }
    );
  });

  it('P5-26: isRunning guard prevents concurrent cycle execution', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 20 }), async (concurrentCalls) => {
        let releaseFirstQuery: (() => void) | undefined;
        let providerCallCount = 0;

        const provider = {
          call: async ({ data }: { data: string }) => {
            providerCallCount += 1;
            const decoded = AGREEMENT_IFACE.decodeFunctionData('getAgreementsByStatus', data);
            const status = Number(decoded.status);
            if (status === 0) {
              await new Promise<void>((resolve) => {
                releaseFirstQuery = resolve;
              });
              return encodeAgreementIds([]);
            }
            if (status === 2) return encodeAgreementIds([]);
            throw new Error('unexpected_status');
          },
        };

        let sendCount = 0;
        const signer = {
          sendTransaction: async () => {
            sendCount += 1;
            return {
              hash: '0xtx',
              wait: async () => ({ status: 1 }),
            };
          },
        };

        const monitor = new DelinquencyMonitor(
          provider as never,
          signer as never,
          RISK_ADDRESS,
          AGREEMENT_ADDRESS,
          900_000,
          () => undefined
        );

        const runs = Array.from({ length: concurrentCalls }, async () => monitor.runCycle());
        await Promise.resolve();
        expect(monitor.status().running).toBe(true);

        releaseFirstQuery?.();
        await Promise.all(runs);

        expect(monitor.status().running).toBe(false);
        expect(sendCount).toBe(0);
        expect(providerCallCount).toBe(2);
      }),
      { numRuns: 60 }
    );
  });
});
