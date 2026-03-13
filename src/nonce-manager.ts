import { Mutex } from 'async-mutex';
import { JsonRpcProvider, getAddress, isAddress } from 'ethers';

export class NonceManager {
  private readonly mutex = new Mutex();
  private localNonce?: number;

  constructor(
    private readonly provider: JsonRpcProvider,
    private readonly walletAddress: string
  ) {
    if (!isAddress(walletAddress)) {
      throw new Error('invalid_wallet_address');
    }
  }

  async init(): Promise<void> {
    const nonce = await this.provider.getTransactionCount(this.walletAddress, 'pending');
    this.localNonce = nonce;
  }

  async acquireNonce(): Promise<number> {
    return this.mutex.runExclusive(async () => {
      const current = this.requireInitializedNonce();
      this.localNonce = current + 1;
      return current;
    });
  }

  confirmNonce(_nonce: number): void {
    // No-op by design: nonce is already incremented in acquireNonce().
  }

  async resync(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const nonce = await this.provider.getTransactionCount(this.walletAddress, 'pending');
      this.localNonce = nonce;
    });
  }

  currentNonce(): number {
    return this.requireInitializedNonce();
  }

  private requireInitializedNonce(): number {
    if (this.localNonce === undefined) {
      throw new Error('nonce_manager_not_initialized');
    }
    return this.localNonce;
  }

  get normalizedWalletAddress(): string {
    return getAddress(this.walletAddress);
  }
}
