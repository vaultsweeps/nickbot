import { TelegramApiError } from '../utils/errors';
import { redactString } from '../utils/logging';
import { toApiInt, toId } from '../utils/validation';
import type { ReplyMarkup, TelegramApi } from './types';

export interface TelegramClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Max seconds we are willing to wait inline for a 429 before surfacing it as retryable. */
  maxInlineRetryAfter?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramClient implements TelegramApi {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxInlineRetryAfter: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: TelegramClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.maxInlineRetryAfter = opts.maxInlineRetryAfter ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Raw Bot API call. Errors never contain the token (it only lives in the request URL). */
  async call<T>(method: string, params: Record<string, unknown> = {}, attempt = 0): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.telegram.org/bot${this.opts.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.name : 'error';
      throw new TelegramApiError(method, 0, redactString(`network error (${reason})`));
    }

    let body: TgResponse<T>;
    try {
      body = (await res.json()) as TgResponse<T>;
    } catch {
      throw new TelegramApiError(method, res.status || 0, 'non-JSON response');
    }
    if (body.ok) return body.result as T;

    const retryAfter = body.parameters?.retry_after;
    if (
      body.error_code === 429 &&
      retryAfter !== undefined &&
      retryAfter <= this.maxInlineRetryAfter &&
      attempt < 1
    ) {
      await this.sleep(retryAfter * 1000);
      return this.call<T>(method, params, attempt + 1);
    }
    throw new TelegramApiError(
      method,
      body.error_code ?? res.status,
      body.description ?? 'unknown error',
      retryAfter,
    );
  }

  async sendMessage(a: Parameters<TelegramApi['sendMessage']>[0]) {
    const r = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: toApiInt(a.chatId),
      text: a.text,
      ...(a.messageThreadId ? { message_thread_id: toApiInt(a.messageThreadId) } : {}),
      ...(a.replyToMessageId
        ? {
            reply_parameters: { message_id: toApiInt(a.replyToMessageId), allow_sending_without_reply: true },
          }
        : {}),
      ...(a.replyMarkup ? { reply_markup: a.replyMarkup as ReplyMarkup } : {}),
    });
    return { messageId: toId(r.message_id) };
  }

  async copyMessage(a: Parameters<TelegramApi['copyMessage']>[0]) {
    const r = await this.call<{ message_id: number }>('copyMessage', {
      chat_id: toApiInt(a.toChatId),
      from_chat_id: toApiInt(a.fromChatId),
      message_id: toApiInt(a.messageId),
      ...(a.messageThreadId ? { message_thread_id: toApiInt(a.messageThreadId) } : {}),
      ...(a.replyToMessageId
        ? {
            reply_parameters: { message_id: toApiInt(a.replyToMessageId), allow_sending_without_reply: true },
          }
        : {}),
    });
    return { messageId: toId(r.message_id) };
  }

  async createForumTopic(a: { chatId: string; name: string }) {
    const r = await this.call<{ message_thread_id: number }>('createForumTopic', {
      chat_id: toApiInt(a.chatId),
      name: a.name,
    });
    return { messageThreadId: toId(r.message_thread_id) };
  }

  async editForumTopic(a: { chatId: string; messageThreadId: string; name: string }) {
    await this.call('editForumTopic', {
      chat_id: toApiInt(a.chatId),
      message_thread_id: toApiInt(a.messageThreadId),
      name: a.name,
    });
  }

  async closeForumTopic(a: { chatId: string; messageThreadId: string }) {
    await this.call('closeForumTopic', {
      chat_id: toApiInt(a.chatId),
      message_thread_id: toApiInt(a.messageThreadId),
    });
  }

  async reopenForumTopic(a: { chatId: string; messageThreadId: string }) {
    await this.call('reopenForumTopic', {
      chat_id: toApiInt(a.chatId),
      message_thread_id: toApiInt(a.messageThreadId),
    });
  }
}
