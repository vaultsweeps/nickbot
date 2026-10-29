import { randomUUID } from 'node:crypto';
import type {
  ClaimResult,
  Conversation,
  ConversationStatus,
  Customer,
  CustomerProfile,
  Mapping,
  MessagePatch,
  MessageRecord,
  NewMapping,
  NewMessage,
  Store,
  StoredUpdate,
} from '../../src/database/store';
import { RetryableError } from '../../src/utils/errors';

interface UpdateRow {
  updateId: string;
  payload: unknown;
  status: 'processing' | 'processed' | 'failed' | 'dead';
  attempt: number;
  lockedAt: number | null;
  nextAttemptAt: number | null;
  lastError: string | null;
}

/** In-memory Store mirroring the SQL constraints/functions (see supabase/migrations). */
export class MemoryStore implements Store {
  customers: Customer[] = [];
  conversations: (Conversation & { topicCreatingAt: number | null; closedAt: string | null })[] = [];
  messages: (MessageRecord & {
    raw: NewMessage;
    errorMessage: string | null;
    deliveredAt: string | null;
    threadId: string | null;
  })[] = [];
  mappings: Mapping[] = [];
  updates = new Map<string, UpdateRow>();
  private ticket = 1000;
  /** Set to make every call fail like a Supabase outage. */
  down = false;
  clock = () => Date.now();

  private guard() {
    if (this.down) throw new RetryableError('database unavailable');
  }

  async upsertCustomer(p: CustomerProfile) {
    this.guard();
    let c = this.customers.find((x) => x.telegramUserId === p.telegramUserId);
    if (!c) {
      c = {
        id: randomUUID(),
        telegramUserId: p.telegramUserId,
        username: null,
        firstName: null,
        lastName: null,
        phoneNumber: null,
        phoneVerifiedAt: null,
      };
      this.customers.push(c);
    }
    Object.assign(c, { username: p.username, firstName: p.firstName, lastName: p.lastName });
    return { ...c };
  }

  async setCustomerPhone(customerId: string, phone: string, verifiedAt: string) {
    this.guard();
    const c = this.customers.find((x) => x.id === customerId)!;
    Object.assign(c, { phoneNumber: phone, phoneVerifiedAt: verifiedAt });
    return { ...c };
  }

  async getCustomer(id: string) {
    this.guard();
    const c = this.customers.find((x) => x.id === id);
    return c ? { ...c } : null;
  }

  async ensureConversation(customerId: string, staffGroupId: string) {
    this.guard();
    const mine = this.conversations.filter((c) => c.customerId === customerId);
    let conv = mine[mine.length - 1];
    let created = false;
    let reopened = false;
    if (!conv) {
      conv = {
        id: randomUUID(),
        ticketNumber: this.ticket++,
        customerId,
        status: 'open',
        staffGroupId,
        forumTopicId: null,
        topicName: null,
        assignedStaffTelegramId: null,
        topicCreatingAt: null,
        closedAt: null,
      };
      this.conversations.push(conv);
      created = true;
    } else {
      if (conv.status === 'closed') {
        conv.status = 'open';
        conv.closedAt = null;
        reopened = true;
      }
      if (conv.staffGroupId !== staffGroupId)
        Object.assign(conv, { staffGroupId, forumTopicId: null, topicName: null, topicCreatingAt: null });
    }
    return { conversation: { ...conv }, created, reopened };
  }

  async getConversation(id: string) {
    this.guard();
    const c = this.conversations.find((x) => x.id === id);
    return c ? { ...c } : null;
  }

  async getLatestConversationForCustomer(customerId: string) {
    this.guard();
    const mine = this.conversations.filter((c) => c.customerId === customerId);
    const c = mine[mine.length - 1];
    return c ? { ...c } : null;
  }

  async findConversationByTopic(staffGroupId: string, topicId: string) {
    this.guard();
    const c = this.conversations.find((x) => x.staffGroupId === staffGroupId && x.forumTopicId === topicId);
    return c ? { ...c } : null;
  }

  async claimTopicCreation(conversationId: string, lockSeconds: number) {
    this.guard();
    const c = this.conversations.find((x) => x.id === conversationId)!;
    if (c.forumTopicId || (c.topicCreatingAt && c.topicCreatingAt > this.clock() - lockSeconds * 1000))
      return false;
    c.topicCreatingAt = this.clock();
    return true;
  }

  async setTopic(conversationId: string, topicId: string | null, topicName: string | null) {
    this.guard();
    const c = this.conversations.find((x) => x.id === conversationId)!;
    if (
      topicId &&
      this.conversations.some(
        (x) => x.id !== c.id && x.staffGroupId === c.staffGroupId && x.forumTopicId === topicId,
      )
    ) {
      throw new Error('unique violation: topic already belongs to another conversation');
    }
    Object.assign(c, { forumTopicId: topicId, topicName, topicCreatingAt: null });
    return { ...c };
  }

  async setConversationStatus(conversationId: string, status: ConversationStatus) {
    this.guard();
    const c = this.conversations.find((x) => x.id === conversationId)!;
    c.status = status;
    return { ...c };
  }

  async insertMessage(m: NewMessage) {
    this.guard();
    const existing = this.messages.find(
      (x) => x.telegramChatId === m.telegramChatId && x.telegramMessageId === m.telegramMessageId,
    );
    if (existing) return { message: { ...existing }, inserted: false };
    const row = {
      id: randomUUID(),
      conversationId: m.conversationId,
      customerId: m.customerId,
      senderType: m.senderType,
      telegramChatId: m.telegramChatId,
      telegramMessageId: m.telegramMessageId,
      deliveryStatus: m.deliveryStatus,
      raw: m,
      errorMessage: null,
      deliveredAt: null,
      threadId: m.messageThreadId,
    };
    this.messages.push(row);
    return { message: { ...row }, inserted: true };
  }

  async updateMessage(id: string, patch: MessagePatch) {
    this.guard();
    const row = this.messages.find((x) => x.id === id)!;
    if (patch.deliveryStatus !== undefined) row.deliveryStatus = patch.deliveryStatus;
    if (patch.errorMessage !== undefined) row.errorMessage = patch.errorMessage;
    if (patch.deliveredAt !== undefined) row.deliveredAt = patch.deliveredAt;
    if (patch.messageThreadId !== undefined) row.threadId = patch.messageThreadId;
  }

  async createMapping(m: NewMapping) {
    this.guard();
    if (this.mappings.some((x) => x.staffGroupId === m.staffGroupId && x.staffMessageId === m.staffMessageId))
      return;
    this.mappings.push({ ...m, id: randomUUID() });
  }

  async findMappingByStaffMessage(staffGroupId: string, staffMessageId: string) {
    this.guard();
    return (
      this.mappings.find((x) => x.staffGroupId === staffGroupId && x.staffMessageId === staffMessageId) ??
      null
    );
  }

  async claimUpdate(
    updateId: string,
    payload: unknown,
    opts: { lockSeconds?: number; maxAttempts?: number } = {},
  ): Promise<ClaimResult> {
    this.guard();
    const lock = (opts.lockSeconds ?? 120) * 1000;
    const max = opts.maxAttempts ?? 8;
    const r = this.updates.get(updateId);
    if (!r) {
      this.updates.set(updateId, {
        updateId,
        payload,
        status: 'processing',
        attempt: 1,
        lockedAt: this.clock(),
        nextAttemptAt: null,
        lastError: null,
      });
      return { result: 'claimed', attempt: 1 };
    }
    if (r.status === 'processed') return { result: 'duplicate', attempt: r.attempt };
    if (r.status === 'dead') return { result: 'dead', attempt: r.attempt };
    if (r.status === 'processing' && r.lockedAt! > this.clock() - lock)
      return { result: 'in_progress', attempt: r.attempt };
    if (r.attempt >= max) {
      r.status = 'dead';
      return { result: 'dead', attempt: r.attempt };
    }
    r.status = 'processing';
    r.attempt++;
    r.lockedAt = this.clock();
    return { result: 'claimed', attempt: r.attempt };
  }

  async completeUpdate(updateId: string) {
    this.guard();
    const r = this.updates.get(updateId)!;
    Object.assign(r, { status: 'processed', lockedAt: null, lastError: null });
  }

  async failUpdate(updateId: string, error: string, nextAttemptAt: Date, dead: boolean) {
    this.guard();
    Object.assign(this.updates.get(updateId)!, {
      status: dead ? 'dead' : 'failed',
      lastError: error,
      nextAttemptAt: nextAttemptAt.getTime(),
      lockedAt: null,
    });
  }

  async listRetryableUpdates(now: Date, limit: number, staleLockSeconds: number): Promise<StoredUpdate[]> {
    this.guard();
    return [...this.updates.values()]
      .filter(
        (r) =>
          (r.status === 'failed' && r.nextAttemptAt !== null && r.nextAttemptAt <= now.getTime()) ||
          (r.status === 'processing' &&
            r.lockedAt !== null &&
            r.lockedAt < now.getTime() - staleLockSeconds * 1000),
      )
      .slice(0, limit)
      .map((r) => ({ updateId: r.updateId, payload: r.payload, attemptCount: r.attempt }));
  }

  async ping() {
    this.guard();
  }
}
