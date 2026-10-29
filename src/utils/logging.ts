export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const SECRET_KEY = /token|secret|key|authorization|password|text|caption|phone/i;
const TOKEN_IN_STRING = /\d{5,}:[A-Za-z0-9_-]{30,}/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

/** Removes anything that looks like a bot token / bearer credential from a string. */
export function redactString(s: string): string {
  return s.replace(TOKEN_IN_STRING, '[REDACTED_TOKEN]').replace(BEARER, 'Bearer [REDACTED]');
}

/** Sanitized, length-capped error description that is safe to log or persist. */
export function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return redactString(msg).slice(0, 500);
}

function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEY.test(k)) out[k] = '[REDACTED]';
    else if (typeof v === 'string') out[k] = redactString(v);
    else if (v instanceof Error) out[k] = sanitizeError(v);
    else out[k] = v;
  }
  return out;
}

export function createLogger(
  level: LogLevel = 'info',
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (l) => console.log(l),
): Logger {
  const emit = (lvl: LogLevel, msg: string, fields: Record<string, unknown> = {}) => {
    if (order[lvl] < order[level]) return;
    sink(
      JSON.stringify({
        level: lvl,
        time: new Date().toISOString(),
        msg: redactString(msg),
        ...redactFields({ ...base, ...fields }),
      }),
    );
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (f) => createLogger(level, { ...base, ...f }, sink),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
