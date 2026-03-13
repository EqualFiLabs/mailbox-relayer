export type MessageStatus = 'queued' | 'delivered';

export interface StoredMessage {
  id: string;
  recipient: string;
  payload: string;
  traceId?: string;
  createdAt: string;
  expiresAt?: string;
  status: MessageStatus;
  deliveredAt?: string;
  ack?: {
    provider?: string;
    meta?: Record<string, unknown>;
    at: string;
  };
}
