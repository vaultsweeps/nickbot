import { z } from 'zod';

const csvIds = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().regex(/^\d{1,15}$/, 'must be numeric Telegram user ids')));

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().int().positive().default(3000),
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d{5,}:[A-Za-z0-9_-]{30,}$/, 'does not look like a bot token'),
  // Telegram secret_token: 1-256 chars of A-Z a-z 0-9 _ - ; we additionally demand >= 16.
  TELEGRAM_WEBHOOK_SECRET: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/, '16-256 chars of A-Za-z0-9_-'),
  TELEGRAM_BOT_USERNAME: z
    .string()
    .regex(/^@?[A-Za-z0-9_]{3,}$/)
    .transform((s) => s.replace(/^@/, '')),
  TELEGRAM_STAFF_GROUP_ID: z.string().regex(/^-100\d{5,}$/, 'supergroup ids look like -100XXXXXXXXXX'),
  // Optional: when empty, every human member of the staff group counts as staff.
  TELEGRAM_ALLOWED_STAFF_IDS: z.string().default('').pipe(csvIds),
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  APP_BASE_URL: z
    .string()
    .url()
    .transform((s) => s.replace(/\/+$/, ''))
    .optional(),
  WEBHOOK_PATH: z
    .string()
    .regex(/^\/[A-Za-z0-9/_-]+$/)
    .default('/api/telegram/webhook'),
  CRON_SECRET: z.string().min(16).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = Omit<z.infer<typeof schema>, 'TELEGRAM_ALLOWED_STAFF_IDS'> & {
  TELEGRAM_ALLOWED_STAFF_IDS: string[];
};

export class ConfigError extends Error {}

/** Validates the environment. The error lists variable NAMES and rules only, never values. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty strings (".env.example" style) as missing.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n - ${problems.join('\n - ')}`);
  }
  return parsed.data;
}

let cached: Config | undefined;
/** Memoized per serverless instance (cold start). */
export function getConfig(): Config {
  return (cached ??= loadConfig());
}
