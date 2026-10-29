import type { Conversation, Customer } from '../database/store';
import { RetryableError, TelegramApiError } from '../utils/errors';
import type { BotContext } from './context';

const TOPIC_NAME_MAX = 128;
const LOCK_SECONDS = 30;

export function displayName(c: Pick<Customer, 'firstName' | 'lastName'>): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
}

/**
 * Identification priority: @username, then a voluntarily shared phone, then display name,
 * then a generic fallback. The stable Telegram id is never shown; the ticket number makes
 * titles unique and gives staff a short reference.
 */
export function buildTopicName(customer: Customer, ticketNumber: number): string {
  const suffix = ` | #${ticketNumber}`;
  const ident = customer.username
    ? `@${customer.username}`
    : customer.phoneNumber
      ? customer.phoneNumber
      : displayName(customer) || 'Customer';
  const name = ident === 'Customer' ? `Customer #${ticketNumber}` : `${ident}${suffix}`;
  return name.length <= TOPIC_NAME_MAX
    ? name
    : `${ident.slice(0, TOPIC_NAME_MAX - suffix.length - 1)}…${suffix}`;
}

/**
 * Returns the conversation with a usable forum topic, creating it at most once even when
 * several updates for the same customer run concurrently (DB-level claim + waiting losers).
 */
export async function ensureTopic(
  ctx: BotContext,
  conv: Conversation,
  customer: Customer,
): Promise<Conversation> {
  if (conv.forumTopicId) return conv;

  const won = await ctx.store.claimTopicCreation(conv.id, LOCK_SECONDS);
  if (won) {
    const name = buildTopicName(customer, conv.ticketNumber);
    let messageThreadId: string;
    try {
      ({ messageThreadId } = await ctx.telegram.createForumTopic({ chatId: conv.staffGroupId, name }));
    } catch (err) {
      // Release the creation lock so the retry doesn't have to wait for it to expire.
      await ctx.store.setTopic(conv.id, null, null).catch(() => undefined);
      throw err;
    }
    const updated = await ctx.store.setTopic(conv.id, messageThreadId, name);
    ctx.logger.info('topic created', { conversationId: conv.id, ticket: conv.ticketNumber });
    return updated;
  }

  for (let i = 0; i < 10; i++) {
    await ctx.sleep(500);
    const fresh = await ctx.store.getConversation(conv.id);
    if (fresh?.forumTopicId) return fresh;
  }
  throw new RetryableError('topic creation by another request is still in progress');
}

/** Renames the topic when username / phone / name changed. Topic and conversation are preserved. */
export async function syncTopicName(
  ctx: BotContext,
  conv: Conversation,
  customer: Customer,
): Promise<Conversation> {
  if (!conv.forumTopicId) return conv;
  const desired = buildTopicName(customer, conv.ticketNumber);
  if (desired === conv.topicName) return conv;
  try {
    await ctx.telegram.editForumTopic({
      chatId: conv.staffGroupId,
      messageThreadId: conv.forumTopicId,
      name: desired,
    });
  } catch (err) {
    // Not-modified is fine; a rename failure must never block message delivery.
    if (!(err instanceof TelegramApiError) || !/not modified/i.test(err.description)) {
      ctx.logger.warn('topic rename failed', { conversationId: conv.id, error: err });
      return conv;
    }
  }
  return ctx.store.setTopic(conv.id, conv.forumTopicId, desired);
}

/** Forget a topic that was deleted in Telegram so the next ensureTopic creates a fresh one. */
export async function resetTopic(ctx: BotContext, conv: Conversation): Promise<Conversation> {
  ctx.logger.warn('forum topic missing, recreating', { conversationId: conv.id });
  return ctx.store.setTopic(conv.id, null, null);
}
