import { describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/env';
import { verifyBearer, verifyWebhookSecret } from '../src/security/webhook-auth';
import { createStaffAuth } from '../src/security/staff-auth';
import { TelegramClient } from '../src/telegram/client';
import { createLogger, redactString, sanitizeError } from '../src/utils/logging';
import { normalizePhone, parseCommand, toId } from '../src/utils/validation';
import { TelegramApiError } from '../src/utils/errors';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
const validEnv = {
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(32),
  TELEGRAM_BOT_USERNAME: '@my_bot',
  TELEGRAM_STAFF_GROUP_ID: '-1001234567890',
  TELEGRAM_ALLOWED_STAFF_IDS: '1, 2,3',
  SUPABASE_URL: 'https://abc.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(40),
  APP_BASE_URL: 'https://x.vercel.app/',
};

describe('config', () => {
  it('parses and normalizes a valid environment', () => {
    const c = loadConfig(validEnv);
    expect(c.TELEGRAM_BOT_USERNAME).toBe('my_bot');
    expect(c.TELEGRAM_ALLOWED_STAFF_IDS).toEqual(['1', '2', '3']);
    expect(c.APP_BASE_URL).toBe('https://x.vercel.app');
    expect(c.WEBHOOK_PATH).toBe('/api/telegram/webhook');
  });

  it('fails with variable names but never values', () => {
    try {
      loadConfig({ ...validEnv, TELEGRAM_WEBHOOK_SECRET: 'short secret!', SUPABASE_SERVICE_ROLE_KEY: '' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const m = (e as Error).message;
      expect(m).toContain('TELEGRAM_WEBHOOK_SECRET');
      expect(m).toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect(m).not.toContain('short secret!');
    }
  });

  it('requires a supergroup id; the staff id list is optional but must be numeric', () => {
    expect(() => loadConfig({ ...validEnv, TELEGRAM_STAFF_GROUP_ID: '12345' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv, TELEGRAM_ALLOWED_STAFF_IDS: 'abc' })).toThrow(ConfigError);
    expect(loadConfig({ ...validEnv, TELEGRAM_ALLOWED_STAFF_IDS: ' , ' }).TELEGRAM_ALLOWED_STAFF_IDS).toEqual([]);
    expect(loadConfig({ ...validEnv, TELEGRAM_ALLOWED_STAFF_IDS: undefined }).TELEGRAM_ALLOWED_STAFF_IDS).toEqual([]);
  });
});

describe('security helpers', () => {
  it('compares webhook secrets safely', () => {
    expect(verifyWebhookSecret('abc', 'abc')).toBe(true);
    expect(verifyWebhookSecret('abd', 'abc')).toBe(false);
    expect(verifyWebhookSecret(undefined, 'abc')).toBe(false);
    expect(verifyWebhookSecret(['abc'], 'abc')).toBe(false);
    expect(verifyWebhookSecret('', '')).toBe(false);
    expect(verifyBearer('Bearer s3cret', 's3cret')).toBe(true);
    expect(verifyBearer('Bearer s3cret', undefined)).toBe(false);
    expect(verifyBearer('s3cret', 's3cret')).toBe(false);
  });

  it('authorizes staff by exact group id and numeric user id only', () => {
    const a = createStaffAuth('-100123', ['5']);
    expect(a.isStaffGroup('-100123')).toBe(true);
    expect(a.isStaffGroup('-100124')).toBe(false);
    expect(a.isAuthorizedStaff('5')).toBe(true);
    expect(a.isAuthorizedStaff('6')).toBe(false);
  });
});

describe('validation helpers', () => {
  it('handles ids safely', () => {
    expect(toId(123)).toBe('123');
    expect(toId(-1001234567890)).toBe('-1001234567890');
    expect(toId('9007199254740993')).toBe('9007199254740993');
    expect(() => toId(2 ** 60)).toThrow();
    expect(() => toId('12abc')).toThrow();
  });
  it('normalizes phones', () => {
    expect(normalizePhone('+91 98765-43210')).toBe('+919876543210');
    expect(normalizePhone('12')).toBeNull();
    expect(normalizePhone('1'.repeat(20))).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });
  it('parses commands incl. @bot suffix and foreign bots', () => {
    expect(parseCommand('/close', 'mybot')).toEqual({ name: 'close', args: '' });
    expect(parseCommand('/Close@MyBot now', 'mybot')).toEqual({ name: 'close', args: 'now' });
    expect(parseCommand('/close@otherbot', 'mybot')).toBeNull();
    expect(parseCommand('hello /close', 'mybot')).toBeNull();
  });
});

describe('logging', () => {
  it('redacts tokens, secrets and message content', () => {
    const lines: string[] = [];
    const log = createLogger('debug', {}, (l) => lines.push(l));
    log.info(`call to bot${TOKEN}/sendMessage`, {
      webhookSecret: 'zzz',
      text: 'private words',
      updateId: '5',
      error: new Error(`failed ${TOKEN}`),
    });
    const out = lines.join('');
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('zzz');
    expect(out).not.toContain('private words');
    expect(out).toContain('"updateId":"5"');
    expect(redactString(`x ${TOKEN} y`)).toBe('x [REDACTED_TOKEN] y');
    expect(sanitizeError(new Error(`bad ${TOKEN}`))).not.toContain(TOKEN);
  });
});

describe('TelegramClient', () => {
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
  it('maps ids, sends reply_parameters, and returns string ids', async () => {
    const f = vi.fn().mockResolvedValue(ok({ message_id: 42 }));
    const tg = new TelegramClient({ token: TOKEN, fetchImpl: f });
    const r = await tg.copyMessage({
      toChatId: '-1001',
      fromChatId: '5',
      messageId: '9',
      messageThreadId: '7',
      replyToMessageId: '3',
    });
    expect(r).toEqual({ messageId: '42' });
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toContain('/copyMessage');
    expect(JSON.parse(init.body)).toMatchObject({
      chat_id: -1001,
      from_chat_id: 5,
      message_id: 9,
      message_thread_id: 7,
      reply_parameters: { message_id: 3 },
    });
  });

  it('retries a short 429 inline once, then surfaces long ones as retryable errors', async () => {
    const limited = (s: number) =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests',
          parameters: { retry_after: s },
        }),
      );
    const f = vi
      .fn()
      .mockResolvedValueOnce(limited(1))
      .mockResolvedValueOnce(ok({ message_id: 1 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await new TelegramClient({ token: TOKEN, fetchImpl: f, sleep }).sendMessage({ chatId: '1', text: 'x' });
    expect(sleep).toHaveBeenCalledWith(1000);

    const g = vi.fn().mockResolvedValue(limited(60));
    const err = await new TelegramClient({ token: TOKEN, fetchImpl: g, sleep })
      .sendMessage({ chatId: '1', text: 'x' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterSeconds).toBe(60);
  });

  it('wraps transport errors without leaking the token', async () => {
    const f = vi
      .fn()
      .mockRejectedValue(new Error(`connect ECONNRESET https://api.telegram.org/bot${TOKEN}/x`));
    const err = await new TelegramClient({ token: TOKEN, fetchImpl: f })
      .sendMessage({ chatId: '1', text: 'x' })
      .catch((e) => e);
    expect(err.retryable).toBe(true);
    expect(String(err.message)).not.toContain(TOKEN);
  });

  it('treats 4xx as permanent', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 403,
          description: 'Forbidden: bot was blocked by the user',
        }),
      ),
    );
    const err = await new TelegramClient({ token: TOKEN, fetchImpl: f })
      .sendMessage({ chatId: '1', text: 'x' })
      .catch((e) => e);
    expect(err.retryable).toBe(false);
    expect(err.botBlockedOrChatGone).toBe(true);
  });
});
