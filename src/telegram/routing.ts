import type { Conversation, Customer } from '../database/store';
import { isRetryable, TelegramApiError } from '../utils/errors';
import { sanitizeError } from '../utils/logging';
import { parseCommand, toId } from '../utils/validation';
import type { BotContext } from './context';
import { classifyMessage, isUnsupportedMedia } from './messages';
import { displayName } from './topics';
import type { TgMessage } from './types';

const HELP = [
  'Staff commands (use inside a customer topic):',
  '/ticket – show ticket and customer reference',
  '/close – close this conversation',
  '/reopen – reopen this conversation',
  '/help – this message',
  '',
  'Any other message in a customer topic is sent to the customer.',
  'Start a message with // to keep it as an internal note (never sent).',
].join('\n');

async function say(
  ctx: BotContext,
  conv: { staffGroupId: string; forumTopicId: string | null } | null,
  text: string,
  replyTo?: string,
) {
  try {
    await ctx.telegram.sendMessage({
      chatId: ctx.staffGroupId,
      text,
      messageThreadId: conv?.forumTopicId ?? null,
      replyToMessageId: replyTo ?? null,
    });
  } catch (err) {
    if (isRetryable(err)) throw err;
    ctx.logger.warn('could not post to staff group', { error: err });
  }
}

/**
 * Handles one message from the staff group. Customer identity comes ONLY from the persisted
 * topic -> conversation mapping, never from names, captions or typed ticket numbers.
 */
export async function handleStaffMessage(ctx: BotContext, msg: TgMessage): Promise<void> {
  const from = msg.from;
  if (!from || from.is_bot || msg.sender_chat) return; // bot, service, or anonymous-admin posts
  if (!ctx.staffAuth.isAuthorizedStaff(toId(from.id))) {
    ctx.logger.warn('ignored message from unauthorized staff-group member', { staffId: toId(from.id) });
    return;
  }
  if (msg.forum_topic_created) return;

  const threadId = msg.message_thread_id !== undefined ? toId(msg.message_thread_id) : null;
  const command = parseCommand(msg.text, ctx.botUsername);

  const conv = threadId ? await ctx.store.findConversationByTopic(ctx.staffGroupId, threadId) : null;

  if (!conv) {
    // General topic or a topic that is not linked to a customer: only commands get an answer.
    if (command) {
      await say(
        ctx,
        threadId ? { staffGroupId: ctx.staffGroupId, forumTopicId: threadId } : null,
        command.name === 'help' ? HELP : 'This topic is not linked to a customer conversation.',
      );
    }
    return;
  }

  if (command) return handleCommand(ctx, msg, conv, command.name);

  const noteText = msg.text ?? msg.caption ?? '';
  if (noteText.startsWith('//')) return recordNote(ctx, msg, conv, from.username ?? null);

  if (conv.status === 'closed') {
    await say(
      ctx,
      conv,
      '🔒 This conversation is closed. Use /reopen before replying to the customer.',
      toId(msg.message_id),
    );
    return;
  }

  const kind = classifyMessage(msg);
  if (!kind) {
    if (isUnsupportedMedia(msg) || msg.text !== undefined || msg.contact) {
      await say(
        ctx,
        conv,
        '⚠️ Unsupported message type; it was not sent. Use text, photo, video, document or voice.',
        toId(msg.message_id),
      );
    }
    return;
  }

  const customer = await ctx.store.getCustomer(conv.customerId);
  if (!customer) {
    await say(ctx, conv, '⚠️ Customer record not found; message not sent.', toId(msg.message_id));
    return;
  }
  const customerChatId = customer.telegramUserId; // private chat id == user id

  // Optional explicit reply target. The topic root and unmapped messages (notes, bot notices)
  // simply mean "no specific message". A mapping that belongs to ANOTHER conversation means the
  // routing is inconsistent, so we refuse rather than guess.
  let replyTarget: string | null = null;
  const replyId = msg.reply_to_message?.message_id;
  if (replyId !== undefined && toId(replyId) !== threadId) {
    const mapping = await ctx.store.findMappingByStaffMessage(ctx.staffGroupId, toId(replyId));
    if (mapping) {
      if (mapping.conversationId !== conv.id || mapping.customerId !== conv.customerId) {
        ctx.logger.error('routing mismatch between reply mapping and topic', { conversationId: conv.id });
        await say(
          ctx,
          conv,
          '⚠️ That message belongs to a different conversation. Nothing was sent.',
          toId(msg.message_id),
        );
        return;
      }
      replyTarget = mapping.customerMessageId;
    }
  }

  const { message, inserted } = await ctx.store.insertMessage({
    conversationId: conv.id,
    customerId: conv.customerId,
    senderType: 'staff',
    senderTelegramId: toId(from.id),
    senderUsername: from.username ?? null,
    telegramUpdateId: ctx.updateId,
    telegramChatId: ctx.staffGroupId,
    telegramMessageId: toId(msg.message_id),
    messageThreadId: threadId,
    replyToMessageId: replyId !== undefined ? toId(replyId) : null,
    messageType: kind.type,
    textContent: kind.text,
    caption: kind.caption,
    telegramFileId: kind.fileId,
    telegramFileUniqueId: kind.fileUniqueId,
    deliveryStatus: 'pending',
  });
  if (!inserted && message.deliveryStatus !== 'pending') return; // redelivered update, already handled

  const log = ctx.logger.child({
    conversationId: conv.id,
    ticket: conv.ticketNumber,
    messageType: kind.type,
  });
  try {
    const copied = await ctx.telegram.copyMessage({
      toChatId: customerChatId,
      fromChatId: ctx.staffGroupId,
      messageId: toId(msg.message_id),
      replyToMessageId: replyTarget,
    });
    await ctx.store.createMapping({
      conversationId: conv.id,
      customerId: conv.customerId,
      messageId: message.id,
      staffGroupId: ctx.staffGroupId,
      forumTopicId: threadId!,
      staffMessageId: toId(msg.message_id),
      customerChatId,
      customerMessageId: copied.messageId,
      mappingType: 'staff_to_customer',
    });
    await ctx.store.updateMessage(message.id, {
      deliveryStatus: 'delivered',
      deliveredAt: ctx.now().toISOString(),
      errorMessage: null,
    });
    log.info('staff reply delivered', { deliveryStatus: 'delivered' });
  } catch (err) {
    if (isRetryable(err)) throw err;
    await ctx.store.updateMessage(message.id, { deliveryStatus: 'failed', errorMessage: sanitizeError(err) });
    log.error('staff reply delivery failed', { deliveryStatus: 'failed', error: err });
    const why =
      err instanceof TelegramApiError && err.botBlockedOrChatGone
        ? 'The customer blocked the bot or deleted the chat.'
        : 'Telegram rejected the message.';
    await say(ctx, conv, `❌ Not delivered. ${why}`, toId(msg.message_id));
  }
}

async function recordNote(ctx: BotContext, msg: TgMessage, conv: Conversation, username: string | null) {
  const kind = classifyMessage(msg);
  if (!kind) return;
  const { message, inserted } = await ctx.store.insertMessage({
    conversationId: conv.id,
    customerId: conv.customerId,
    senderType: 'staff_note',
    senderTelegramId: toId(msg.from!.id),
    senderUsername: username,
    telegramUpdateId: ctx.updateId,
    telegramChatId: ctx.staffGroupId,
    telegramMessageId: toId(msg.message_id),
    messageThreadId: conv.forumTopicId,
    replyToMessageId: null,
    messageType: kind.type,
    textContent: kind.text,
    caption: kind.caption,
    telegramFileId: kind.fileId,
    telegramFileUniqueId: kind.fileUniqueId,
    deliveryStatus: 'skipped', // notes are never delivered to customers
  });
  if (inserted) ctx.logger.info('internal note stored', { conversationId: conv.id, messageId: message.id });
}

function who(c: Customer): string {
  const parts = [c.username ? `@${c.username}` : null, displayName(c) || null].filter(Boolean);
  return parts.join(' · ') || 'unknown';
}

async function handleCommand(ctx: BotContext, msg: TgMessage, conv: Conversation, name: string) {
  switch (name) {
    case 'help':
      return say(ctx, conv, HELP);
    case 'ticket': {
      const c = await ctx.store.getCustomer(conv.customerId);
      const lines = [
        `🎫 Ticket #${conv.ticketNumber} (${conv.status})`,
        `Customer: ${c ? who(c) : 'unknown'}`,
        `Telegram ID: ${c?.telegramUserId ?? 'unknown'}`,
        `Phone: ${c?.phoneNumber ? `${c.phoneNumber}${c.phoneVerifiedAt ? ' (verified)' : ''}` : 'not shared'}`,
      ];
      return say(ctx, conv, lines.join('\n'));
    }
    case 'close': {
      if (conv.status === 'closed') return say(ctx, conv, 'Already closed.');
      await ctx.store.setConversationStatus(conv.id, 'closed');
      await say(
        ctx,
        conv,
        `🔒 Ticket #${conv.ticketNumber} closed. If the customer writes again it will be reopened automatically.`,
      );
      await topicAction(ctx, () =>
        ctx.telegram.closeForumTopic({ chatId: conv.staffGroupId, messageThreadId: conv.forumTopicId! }),
      );
      return;
    }
    case 'reopen': {
      if (conv.status === 'open') return say(ctx, conv, 'Already open.');
      await ctx.store.setConversationStatus(conv.id, 'open');
      await topicAction(ctx, () =>
        ctx.telegram.reopenForumTopic({ chatId: conv.staffGroupId, messageThreadId: conv.forumTopicId! }),
      );
      return say(ctx, conv, `🔓 Ticket #${conv.ticketNumber} reopened.`);
    }
    default:
      return say(ctx, conv, 'Unknown command. Try /help.', toId(msg.message_id));
  }
}

async function topicAction(ctx: BotContext, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    if (isRetryable(err)) throw err;
    ctx.logger.debug('topic action ignored', { error: err });
  }
}
