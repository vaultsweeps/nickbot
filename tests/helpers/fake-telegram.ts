import { TelegramApiError } from '../../src/utils/errors';
import type { TelegramApi } from '../../src/telegram/types';

export interface Call {
  method: string;
  args: Record<string, unknown>;
}

/** Fake Bot API: assigns ids, records calls, supports failure injection and latency. */
export class FakeTelegram implements TelegramApi {
  calls: Call[] = [];
  private nextMessageId = 5000;
  private nextTopicId = 100;
  /** method -> queue of errors to throw on next invocations */
  failures = new Map<string, TelegramApiError[]>();
  topicDelayMs = 0;

  failNext(method: string, err: TelegramApiError, times = 1) {
    this.failures.set(
      method,
      Array.from({ length: times }, () => err),
    );
  }

  of(method: string) {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  private async record(method: string, args: Record<string, unknown>) {
    this.calls.push({ method, args });
    const q = this.failures.get(method);
    if (q && q.length > 0) throw q.shift()!;
  }

  async sendMessage(a: Parameters<TelegramApi['sendMessage']>[0]) {
    await this.record('sendMessage', a);
    return { messageId: String(this.nextMessageId++) };
  }
  async copyMessage(a: Parameters<TelegramApi['copyMessage']>[0]) {
    await this.record('copyMessage', a);
    return { messageId: String(this.nextMessageId++) };
  }
  async createForumTopic(a: { chatId: string; name: string }) {
    await this.record('createForumTopic', a);
    if (this.topicDelayMs) await new Promise((r) => setTimeout(r, this.topicDelayMs));
    return { messageThreadId: String(this.nextTopicId++) };
  }
  async editForumTopic(a: { chatId: string; messageThreadId: string; name: string }) {
    await this.record('editForumTopic', a);
  }
  async closeForumTopic(a: { chatId: string; messageThreadId: string }) {
    await this.record('closeForumTopic', a);
  }
  async reopenForumTopic(a: { chatId: string; messageThreadId: string }) {
    await this.record('reopenForumTopic', a);
  }
}
