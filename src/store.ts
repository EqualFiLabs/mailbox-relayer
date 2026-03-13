import { StoredMessage } from './types';

export class InMemoryMessageStore {
  private readonly messages = new Map<string, StoredMessage>();

  save(message: StoredMessage): StoredMessage {
    this.messages.set(message.id, message);
    return message;
  }

  get(id: string): StoredMessage | undefined {
    return this.messages.get(id);
  }

  update(id: string, updater: (existing: StoredMessage) => StoredMessage): StoredMessage | undefined {
    const existing = this.messages.get(id);
    if (!existing) return undefined;
    const next = updater(existing);
    this.messages.set(id, next);
    return next;
  }
}
