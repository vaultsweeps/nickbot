import type { SupabaseClient } from '@supabase/supabase-js';
import { RetryableError } from '../utils/errors';
import { toId } from '../utils/validation';
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
} from './store';

type Row = Record<string, unknown>;

const idOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : toId(v as string | number);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const toCustomer = (r: Row): Customer => ({
  id: r.id as string,
  telegramUserId: toId(r.telegram_user_id as string | number),
  username: str(r.telegram_username),
  firstName: str(r.first_name),
  lastName: str(r.last_name),
  phoneNumber: str(r.phone_number),
  phoneVerifiedAt: str(r.phone_verified_at),
});

const toConversation = (r: Row): Conversation => ({
  id: r.id as string,
  ticketNumber: Number(r.ticket_number),
  customerId: r.customer_id as string,
  status: r.status as ConversationStatus,
  staffGroupId: toId(r.staff_group_id as string | number),
  forumTopicId: idOrNull(r.forum_topic_id),
  topicName: str(r.topic_name),
  assignedStaffTelegramId: idOrNull(r.assigned_staff_telegram_id),
});

const toMessage = (r: Row): MessageRecord => ({
  id: r.id as string,
  conversationId: r.conversation_id as string,
  customerId: r.customer_id as string,
  senderType: r.sender_type as MessageRecord['senderType'],
  telegramChatId: toId(r.telegram_chat_id as string | number),
  telegramMessageId: toId(r.telegram_message_id as string | number),
  deliveryStatus: r.delivery_status as MessageRecord['deliveryStatus'],
});

const toMapping = (r: Row): Mapping => ({
  id: r.id as string,
  conversationId: r.conversation_id as string,
  customerId: r.customer_id as string,
  messageId: str(r.message_id),
  staffGroupId: toId(r.staff_group_id as string | number),
  forumTopicId: toId(r.forum_topic_id as string | number),
  staffMessageId: toId(r.staff_message_id as string | number),
  customerChatId: toId(r.customer_chat_id as string | number),
  customerMessageId: toId(r.customer_message_id as string | number),
  mappingType: r.mapping_type as Mapping['mappingType'],
});

/** Any Supabase/PostgREST failure is treated as transient: the update is stored and retried. */
function fail(op: string, error: { message: string; code?: string } | null): never {
  throw new RetryableError(`database ${op} failed${error?.code ? ` (${error.code})` : ''}`);
}

export class SupabaseStore implements Store {
  constructor(private readonly db: SupabaseClient) {}

  async upsertCustomer(p: CustomerProfile): Promise<Customer> {
    // username / names are overwritten with the current values (they are mutable on Telegram);
    // phone columns are deliberately not part of this upsert so they are never wiped.
    const { data, error } = await this.db
      .from('customers')
      .upsert(
        {
          telegram_user_id: p.telegramUserId,
          telegram_username: p.username,
          first_name: p.firstName,
          last_name: p.lastName,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: 'telegram_user_id' },
      )
      .select()
      .single();
    if (error || !data) fail('upsertCustomer', error);
    return toCustomer(data);
  }

  async setCustomerPhone(customerId: string, phone: string, verifiedAt: string): Promise<Customer> {
    const { data, error } = await this.db
      .from('customers')
      .update({ phone_number: phone, phone_verified_at: verifiedAt, phone_shared_at: verifiedAt })
      .eq('id', customerId)
      .select()
      .single();
    if (error || !data) fail('setCustomerPhone', error);
    return toCustomer(data);
  }

  async getCustomer(id: string): Promise<Customer | null> {
    const { data, error } = await this.db.from('customers').select().eq('id', id).maybeSingle();
    if (error) fail('getCustomer', error);
    return data ? toCustomer(data) : null;
  }

  async ensureConversation(customerId: string, staffGroupId: string) {
    const { data, error } = await this.db.rpc('ensure_conversation', {
      p_customer_id: customerId,
      p_staff_group_id: staffGroupId,
    });
    if (error || !data) fail('ensureConversation', error);
    const d = data as { conversation: Row; created: boolean; reopened: boolean };
    return { conversation: toConversation(d.conversation), created: d.created, reopened: d.reopened };
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const { data, error } = await this.db.from('conversations').select().eq('id', id).maybeSingle();
    if (error) fail('getConversation', error);
    return data ? toConversation(data) : null;
  }

  async getLatestConversationForCustomer(customerId: string): Promise<Conversation | null> {
    const { data, error } = await this.db
      .from('conversations')
      .select()
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) fail('getLatestConversation', error);
    return data ? toConversation(data) : null;
  }

  async findConversationByTopic(staffGroupId: string, topicId: string): Promise<Conversation | null> {
    const { data, error } = await this.db
      .from('conversations')
      .select()
      .eq('staff_group_id', staffGroupId)
      .eq('forum_topic_id', topicId)
      .maybeSingle();
    if (error) fail('findConversationByTopic', error);
    return data ? toConversation(data) : null;
  }

  async claimTopicCreation(conversationId: string, lockSeconds: number): Promise<boolean> {
    const { data, error } = await this.db.rpc('claim_topic_creation', {
      p_conversation_id: conversationId,
      p_lock_seconds: lockSeconds,
    });
    if (error) fail('claimTopicCreation', error);
    return data === true;
  }

  async setTopic(
    conversationId: string,
    topicId: string | null,
    topicName: string | null,
  ): Promise<Conversation> {
    const { data, error } = await this.db
      .from('conversations')
      .update({ forum_topic_id: topicId, topic_name: topicName, topic_creating_at: null })
      .eq('id', conversationId)
      .select()
      .single();
    if (error || !data) fail('setTopic', error);
    return toConversation(data);
  }

  async setConversationStatus(conversationId: string, status: ConversationStatus): Promise<Conversation> {
    const { data, error } = await this.db
      .from('conversations')
      .update({ status, closed_at: status === 'closed' ? new Date().toISOString() : null })
      .eq('id', conversationId)
      .select()
      .single();
    if (error || !data) fail('setConversationStatus', error);
    return toConversation(data);
  }

  async insertMessage(m: NewMessage): Promise<{ message: MessageRecord; inserted: boolean }> {
    const { data, error } = await this.db
      .from('messages')
      .insert({
        conversation_id: m.conversationId,
        customer_id: m.customerId,
        sender_type: m.senderType,
        sender_telegram_id: m.senderTelegramId,
        sender_username: m.senderUsername,
        telegram_update_id: m.telegramUpdateId,
        telegram_chat_id: m.telegramChatId,
        telegram_message_id: m.telegramMessageId,
        message_thread_id: m.messageThreadId,
        reply_to_message_id: m.replyToMessageId,
        message_type: m.messageType,
        text_content: m.textContent,
        caption: m.caption,
        telegram_file_id: m.telegramFileId,
        telegram_file_unique_id: m.telegramFileUniqueId,
        delivery_status: m.deliveryStatus,
        delivered_at: m.deliveryStatus === 'delivered' ? new Date().toISOString() : null,
      })
      .select()
      .single();
    if (!error && data) return { message: toMessage(data), inserted: true };
    if (error?.code === '23505') {
      // Duplicate (chat, message): a retry or a webhook redelivery. Return the stored row.
      const existing = await this.db
        .from('messages')
        .select()
        .eq('telegram_chat_id', m.telegramChatId)
        .eq('telegram_message_id', m.telegramMessageId)
        .single();
      if (existing.error || !existing.data) fail('insertMessage/select', existing.error);
      return { message: toMessage(existing.data), inserted: false };
    }
    return fail('insertMessage', error);
  }

  async updateMessage(id: string, patch: MessagePatch): Promise<void> {
    const row: Row = {};
    if (patch.deliveryStatus !== undefined) row.delivery_status = patch.deliveryStatus;
    if (patch.errorMessage !== undefined) row.error_message = patch.errorMessage;
    if (patch.deliveredAt !== undefined) row.delivered_at = patch.deliveredAt;
    if (patch.messageThreadId !== undefined) row.message_thread_id = patch.messageThreadId;
    const { error } = await this.db.from('messages').update(row).eq('id', id);
    if (error) fail('updateMessage', error);
  }

  async createMapping(m: NewMapping): Promise<void> {
    const { error } = await this.db.from('message_mappings').upsert(
      {
        conversation_id: m.conversationId,
        customer_id: m.customerId,
        message_id: m.messageId,
        staff_group_id: m.staffGroupId,
        forum_topic_id: m.forumTopicId,
        staff_message_id: m.staffMessageId,
        customer_chat_id: m.customerChatId,
        customer_message_id: m.customerMessageId,
        mapping_type: m.mappingType,
      },
      { onConflict: 'staff_group_id,staff_message_id', ignoreDuplicates: true },
    );
    if (error) fail('createMapping', error);
  }

  async findMappingByStaffMessage(staffGroupId: string, staffMessageId: string): Promise<Mapping | null> {
    const { data, error } = await this.db
      .from('message_mappings')
      .select()
      .eq('staff_group_id', staffGroupId)
      .eq('staff_message_id', staffMessageId)
      .maybeSingle();
    if (error) fail('findMapping', error);
    return data ? toMapping(data) : null;
  }

  async claimUpdate(
    updateId: string,
    payload: unknown,
    opts: { lockSeconds?: number; maxAttempts?: number } = {},
  ): Promise<ClaimResult> {
    const { data, error } = await this.db.rpc('claim_telegram_update', {
      p_update_id: updateId,
      p_payload: payload,
      p_lock_seconds: opts.lockSeconds ?? 120,
      p_max_attempts: opts.maxAttempts ?? 8,
    });
    if (error || !data) fail('claimUpdate', error);
    return data as ClaimResult;
  }

  async completeUpdate(updateId: string): Promise<void> {
    const { error } = await this.db
      .from('telegram_updates')
      .update({
        status: 'processed',
        processed_at: new Date().toISOString(),
        last_error: null,
        locked_at: null,
      })
      .eq('update_id', updateId);
    if (error) fail('completeUpdate', error);
  }

  async failUpdate(updateId: string, errorText: string, nextAttemptAt: Date, dead: boolean): Promise<void> {
    const { error } = await this.db
      .from('telegram_updates')
      .update({
        status: dead ? 'dead' : 'failed',
        last_error: errorText,
        next_attempt_at: nextAttemptAt.toISOString(),
        locked_at: null,
      })
      .eq('update_id', updateId);
    if (error) fail('failUpdate', error);
  }

  async listRetryableUpdates(now: Date, limit: number, staleLockSeconds: number): Promise<StoredUpdate[]> {
    const stale = new Date(now.getTime() - staleLockSeconds * 1000).toISOString();
    const { data, error } = await this.db
      .from('telegram_updates')
      .select('update_id,payload,attempt_count')
      .or(
        `and(status.eq.failed,next_attempt_at.lte.${now.toISOString()}),and(status.eq.processing,locked_at.lt.${stale})`,
      )
      .not('payload', 'is', null)
      .order('update_id', { ascending: true })
      .limit(limit);
    if (error) fail('listRetryableUpdates', error);
    return (data ?? []).map((r) => ({
      updateId: toId(r.update_id as string | number),
      payload: r.payload,
      attemptCount: Number(r.attempt_count),
    }));
  }

  async ping(): Promise<void> {
    const { error } = await this.db.from('telegram_updates').select('update_id').limit(1);
    if (error) fail('ping', error);
  }
}
