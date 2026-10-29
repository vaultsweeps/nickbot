// Persistence port. The Supabase implementation is production; tests use an in-memory one.
// All Telegram ids are decimal strings (see utils/validation.ts).

export interface Customer {
  id: string;
  telegramUserId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  phoneNumber: string | null;
  phoneVerifiedAt: string | null;
}

export interface CustomerProfile {
  telegramUserId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}

export type ConversationStatus = 'open' | 'closed';

export interface Conversation {
  id: string;
  ticketNumber: number;
  customerId: string;
  status: ConversationStatus;
  staffGroupId: string;
  forumTopicId: string | null;
  topicName: string | null;
  assignedStaffTelegramId: string | null;
}

export type SenderType = 'customer' | 'staff' | 'staff_note';
export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'skipped';
export type MessageKind = 'text' | 'photo' | 'video' | 'document' | 'voice';

export interface MessageRecord {
  id: string;
  conversationId: string;
  customerId: string;
  senderType: SenderType;
  telegramChatId: string;
  telegramMessageId: string;
  deliveryStatus: DeliveryStatus;
}

export interface NewMessage {
  conversationId: string;
  customerId: string;
  senderType: SenderType;
  senderTelegramId: string;
  senderUsername: string | null;
  telegramUpdateId: string;
  telegramChatId: string;
  telegramMessageId: string;
  messageThreadId: string | null;
  replyToMessageId: string | null;
  messageType: MessageKind;
  textContent: string | null;
  caption: string | null;
  telegramFileId: string | null;
  telegramFileUniqueId: string | null;
  deliveryStatus: DeliveryStatus;
}

export interface MessagePatch {
  deliveryStatus?: DeliveryStatus;
  errorMessage?: string | null;
  deliveredAt?: string | null;
  messageThreadId?: string | null;
}

export interface NewMapping {
  conversationId: string;
  customerId: string;
  messageId: string | null;
  staffGroupId: string;
  forumTopicId: string;
  staffMessageId: string;
  customerChatId: string;
  customerMessageId: string;
  mappingType: 'customer_to_staff' | 'staff_to_customer';
}

export interface Mapping extends NewMapping {
  id: string;
}

export type ClaimResult = { result: 'claimed' | 'duplicate' | 'in_progress' | 'dead'; attempt: number };

export interface StoredUpdate {
  updateId: string;
  payload: unknown;
  attemptCount: number;
}

export interface Store {
  upsertCustomer(profile: CustomerProfile): Promise<Customer>;
  setCustomerPhone(customerId: string, phone: string, verifiedAt: string): Promise<Customer>;
  ensureConversation(
    customerId: string,
    staffGroupId: string,
  ): Promise<{ conversation: Conversation; created: boolean; reopened: boolean }>;
  getConversation(id: string): Promise<Conversation | null>;
  getLatestConversationForCustomer(customerId: string): Promise<Conversation | null>;
  getCustomer(id: string): Promise<Customer | null>;
  findConversationByTopic(staffGroupId: string, topicId: string): Promise<Conversation | null>;
  claimTopicCreation(conversationId: string, lockSeconds: number): Promise<boolean>;
  setTopic(conversationId: string, topicId: string | null, topicName: string | null): Promise<Conversation>;
  setConversationStatus(conversationId: string, status: ConversationStatus): Promise<Conversation>;

  /** Idempotent on (telegramChatId, telegramMessageId); returns the existing row if present. */
  insertMessage(m: NewMessage): Promise<{ message: MessageRecord; inserted: boolean }>;
  updateMessage(id: string, patch: MessagePatch): Promise<void>;
  /** Idempotent on (staffGroupId, staffMessageId). */
  createMapping(m: NewMapping): Promise<void>;
  findMappingByStaffMessage(staffGroupId: string, staffMessageId: string): Promise<Mapping | null>;

  claimUpdate(
    updateId: string,
    payload: unknown,
    opts?: { lockSeconds?: number; maxAttempts?: number },
  ): Promise<ClaimResult>;
  completeUpdate(updateId: string): Promise<void>;
  failUpdate(updateId: string, error: string, nextAttemptAt: Date, dead: boolean): Promise<void>;
  listRetryableUpdates(now: Date, limit: number, staleLockSeconds: number): Promise<StoredUpdate[]>;

  ping(): Promise<void>;
}
