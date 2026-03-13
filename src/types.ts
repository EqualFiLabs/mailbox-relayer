export type MessageStatus = 'queued' | 'delivered';

export interface MailboxCipherPayload {
  iv: string;
  ephemPublicKey: string;
  ciphertext: string;
  mac: string;
}

export interface CanonicalMailboxEnvelope {
  version: 'equalfi.mailbox.ecies.eth-crypto.v1';
  recipient: string;
  cipher: MailboxCipherPayload;
  createdAt: string;
  expiresAt?: string;
  traceId?: string;
}

export interface StoredMessage {
  id: string;
  envelope: CanonicalMailboxEnvelope;
  status: MessageStatus;
  deliveredAt?: string;
  ack?: {
    provider?: string;
    meta?: Record<string, unknown>;
    at: string;
  };
}
