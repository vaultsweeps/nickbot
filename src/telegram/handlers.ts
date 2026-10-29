import type { Conversation, Customer } from '../database/store';
import { isRetryable, TelegramApiError } from '../utils/errors';
import { sanitizeError } from '../utils/logging';
import { normalizePhone, parseCommand, toId } from '../utils/validation';
import type { BotContext } from './context';
import { classifyMessage, isUnsupportedMedia, texts } from './messages';
import { handleStaffMessage } from './routing';
import { displayName, ensureTopic, resetTopic, syncTopicName } from './topics';
import type { TgMessage, TgUpdate } from './types';

/** Entry point for one stored update. Throws on failure so the caller can schedule a retry. */
export async function processUpdate(ctx: BotContext, update: TgUpdate): Promise<void> {
  const msg = update.message;
  if (!msg) return; // only `message` updates are subscribed; anything else is ignored

  const chatId = toId(msg.chat.id);
  if (msg.chat.type === 'private') return handleCustomerMessage(ctx, msg);
  if (ctx.staffAuth.isStaffGroup(chatId)) return handleStaffMessage(ctx, msg);
  ctx.logger.warn('ignored update from unexpected chat', { chatType: msg.chat.type });
}

const contactKeyboard = {
  keyboard: [[{ text: '📱 Share my phone number', request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

async function reply(ctx: BotContext, chatId: string, text: string, replyMarkup?: Record<string, unknown>) {
  try {
    await ctx.telegram.sendMessage({ chatId, text, replyMarkup });
  } catch (err) {
    // A courtesy message must not fail (and re-run) the whole update, unless it's transient.
    if (isRetryable(err)) throw err;
    ctx.logger.warn('could not message customer', { error: err });
  }
}

export async function handleCustomerMessage(ctx: BotContext, msg: TgMessage): Promise<void> {
  const from = msg.from;
  if (!from || from.is_bot) return;

  const chatId = toId(msg.chat.id);
  const customer = await ctx.store.upsertCustomer({
    telegramUserId: toId(from.id),
    username: from.username ?? null,
    firstName: from.first_name ?? null,
    lastName: from.last_name ?? null,
  });

  const command = parseCommand(msg.text, ctx.botUsername);
  if (command?.name === 'start') {
    await reply(ctx, chatId, texts.welcome(from.first_name ?? ''), contactKeyboard);
    return;
  }

  if (msg.contact) return handleContact(ctx, msg, customer, chatId);

  const kind = classifyMessage(msg);
  if (!kind) {
    if (msg.text !== undefined || isUnsupportedMedia(msg)) await reply(ctx, chatId, texts.unsupported);
    return;
  }

  const { conversation, created, reopened } = await ctx.store.ensureConversation(
    customer.id,
    ctx.staffGroupId,
  );
  const log = ctx.logger.child({
    conversationId: conversation.id,
    ticket: conversation.ticketNumber,
    messageType: kind.type,
  });

  const { message, inserted } = await ctx.store.insertMessage({
    conversationId: conversation.id,
    customerId: customer.id,
    senderType: 'customer',
    senderTelegramId: toId(from.id),
    senderUsername: from.username ?? null,
    telegramUpdateId: ctx.updateId,
    telegramChatId: chatId,
    telegramMessageId: toId(msg.message_id),
    messageThreadId: null,
    replyToMessageId: msg.reply_to_message ? toId(msg.reply_to_message.message_id) : null,
    messageType: kind.type,
    textContent: kind.text,
    caption: kind.caption,
    telegramFileId: kind.fileId,
    telegramFileUniqueId: kind.fileUniqueId,
    deliveryStatus: 'pending',
  });
  if (!inserted && message.deliveryStatus !== 'pending') {
    log.info('customer message already handled', { deliveryStatus: message.deliveryStatus });
    return;
  }

  let conv: Conversation = conversation;
  try {
    conv = await ensureTopic(ctx, conv, customer);
    if (reopened) await reopenTopicQuietly(ctx, conv);
    conv = await syncTopicName(ctx, conv, customer);

    const copied = await copyIntoTopic(ctx, conv, chatId, toId(msg.message_id), customer);
    await ctx.store.createMapping({
      conversationId: conv.id,
      customerId: customer.id,
      messageId: message.id,
      staffGroupId: conv.staffGroupId,
      forumTopicId: copied.topicId,
      staffMessageId: copied.messageId,
      customerChatId: chatId,
      customerMessageId: toId(msg.message_id),
      mappingType: 'customer_to_staff',
    });
    await ctx.store.updateMessage(message.id, {
      deliveryStatus: 'delivered',
      deliveredAt: ctx.now().toISOString(),
      messageThreadId: copied.topicId,
      errorMessage: null,
    });
    log.info('customer message delivered', { deliveryStatus: 'delivered' });
  } catch (err) {
    if (isRetryable(err)) throw err; // message stays 'pending'; the update will be retried
    const description = sanitizeError(err);
    await ctx.store.updateMessage(message.id, { deliveryStatus: 'failed', errorMessage: description });
    log.error('customer message delivery failed permanently', { deliveryStatus: 'failed', error: err });
    await reply(ctx, chatId, texts.deliveryFailed);
    return;
  }

  if (created || reopened) await reply(ctx, chatId, texts.received(conv.ticketNumber));
}

/** copyMessage into the customer's topic; if the topic was deleted in Telegram, recreate it once. */
async function copyIntoTopic(
  ctx: BotContext,
  conv: Conversation,
  customerChatId: string,
  customerMessageId: string,
  customer: Customer,
): Promise<{ messageId: string; topicId: string }> {
  const attempt = async (c: Conversation) => {
    const topicId = c.forumTopicId!;
    const r = await ctx.telegram.copyMessage({
      toChatId: c.staffGroupId,
      fromChatId: customerChatId,
      messageId: customerMessageId,
      messageThreadId: topicId,
    });
    return { messageId: r.messageId, topicId };
  };
  try {
    return await attempt(conv);
  } catch (err) {
    if (!(err instanceof TelegramApiError) || !err.topicMissing) throw err;
    const reset = await resetTopic(ctx, conv);
    const recreated = await ensureTopic(ctx, reset, customer);
    return attempt(recreated);
  }
}

async function reopenTopicQuietly(ctx: BotContext, conv: Conversation) {
  if (!conv.forumTopicId) return;
  try {
    await ctx.telegram.reopenForumTopic({ chatId: conv.staffGroupId, messageThreadId: conv.forumTopicId });
  } catch (err) {
    // TOPIC_NOT_MODIFIED (already open) etc. must not block delivery.
    ctx.logger.debug('reopenForumTopic ignored', { error: err });
  }
}

async function handleContact(ctx: BotContext, msg: TgMessage, customer: Customer, chatId: string) {
  const contact = msg.contact!;
  // Only the sender's own contact counts; forwarded/other people's contacts are rejected.
  if (!msg.from || contact.user_id === undefined || toId(contact.user_id) !== toId(msg.from.id)) {
    await reply(ctx, chatId, texts.contactNotOwn);
    return;
  }
  const phone = normalizePhone(contact.phone_number);
  if (!phone) {
    await reply(ctx, chatId, texts.contactNotOwn);
    return;
  }

  const updated = await ctx.store.setCustomerPhone(customer.id, phone, ctx.now().toISOString());
  const conv = await ctx.store.getLatestConversationForCustomer(customer.id);
  if (conv?.forumTopicId) await syncTopicName(ctx, conv, updated);
  await reply(ctx, chatId, texts.contactThanks, { remove_keyboard: true });
  ctx.logger.info('customer shared verified phone', {
    customerId: customer.id,
    hasName: displayName(updated) !== '',
  });
}
