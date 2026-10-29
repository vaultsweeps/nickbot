import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Verifies Telegram's X-Telegram-Bot-Api-Secret-Token header in constant time.
 * Both values are hashed first so differing lengths do not leak through timingSafeEqual.
 */
export function verifyWebhookSecret(header: string | string[] | undefined, expected: string): boolean {
  if (typeof header !== 'string' || header.length === 0) return false;
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Same constant-time comparison for "Authorization: Bearer <secret>" (cron endpoint). */
export function verifyBearer(header: string | string[] | undefined, expected: string | undefined): boolean {
  if (!expected || typeof header !== 'string') return false;
  const m = /^Bearer (.+)$/.exec(header);
  return m ? verifyWebhookSecret(m[1], expected) : false;
}
