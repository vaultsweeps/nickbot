/**
 * Telegram ids (user, chat, message) are handled as decimal strings everywhere in the domain
 * layer and sent to PostgreSQL BIGINT columns as strings. Telegram guarantees ids fit in 52
 * bits, but values arriving via JSON.parse / PostgREST are JS numbers, so we refuse to
 * continue with an unsafe integer rather than silently corrupt an id.
 */
export function toId(value: string | number | bigint): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Telegram id outside the safe integer range');
    return String(value);
  }
  const s = String(value);
  if (!/^-?\d+$/.test(s)) throw new Error('Invalid Telegram id');
  return s;
}

/** Numeric form for Telegram API calls (message_id must be an integer, chat_id may be either). */
export function toApiInt(id: string): number {
  const n = Number(id);
  if (!Number.isSafeInteger(n)) throw new Error('Telegram id outside the safe integer range');
  return n;
}

/** Normalizes a phone number to "+<digits>" (E.164-like); returns null if implausible. */
export function normalizePhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length < 5 || digits.length > 15) return null;
  return `+${digits}`;
}

export interface ParsedCommand {
  name: string;
  args: string;
}

/**
 * Parses "/cmd", "/cmd args" or "/cmd@botname args". Returns null if the text is not a command
 * or is addressed to a different bot.
 */
export function parseCommand(text: string | undefined, botUsername: string): ParsedCommand | null {
  if (!text) return null;
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const target = m[2];
  if (target && target.toLowerCase() !== botUsername.toLowerCase()) return null;
  return { name: m[1]!.toLowerCase(), args: (m[3] ?? '').trim() };
}
