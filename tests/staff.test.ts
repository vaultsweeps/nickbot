import { describe, expect, it } from 'vitest';
import { TelegramApiError } from '../src/utils/errors';
import { GROUP, Harness, OTHER_MEMBER_ID } from './helpers/harness';

/** Creates a customer with a topic and returns ids. */
async function setup(h: Harness, userId = 111, username = 'alice') {
  await h.customer(userId, { username }).send();
  const conv = h.store.conversations.find(
    (c) => h.store.customers.find((x) => x.id === c.customerId)!.telegramUserId === String(userId),
  )!;
  const mapping = h.store.mappings.find((m) => m.conversationId === conv.id)!;
  return {
    conv,
    topic: Number(conv.forumTopicId),
    botCopyId: Number(mapping.staffMessageId),
    customerMsgId: mapping.customerMessageId,
  };
}

const lastCopyToCustomer = (h: Harness) =>
  h.tg
    .of('copyMessage')
    .filter((c) => c.toChatId !== GROUP)
    .at(-1);

describe('staff → customer routing', () => {
  it('routes a normal (non-reply) message in the topic to that customer', async () => {
    const h = new Harness();
    const { topic } = await setup(h);
    const r = await h.staff(topic, { text: 'We are on it' }).send();
    expect(r.status).toBe(200);
    const out = lastCopyToCustomer(h)!;
    expect(out).toMatchObject({ toChatId: '111', fromChatId: GROUP, replyToMessageId: null });
    const staffMsg = h.store.messages.find((m) => m.senderType === 'staff')!;
    expect(staffMsg).toMatchObject({ deliveryStatus: 'delivered' });
    expect(staffMsg.raw).toMatchObject({
      senderTelegramId: '777',
      senderUsername: 'agent',
      messageThreadId: String(topic),
    });
    expect(h.store.mappings.at(-1)).toMatchObject({
      mappingType: 'staff_to_customer',
      customerChatId: '111',
    });
  });

  it('replies to the customer’s original message when staff reply to the bot’s copy', async () => {
    const h = new Harness();
    const { topic, botCopyId, customerMsgId } = await setup(h);
    await h.staff(topic, { reply_to_message: { message_id: botCopyId } }).send();
    expect(lastCopyToCustomer(h)).toMatchObject({ toChatId: '111', replyToMessageId: customerMsgId });
  });

  it('treats a reply to the topic root as a plain topic message', async () => {
    const h = new Harness();
    const { topic } = await setup(h);
    await h.staff(topic, { reply_to_message: { message_id: topic } }).send();
    expect(lastCopyToCustomer(h)).toMatchObject({ toChatId: '111', replyToMessageId: null });
  });

  it('delivers staff media', async () => {
    const h = new Harness();
    const { topic } = await setup(h);
    await h
      .staff(topic, {
        text: undefined,
        photo: [{ file_id: 'p', file_unique_id: 'pu', width: 1, height: 1 }],
        caption: 'screenshot',
      })
      .send();
    expect(lastCopyToCustomer(h)).toMatchObject({ toChatId: '111' });
    expect(h.store.messages.find((m) => m.senderType === 'staff')!.raw).toMatchObject({
      messageType: 'photo',
      caption: 'screenshot',
    });
  });

  it('never leaks routing across customers', async () => {
    const h = new Harness();
    const a = await setup(h, 111, 'alice');
    const b = await setup(h, 222, 'bob');
    await h.staff(b.topic, { text: 'for bob' }).send();
    await h.staff(a.topic, { text: 'for alice' }).send();
    const outs = h.tg.of('copyMessage').filter((c) => c.toChatId !== GROUP);
    expect(outs.map((o) => o.toChatId)).toEqual(['222', '111']);
  });

  it('refuses a reply that points at a message from ANOTHER customer’s conversation', async () => {
    const h = new Harness();
    const a = await setup(h, 111, 'alice');
    const b = await setup(h, 222, 'bob');
    const before = h.tg.of('copyMessage').length;
    await h.staff(a.topic, { reply_to_message: { message_id: b.botCopyId } }).send();
    expect(h.tg.of('copyMessage')).toHaveLength(before);
    expect(String(h.tg.of('sendMessage').at(-1)!.text)).toContain('different conversation');
  });

  it('ignores unauthorized group members, wrong groups, and General-topic chatter', async () => {
    const h = new Harness();
    const { topic } = await setup(h);
    const before = h.tg.calls.length;
    await h.staff(topic, {}, OTHER_MEMBER_ID).send(); // member not on the allow-list
    await h.staff(topic, {}, 777, -1009999999999).send(); // some other group
    await h.staff(undefined, { text: 'general chat' }).send(); // General topic
    await h.staff(9999, { text: 'unlinked topic' }).send(); // topic without a customer
    expect(h.tg.calls).toHaveLength(before);
    expect(h.store.messages.filter((m) => m.senderType !== 'customer')).toHaveLength(0);
  });

  it('keeps //-prefixed messages as internal notes and never sends them', async () => {
    const h = new Harness();
    const { topic } = await setup(h);
    const before = h.tg.of('copyMessage').length;
    await h.staff(topic, { text: '// customer seems upset' }).send();
    expect(h.tg.of('copyMessage')).toHaveLength(before);
    expect(h.store.messages.find((m) => m.senderType === 'staff_note')).toMatchObject({
      deliveryStatus: 'skipped',
    });
  });

  it('reports permanent delivery failures to staff without internal details', async () => {
    const h = new Harness();
    const { topic } = await setup(h);
    h.tg.failNext(
      'copyMessage',
      new TelegramApiError('copyMessage', 403, 'Forbidden: bot was blocked by the user'),
    );
    const r = await h.staff(topic, {}).send();
    expect(r.status).toBe(200);
    expect(h.store.messages.find((m) => m.senderType === 'staff')).toMatchObject({
      deliveryStatus: 'failed',
    });
    expect(String(h.tg.of('sendMessage').at(-1)!.text)).toContain('blocked the bot');
  });
});

describe('staff commands and ticket lifecycle', () => {
  it('/ticket, /help', async () => {
    const h = new Harness();
    const { topic } = await setup(h);
    await h.staff(topic, { text: '/ticket' }).send();
    expect(String(h.tg.of('sendMessage').at(-1)!.text)).toContain('Ticket #1000');
    await h.staff(topic, { text: `/help@support_test_bot` }).send();
    expect(String(h.tg.of('sendMessage').at(-1)!.text)).toContain('/close');
    await h.staff(topic, { text: '/help@some_other_bot' }).send(); // addressed elsewhere → treated as text? no: ignored command
  });

  it('/close blocks replies, closes the topic; /reopen restores; customer message auto-reopens', async () => {
    const h = new Harness();
    const { topic, conv } = await setup(h);

    await h.staff(topic, { text: '/close' }).send();
    expect(h.store.conversations[0]!.status).toBe('closed');
    expect(h.tg.of('closeForumTopic')).toHaveLength(1);

    const copies = h.tg.of('copyMessage').length;
    await h.staff(topic, { text: 'too late' }).send();
    expect(h.tg.of('copyMessage')).toHaveLength(copies);
    expect(String(h.tg.of('sendMessage').at(-1)!.text)).toContain('closed');

    await h.staff(topic, { text: '/reopen' }).send();
    expect(h.store.conversations[0]!.status).toBe('open');
    expect(h.tg.of('reopenForumTopic')).toHaveLength(1);

    await h.staff(topic, { text: '/close' }).send();
    await h.customer(111, { username: 'alice', text: 'one more thing' }).send();
    expect(h.store.conversations).toHaveLength(1);
    expect(h.store.conversations[0]).toMatchObject({ id: conv.id, status: 'open' });
    expect(h.tg.of('reopenForumTopic').length).toBe(2);
    expect(h.tg.of('createForumTopic')).toHaveLength(1);
  });

  it('unauthorized users cannot run commands', async () => {
    const h = new Harness();
    const { topic } = await setup(h);
    await h.staff(topic, { text: '/close' }, OTHER_MEMBER_ID).send();
    expect(h.store.conversations[0]!.status).toBe('open');
  });
});
