import { describe, expect, it } from 'vitest';
import { JsonRpcProvider } from 'ethers';
import { NonceManager } from '../src/nonce-manager';

function makeMockProvider(nonceRef: { value: number }) {
  const calls: Array<{ address: string; blockTag: string }> = [];
  const provider = {
    async getTransactionCount(address: string, blockTag: string) {
      calls.push({ address, blockTag });
      return nonceRef.value;
    },
  } as unknown as JsonRpcProvider;

  return { provider, calls };
}

describe('NonceManager', () => {
  const walletAddress = '0x1111111111111111111111111111111111111111';

  it('init() fetches nonce from provider pending count', async () => {
    const nonceRef = { value: 7 };
    const { provider, calls } = makeMockProvider(nonceRef);
    const manager = new NonceManager(provider, walletAddress);

    await manager.init();

    expect(manager.currentNonce()).toBe(7);
    expect(calls).toEqual([
      { address: walletAddress, blockTag: 'pending' },
      { address: walletAddress, blockTag: 'latest' },
    ]);
  });

  it('sequential acquireNonce() calls return monotonically increasing nonces', async () => {
    const nonceRef = { value: 10 };
    const { provider } = makeMockProvider(nonceRef);
    const manager = new NonceManager(provider, walletAddress);
    await manager.init();

    const first = await manager.acquireNonce();
    const second = await manager.acquireNonce();
    const third = await manager.acquireNonce();

    expect([first, second, third]).toEqual([10, 11, 12]);
    expect(manager.currentNonce()).toBe(13);
  });

  it('resync() updates local nonce from provider', async () => {
    const nonceRef = { value: 3 };
    const { provider } = makeMockProvider(nonceRef);
    const manager = new NonceManager(provider, walletAddress);
    await manager.init();

    await manager.acquireNonce();
    await manager.acquireNonce();
    expect(manager.currentNonce()).toBe(5);

    nonceRef.value = 20;
    await manager.resync();

    expect(manager.currentNonce()).toBe(20);
  });

  it('init() and resync() prefer latest nonce when pending lags', async () => {
    const calls: Array<{ address: string; blockTag: string }> = [];
    let pending = 0;
    let latest = 3;
    const provider = {
      async getTransactionCount(address: string, blockTag: string) {
        calls.push({ address, blockTag });
        return blockTag === 'pending' ? pending : latest;
      },
    } as unknown as JsonRpcProvider;

    const manager = new NonceManager(provider, walletAddress);
    await manager.init();
    expect(manager.currentNonce()).toBe(3);

    pending = 1;
    latest = 9;
    await manager.resync();
    expect(manager.currentNonce()).toBe(9);
    expect(calls).toEqual([
      { address: walletAddress, blockTag: 'pending' },
      { address: walletAddress, blockTag: 'latest' },
      { address: walletAddress, blockTag: 'pending' },
      { address: walletAddress, blockTag: 'latest' },
    ]);
  });

  it('concurrent acquireNonce() calls are serialized with no duplicates', async () => {
    const nonceRef = { value: 100 };
    const { provider } = makeMockProvider(nonceRef);
    const manager = new NonceManager(provider, walletAddress);
    await manager.init();

    const allocated = await Promise.all([
      manager.acquireNonce(),
      manager.acquireNonce(),
      manager.acquireNonce(),
      manager.acquireNonce(),
      manager.acquireNonce(),
    ]);

    const sorted = [...allocated].sort((a, b) => a - b);
    expect(sorted).toEqual([100, 101, 102, 103, 104]);
    expect(new Set(allocated).size).toBe(allocated.length);
    expect(manager.currentNonce()).toBe(105);
  });
});
