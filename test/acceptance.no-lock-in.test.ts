import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { InMemoryMessageStore, SQLiteMessageStore } from '../src/store';

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

const PROVIDERS: ComputeProvider[] = ['lambda', 'runpod', 'venice', 'bankr'];

const ROWS_BY_PROVIDER: Record<ComputeProvider, UsageResult['usage']> = {
  lambda: [{ unitType: 'GPU_HOUR_A100', amount: '1', observedAt: '2026-03-14T10:00:01.000Z', requestId: 'l-1' }],
  runpod: [
    { unitType: 'RUNPOD_INFERENCE_REQUEST', amount: '2', observedAt: '2026-03-14T10:00:02.000Z', requestId: 'r-1' },
    { unitType: 'RUNPOD_GPU_SEC', amount: '30', observedAt: '2026-03-14T10:00:03.000Z', requestId: 'r-2' },
  ],
  venice: [{ unitType: 'VENICE_TEXT_TOKEN_IN', amount: '10', observedAt: '2026-03-14T10:00:04.000Z', requestId: 'v-1' }],
  bankr: [{ unitType: 'BANKR_TEXT_TOKEN_OUT', amount: '5', observedAt: '2026-03-14T10:00:05.000Z', requestId: 'b-1' }],
};

function registerEnabledProviders(registry: ComputeAdapterRegistry, disabled: ComputeProvider): ComputeProvider[] {
  const enabled = PROVIDERS.filter((provider) => provider !== disabled);
  for (const provider of enabled) {
    registry.register(new StaticUsageAdapter(provider, ROWS_BY_PROVIDER[provider]));
  }
  return enabled;
}

function aggregateRows(rows: UsageResult['usage']): Array<{ unitType: string; amount: string }> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.unitType, (totals.get(row.unitType) ?? 0) + Number(row.amount));
  }
  return [...totals.entries()]
    .map(([unitType, amount]) => ({ unitType, amount: String(amount) }))
    .sort((a, b) => a.unitType.localeCompare(b.unitType));
}

async function runCoreIndependenceScenario(disabled: ComputeProvider): Promise<void> {
  const store = new InMemoryMessageStore();
  const registry = new ComputeAdapterRegistry();
  const enabled = registerEnabledProviders(registry, disabled);
  const worker = new DeterministicMeteringWorker(store, registry);

  for (const provider of enabled) {
    store.setProviderLink({
      agreementId: `agreement-no-lock-in-${provider}`,
      provider,
      providerResourceId: `${provider}-resource`,
      updatedAt: '2026-03-14T10:00:00.000Z',
    });
  }

  const run = await worker.runOnce({ to: '2026-03-14T11:00:00.000Z' });
  expect(run.agreementsScanned).toBe(3);
  expect(run.preparedCount).toBe(3);

  for (const provider of enabled) {
    const result = run.results.find((item) => item.provider === provider);
    expect(result?.status).toBe('prepared');
    expect(result?.aggregatedItems).toEqual(aggregateRows(ROWS_BY_PROVIDER[provider]));
  }
}

describe('No-lock-in acceptance tests', () => {
  it('13.1 disables Lambda and preserves Venice + Bankr + RunPod accounting correctness', async () => {
    await runCoreIndependenceScenario('lambda');
  });

  it('13.1 disables RunPod and preserves Venice + Bankr + Lambda accounting correctness', async () => {
    await runCoreIndependenceScenario('runpod');
  });

  it('13.1 disables Venice and preserves Bankr + Lambda + RunPod accounting correctness', async () => {
    await runCoreIndependenceScenario('venice');
  });

  it('13.1 disables Bankr and preserves Venice + Lambda + RunPod accounting correctness', async () => {
    await runCoreIndependenceScenario('bankr');
  });

  it('13.1 reconstructs canonical accounting state without provider-specific metadata', async () => {
    const store = new InMemoryMessageStore();
    const registry = new ComputeAdapterRegistry();
    registry.register(new StaticUsageAdapter('venice', ROWS_BY_PROVIDER.venice));
    registry.register(new StaticUsageAdapter('lambda', ROWS_BY_PROVIDER.lambda));
    const worker = new DeterministicMeteringWorker(store, registry);

    store.setProviderLink({
      agreementId: 'agreement-canonical-venice',
      provider: 'venice',
      providerResourceId: 'venice-key-private-metadata',
      updatedAt: '2026-03-14T10:00:00.000Z',
    });
    store.setProviderLink({
      agreementId: 'agreement-canonical-lambda',
      provider: 'lambda',
      providerResourceId: 'instance-private-metadata',
      updatedAt: '2026-03-14T10:00:00.000Z',
    });

    const run = await worker.runOnce({ to: '2026-03-14T11:00:00.000Z' });
    expect(run.preparedCount).toBe(2);

    const submissions = store.listUsageSubmissions(10);
    expect(submissions).toHaveLength(2);

    for (const submission of submissions) {
      expect(Object.keys(submission)).not.toContain('providerResourceId');
      expect(submission.items.length).toBeGreaterThan(0);
    }
  });

  it('13.2 verifies Phase 1 Diamond storage uses no provider-specific fields', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const agenticStoragePath = resolve(testDir, '../../EqualFi/src/libraries/LibAgenticStorage.sol');
    const content = readFileSync(agenticStoragePath, 'utf8');
    const structMatch = content.match(/struct AgenticStorage \{[\s\S]*?\n\}/);
    expect(structMatch).toBeTruthy();

    const structText = structMatch?.[0] ?? '';
    const forbiddenProviderSpecificFields = [
      'lambda',
      'runpod',
      'venice',
      'bankr',
      'apiKey',
      'instanceId',
      'endpointId',
      'sshKey',
    ];

    for (const token of forbiddenProviderSpecificFields) {
      expect(structText.toLowerCase()).not.toContain(token.toLowerCase());
    }
  });

  it('13.2 verifies SQLite provider_links schema is generic (provider + resource id)', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'relayer-no-lock-in-'));
    const dbPath = join(tempRoot, 'relayer.db');

    try {
      // Initializes schema.
      void new SQLiteMessageStore(dbPath);

      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare(`PRAGMA table_info('provider_links')`).all() as Array<{ name: string }>;
      const columnNames = rows.map((row) => row.name);

      expect(columnNames).toEqual(['agreement_id', 'provider', 'provider_resource_id', 'updated_at']);
      expect(columnNames.join(',').toLowerCase()).not.toContain('venice');
      expect(columnNames.join(',').toLowerCase()).not.toContain('bankr');
      expect(columnNames.join(',').toLowerCase()).not.toContain('runpod');
      expect(columnNames.join(',').toLowerCase()).not.toContain('lambda');

      db.close();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('13.2 verifies provider swap is a provider value change with no data migration', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'relayer-provider-swap-'));
    const dbPath = join(tempRoot, 'relayer.db');

    try {
      const store = new SQLiteMessageStore(dbPath);
      store.setProviderLink({
        agreementId: 'agreement-swap-1',
        provider: 'lambda',
        providerResourceId: 'lambda-resource-1',
        updatedAt: '2026-03-14T12:00:00.000Z',
      });

      store.setProviderLink({
        agreementId: 'agreement-swap-1',
        provider: 'runpod',
        providerResourceId: 'runpod-resource-1',
        updatedAt: '2026-03-14T12:01:00.000Z',
      });

      const links = store.listProviderLinks();
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({
        agreementId: 'agreement-swap-1',
        provider: 'runpod',
        providerResourceId: 'runpod-resource-1',
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
