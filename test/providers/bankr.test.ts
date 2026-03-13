import { describe, expect, it } from 'vitest';
import { BankrComputeAdapter } from '../../src/providers/bankr';

type MockResponseInit = {
  ok: boolean;
  status: number;
  json: unknown;
};

function makeResponse(init: MockResponseInit): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: async () => init.json,
  } as unknown as Response;
}

describe('BankrComputeAdapter', () => {
  it('returns config error when no key sources are configured', async () => {
    const adapter = new BankrComputeAdapter({ apiKey: '', keyPool: [] });
    const result = await adapter.provision({ agreementId: 'agreement-1' });

    expect(result.status).toBe('error');
    expect(result.message).toMatch(/requires BANKR_LLM_KEY|key pool/i);
  });

  it('assigns one key per agreement and rejects pool exhaustion', async () => {
    const adapter = new BankrComputeAdapter({
      keyPool: [
        { id: 'pool-1', apiKey: 'bankr-key-1' },
        { id: 'pool-2', apiKey: 'bankr-key-2' },
      ],
    });

    const first = await adapter.provision({ agreementId: 'agreement-1' });
    expect(first.status).toBe('ok');
    expect(first.providerResourceId).toBe('pool-1');

    const firstAgain = await adapter.provision({ agreementId: 'agreement-1' });
    expect(firstAgain.status).toBe('ok');
    expect(firstAgain.providerResourceId).toBe('pool-1');

    const second = await adapter.provision({ agreementId: 'agreement-2' });
    expect(second.status).toBe('ok');
    expect(second.providerResourceId).toBe('pool-2');

    const third = await adapter.provision({ agreementId: 'agreement-3' });
    expect(third.status).toBe('error');
    expect(third.message).toMatch(/no unassigned/i);
  });

  it('releases assignment on terminate and allows reassignment', async () => {
    const adapter = new BankrComputeAdapter({
      keyPool: [{ id: 'pool-1', apiKey: 'bankr-key-1' }],
    });

    const first = await adapter.provision({ agreementId: 'agreement-1' });
    expect(first.status).toBe('ok');
    expect(first.providerResourceId).toBe('pool-1');

    const terminated = await adapter.terminate({
      agreementId: 'agreement-1',
      providerResourceId: 'pool-1',
      reason: 'breach',
    });
    expect(terminated.status).toBe('ok');
    expect(terminated.terminated).toBe(true);
    expect(terminated.meta?.softKill).toBe(true);
    expect(terminated.meta?.hardRevokeFollowUpRequired).toBe(true);

    const second = await adapter.provision({ agreementId: 'agreement-2' });
    expect(second.status).toBe('ok');
    expect(second.providerResourceId).toBe('pool-1');
  });

  it('normalizes Bankr usage rows into canonical provider-prefixed unit types', async () => {
    const mockFetch: typeof fetch = async () =>
      makeResponse({
        ok: true,
        status: 200,
        json: {
          data: [
            { metric: 'prompt_tokens', amount: '120', timestamp: '2026-03-10T20:00:00.000Z', requestId: 'r-1' },
            { metric: 'completion_tokens', amount: 45, timestamp: '2026-03-10T20:01:00.000Z', requestId: 'r-2' },
          ],
        },
      });

    const adapter = new BankrComputeAdapter({
      apiKey: 'bankr-admin-key',
      fetchFn: mockFetch,
    });

    const result = await adapter.usage({ agreementId: 'agreement-1', providerResourceId: 'pool-1' });
    expect(result.status).toBe('ok');
    expect(result.usage).toHaveLength(2);
    expect(result.usage[0]).toMatchObject({ unitType: 'BANKR_TEXT_TOKEN_IN', amount: '120' });
    expect(result.usage[1]).toMatchObject({ unitType: 'BANKR_TEXT_TOKEN_OUT', amount: '45' });
  });

  it('quarantines invalid/unmappable Bankr usage rows', async () => {
    const mockFetch: typeof fetch = async () =>
      makeResponse({
        ok: true,
        status: 200,
        json: {
          data: [
            { metric: 'unknown_metric', amount: '1', timestamp: '2026-03-10T20:00:00.000Z' },
            { metric: 'prompt_tokens', amount: 'nan', timestamp: '2026-03-10T20:01:00.000Z' },
          ],
        },
      });

    const adapter = new BankrComputeAdapter({
      apiKey: 'bankr-admin-key',
      fetchFn: mockFetch,
    });

    const result = await adapter.usage({ agreementId: 'agreement-1' });
    expect(result.status).toBe('error');
    expect(result.usage).toHaveLength(0);
    expect(result.message).toMatch(/quarantined/i);
    expect(result.meta?.quarantinedCount).toBe(2);
  });
});
