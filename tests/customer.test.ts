import { describe, expect, it } from 'vitest';
import { buildTopicName } from '../src/telegram/topics';
import { TelegramApiError } from '../src/utils/errors';
import { Harness } from './helpers/harness';

const customerOf = (h: Harness, id: string) => h.store.customers.find((c) => c.telegramUserId === id)!;

describe('customer flow', () => {
  it('registers a new customer with a username, creates a topic named @username | #ticket and forwards the message', async () => {
    const h = new Harness();
    const r = await h.customer(111, { username: 'alice_w', text: 'I need help' }).send();
    expect(r.status).toBe(200);

    expect(h.store.customers).toHaveLength(1);
    expect(customerOf(h, '111').username).toBe('alice_w');
    const conv = h.store.conversations[0]!;
    expect(conv.topicName).toBe('@alice_w | #1000');
    expect(h.tg.of('createForumTopic')).toEqual([{ chatId: '-1001234567890', name: '@alice_w | #1000' }]);

    const copy = h.tg.of('copyMessage')[0]!;
    expect(copy).toMatchObject({
      toChatId: '-1001234567890',
      fromChatId: '111',
      messageThreadId: conv.forumTopicId,
    });
    // delivery persisted + mapping created
    expect(h.store.messages[0]).toMatchObject({ senderType: 'customer', deliveryStatus: 'delivered' });
    expect(h.store.mappings[0]).toMatchObject({
      mappingType: 'customer_to_staff',
      customerChatId: '111',
      forumTopicId: conv.forumTopicId,
    });
    // acknowledgement on the first message
    expect(h.tg.of('sendMessage').some((m) => String(m.text).includes('ticket #1000'))).toBe(true);
  });

  it('handles a customer without a username (display name, then generic fallback)', async () => {
    const h = new Harness();
    await h.customer(222, { first_name: 'Bob' }).send();
    expect(h.store.conversations[0]!.topicName).toBe('Bob | #1000');
    const anon = {
      id: 'x',
      telegramUserId: '1',
      username: null,
      firstName: null,
      lastName: null,
      phoneNumber: null,
      phoneVerifiedAt: null,
    };
    expect(buildTopicName(anon, 42)).toBe('Customer #42');
    expect(buildTopicName({ ...anon, phoneNumber: '+919876543210' }, 42)).toBe('+919876543210 | #42');
    expect(buildTopicName({ ...anon, phoneNumber: '+9198', username: 'zed' }, 42)).toBe('@zed | #42');
  });

  it('truncates topic names to Telegramâ€™s 128 char limit', () => {
    const c = {
      id: 'x',
      telegramUserId: '1',
      username: null,
      firstName: 'N'.repeat(300),
      lastName: null,
      phoneNumber: null,
      phoneVerifiedAt: null,
    };
    expect(buildTopicName(c, 7).length).toBeLessThanOrEqual(128);
    expect(buildTopicName(c, 7).endsWith('| #7')).toBe(true);
  });

  it('/start sends the welcome with a request_contact keyboard and creates no topic', async () => {
    const h = new Harness();
    await h.customer(111, { text: '/start' }).send();
    const msg = h.tg.of('sendMessage')[0]!;
    expect(JSON.stringify(msg.replyMarkup)).toContain('request_contact');
    expect(h.tg.of('createForumTopic')).toHaveLength(0);
    expect(h.store.conversations).toHaveLength(0);
  });

  it('accepts a customerâ€™s OWN contact, verifies it, and renames the topic (no username)', async () => {
    const h = new Harness();
    await h.customer(333, { first_name: 'Cara' }).send();
    await h.customer(333, { contact: { phone_number: '91 98765-43210', user_id: 333 } }).send();
    const c = customerOf(h, '333');
    expect(c.phoneNumber).toBe('+919876543210');
    expect(c.phoneVerifiedAt).not.toBeNull();
    // username is absent, so the phone becomes the identifier
    expect(h.store.conversations[0]!.topicName).toBe('+919876543210 | #1000');
    expect(h.tg.of('editForumTopic')).toHaveLength(1);
    expect(JSON.stringify(h.tg.of('sendMessage').at(-1)!.replyMarkup)).toContain('remove_keyboard');
  });

  it('rejects someone elseâ€™s contact', async () => {
    const h = new Harness();
    await h.customer(333).send();
    await h.customer(333, { contact: { phone_number: '+15551234567', user_id: 999 } }).send();
    await h.customer(333, { contact: { phone_number: '+15551234567' } }).send();
    expect(customerOf(h, '333').phoneNumber).toBeNull();
    expect(h.tg.of('sendMessage').filter((m) => String(m.text).includes('your own contact'))).toHaveLength(2);
  });

  it('renames the topic when the username changes, keeping topic and conversation', async () => {
    const h = new Harness();
    await h.customer(444, { username: 'old_name' }).send();
    const before = { ...h.store.conversations[0]! };
    await h.customer(444, { username: 'new_name' }).send();
    expect(h.store.conversations).toHaveLength(1);
    expect(h.store.conversations[0]!.forumTopicId).toBe(before.forumTopicId);
    expect(h.store.conversations[0]!.topicName).toBe('@new_name | #1000');
    expect(h.tg.of('createForumTopic')).toHaveLength(1);
    expect(h.tg.of('editForumTopic')[0]).toMatchObject({ name: '@new_name | #1000' });
  });

  it('reuses the topic for later messages (one topic per customer)', async () => {
    const h = new Harness();
    for (let i = 0; i < 3; i++) await h.customer(555, { username: 'reuse' }).send();
    expect(h.tg.of('createForumTopic')).toHaveLength(1);
    expect(h.tg.of('copyMessage')).toHaveLength(3);
    // acknowledgement only once
    expect(h.tg.of('sendMessage').filter((m) => String(m.text).includes('ticket #'))).toHaveLength(1);
  });

  it.each([
    [
      'photo',
      {
        text: undefined,
        photo: [
          { file_id: 's', file_unique_id: 'su', width: 1, height: 1 },
          { file_id: 'L', file_unique_id: 'Lu', width: 9, height: 9 },
        ],
        caption: 'look',
      },
      'photo',
      'L',
    ],
    ['video', { text: undefined, video: { file_id: 'v1', file_unique_id: 'vu' } }, 'video', 'v1'],
    [
      'document',
      { text: undefined, document: { file_id: 'd1', file_unique_id: 'du' }, caption: 'doc' },
      'document',
      'd1',
    ],
    ['voice', { text: undefined, voice: { file_id: 'vo1', file_unique_id: 'vou' } }, 'voice', 'vo1'],
  ] as const)('forwards %s with metadata persisted', async (_n, extra, type, fileId) => {
    const h = new Harness();
    await h.customer(666, extra as never).send();
    expect(h.store.messages[0]!.raw).toMatchObject({ messageType: type, telegramFileId: fileId });
    expect(h.tg.of('copyMessage')).toHaveLength(1); // file_id based copy, no download
    expect(h.store.messages[0]!.deliveryStatus).toBe('delivered');
  });

  it('tells the customer when media is unsupported and forwards nothing', async () => {
    const h = new Harness();
    await h.customer(666, { text: undefined, sticker: { file_id: 's', file_unique_id: 'su' } }).send();
    expect(h.tg.of('copyMessage')).toHaveLength(0);
    expect(String(h.tg.of('sendMessage')[0]!.text)).toContain('not supported');
  });

  it('keeps concurrent customers isolated in their own topics', async () => {
    const h = new Harness();
    await Promise.all([1, 2, 3, 4, 5].map((i) => h.customer(1000 + i, { username: `user${i}` }).send()));
    expect(h.store.conversations).toHaveLength(5);
    expect(new Set(h.store.conversations.map((c) => c.forumTopicId)).size).toBe(5);
    for (const copy of h.tg.of('copyMessage')) {
      const conv = h.store.conversations.find((c) => c.forumTopicId === copy.messageThreadId)!;
      const cust = h.store.customers.find((c) => c.id === conv.customerId)!;
      expect(copy.fromChatId).toBe(cust.telegramUserId);
    }
  });

  it('creates exactly one topic when one customer sends messages simultaneously', async () => {
    const h = new Harness();
    h.tg.topicDelayMs = 10;
    const results = await Promise.all([1, 2, 3].map(() => h.customer(777_001, { username: 'racer' }).send()));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(h.tg.of('createForumTopic')).toHaveLength(1);
    expect(h.store.conversations).toHaveLength(1);
    expect(h.tg.of('copyMessage')).toHaveLength(3);
  });

  it('recreates the topic when it was deleted in Telegram', async () => {
    const h = new Harness();
    await h.customer(888, { username: 'gone' }).send();
    h.tg.failNext(
      'copyMessage',
      new TelegramApiError('copyMessage', 400, 'Bad Request: message thread not found'),
    );
    const r = await h.customer(888, { username: 'gone' }).send();
    expect(r.status).toBe(200);
    expect(h.tg.of('createForumTopic')).toHaveLength(2);
    expect(h.store.messages.at(-1)!.deliveryStatus).toBe('delivered');
  });
});
