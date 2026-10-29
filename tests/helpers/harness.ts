import { backoffSeconds, handleWebhook, type AppDeps, type HttpResult } from '../../src/app';
import type { TgMessage, TgUpdate } from '../../src/telegram/types';
import { silentLogger } from '../../src/utils/logging';
import { FakeTelegram } from './fake-telegram';
import { MemoryStore } from './memory-store';

export const SECRET = 'test_secret_token_0123456789abcdef';
export const GROUP = '-1001234567890';
export const STAFF_ID = 777;
export const OTHER_MEMBER_ID = 888;
export const BOT = 'support_test_bot';

export class Harness {
  store = new MemoryStore();
  tg = new FakeTelegram();
  private updateSeq = 1;
  private msgSeq = 1;
  nowMs = Date.parse('2026-01-01T00:00:00Z');

  deps: AppDeps = {
    config: {
      TELEGRAM_WEBHOOK_SECRET: SECRET,
      TELEGRAM_STAFF_GROUP_ID: GROUP,
      TELEGRAM_ALLOWED_STAFF_IDS: [String(STAFF_ID)],
      TELEGRAM_BOT_USERNAME: BOT,
      CRON_SECRET: 'cron_secret_0123456789',
    },
    store: this.store,
    telegram: this.tg,
    logger: silentLogger,
    now: () => new Date(this.nowMs),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  };

  constructor() {
    this.store.clock = () => this.nowMs;
  }

  nextUpdateId() {
    return this.updateSeq++;
  }
  nextMessageId() {
    return this.msgSeq++;
  }

  /** `secret` null = send no secret header at all. */
  send(update: TgUpdate, secret: string | null = SECRET): Promise<HttpResult> {
    return handleWebhook(this.deps, {
      method: 'POST',
      headers: secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret },
      body: update,
    });
  }

  /** Customer (private chat) message. chat id == user id. */
  customer(
    userId: number,
    extra: Partial<TgMessage> & { username?: string; first_name?: string } = {},
    updateId = this.nextUpdateId(),
  ) {
    const { username, first_name, ...rest } = extra;
    const update: TgUpdate = {
      update_id: updateId,
      message: {
        message_id: this.nextMessageId(),
        from: { id: userId, first_name: first_name ?? 'Alice', ...(username ? { username } : {}) },
        chat: { id: userId, type: 'private' },
        text: 'hello',
        ...rest,
      },
    };
    return { update, send: () => this.send(update) };
  }

  /** Staff-group message in a topic. */
  staff(
    threadId: number | undefined,
    extra: Partial<TgMessage> = {},
    fromId = STAFF_ID,
    chatId = Number(GROUP),
    updateId = this.nextUpdateId(),
  ) {
    const update: TgUpdate = {
      update_id: updateId,
      message: {
        message_id: this.nextMessageId(),
        from: { id: fromId, first_name: 'Agent', username: 'agent' },
        chat: { id: chatId, type: 'supergroup', is_forum: true },
        text: 'hi from staff',
        ...(threadId !== undefined ? { message_thread_id: threadId, is_topic_message: true } : {}),
        ...extra,
      },
    };
    return { update, send: () => this.send(update) };
  }

  backoff = backoffSeconds;
}
