import EthCrypto from 'eth-crypto';
import { MailboxCipherPayload } from './types';

interface KeyPair {
  privateKey: string;
  publicKey: string;
  compressedPublicKey: string;
}

export class MailboxCompat {
  static generateKeys(): KeyPair {
    const identity = EthCrypto.createIdentity();

    return {
      privateKey: identity.privateKey,
      publicKey: `0x${identity.publicKey}`,
      compressedPublicKey: `0x${EthCrypto.publicKey.compress(identity.publicKey)}`,
    };
  }

  static async encryptPayload(receiverPubKeyHex: string, payload: string | object): Promise<string> {
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const normalizedPubKey = MailboxCompat.normalizePublicKey(receiverPubKeyHex);

    const encrypted = await EthCrypto.encryptWithPublicKey(normalizedPubKey, payloadStr);
    return EthCrypto.cipher.stringify(encrypted);
  }

  static async decryptPayload(privateKeyHex: string, encryptedPayloadString: string): Promise<string> {
    const encryptedObject = MailboxCompat.parseEnvelope(encryptedPayloadString);
    return EthCrypto.decryptWithPrivateKey(privateKeyHex, encryptedObject);
  }

  static parseEnvelope(encryptedPayloadString: string): MailboxCipherPayload {
    try {
      const parsed = EthCrypto.cipher.parse(encryptedPayloadString) as MailboxCipherPayload;

      if (!parsed.iv || !parsed.ephemPublicKey || !parsed.ciphertext || !parsed.mac) {
        throw new Error('Missing required envelope fields.');
      }

      return parsed;
    } catch {
      throw new Error('Invalid encrypted payload format. Expected eth-crypto stringified envelope.');
    }
  }

  private static normalizePublicKey(pubKeyHex: string): string {
    const cleanKey = pubKeyHex.startsWith('0x') ? pubKeyHex.slice(2) : pubKeyHex;

    if (cleanKey.length === 66) {
      return EthCrypto.publicKey.decompress(cleanKey);
    }

    if (cleanKey.length === 128) {
      return cleanKey;
    }

    if (cleanKey.length === 130 && cleanKey.startsWith('04')) {
      return cleanKey.slice(2);
    }

    throw new Error('Invalid public key format. Expected compressed or uncompressed secp256k1 public key.');
  }
}
