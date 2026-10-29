import type { Config } from './config/env';
import { getConfig } from './config/env';
import { createSupabase } from './database/supabase';
import { SupabaseStore } from './database/supabase-store';
import type { Store } from './database/store';
import { verifyBearer, verifyWebhookSecret } from './security/webhook-auth';
import { createStaffAuth } from './security/staff-auth';
import { TelegramClient } from './telegram/client';
import type { BotContext } from './telegram/context';
import { processUpdate } from './telegram/handlers';
import type { TelegramApi, TgUpdate } from './telegram/types';
import { createLogger, sanitizeError, type Logger } from './utils/logging';
import { toId } from './utils/validation';

export const MAX_ATTEMPTS = 8;
const LOCK_SECONDS = 120;

export interface AppDeps {
  config: Pick<
    Config,
    | 'TELEGRAM_WEBHOOK_SECRET'
    | 'TELEGRAM_STAFF_GROUP_ID'
    | 'TELEGRAM_ALLOWED_STAFF_IDS'
    | 'TELEGRAM_BOT_USERNAME'
    | 'CRON_SECRET'
  >;
  store: Store;
  telegram: TelegramApi;
  logger: Logger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface HttpRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}
export interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

/** Exponential backoff: 15s, 30s, 60s ... capped at 1h. */
export function backoffSeconds(attempt: number): number {
  return Math.min(15 * 2 ** Math.max(0, attempt - 1), 3600);
}

function makeContext(deps: AppDeps, updateId: string, logger: Logger): BotContext {
  return {
    store: deps.store,
    telegram: deps.telegram,
    staffAuth: createStaffAuth(deps.config.TELEGRAM_STAFF_GROUP_ID, deps.config.TELEGRAM_ALLOWED_STAFF_IDS),
    staffGroupId: deps.config.TELEGRAM_STAFF_GROUP_ID,
    botUsername: deps.config.TELEGRAM_BOT_USERNAME,
    logger,
    now: deps.now ?? (() => new Date()),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    updateId,
  };
}

/** Runs one already-claimed update; marks it processed, or failed with backoff. Returns success. */
async function runClaimed(deps: AppDeps, update: TgUpdate, attempt: number): Promise<boolean> {
  const updateId = toId(update.update_id);
  const started = Date.now();
  const logger = deps.logger.child({ updateId, attempt });
  try {
    await processUpdate(makeContext(deps, updateId, logger), update);
    await deps.store.completeUpdate(updateId);
    logger.info('update processed', { durationMs: Date.now() - started });
    return true;
  } catch (err) {
    const dead = attempt >= MAX_ATTEMPTS;
    const next = new Date((deps.now?.() ?? new Date()).getTime() + backoffSeconds(attempt) * 1000);
    logger.error('update failed', {
      durationMs: Date.now() - started,
      retryCount: attempt,
      dead,
      error: err,
    });
    try {
      await deps.store.failUpdate(updateId, sanitizeError(err), next, dead);
    } catch (persistErr) {
      logger.error('could not persist update failure', { error: persistErr });
    }
    return false;
  }
}

/**
 * Telegram webhook entry point (framework-agnostic so it is unit-testable).
 *  - 401 for a wrong/missing secret, 405 for non-POST, 400 for a malformed body
 *  - 200 for processed / duplicate / in-flight / exhausted updates
 *  - 500 when processing failed and a retry is still allowed, so Telegram redelivers the
 *    stored update (the claim function makes redelivery idempotent)
 */
export async function handleWebhook(deps: AppDeps, req: HttpRequest): Promise<HttpResult> {
  if (req.method !== 'POST') return { status: 405, body: { ok: false } };
  if (
    !verifyWebhookSecret(req.headers['x-telegram-bot-api-secret-token'], deps.config.TELEGRAM_WEBHOOK_SECRET)
  ) {
    deps.logger.warn('webhook rejected: bad secret token');
    return { status: 401, body: { ok: false } };
  }

  const update = req.body as TgUpdate | undefined;
  if (!update || typeof update !== 'object' || !Number.isSafeInteger(update.update_id)) {
    return { status: 400, body: { ok: false, error: 'invalid update' } };
  }
  const updateId = toId(update.update_id);

  let claim;
  try {
    claim = await deps.store.claimUpdate(updateId, update, {
      lockSeconds: LOCK_SECONDS,
      maxAttempts: MAX_ATTEMPTS,
    });
  } catch (err) {
    deps.logger.error('could not claim update', { updateId, error: err });
    return { status: 500, body: { ok: false } }; // nothing persisted yet -> let Telegram retry
  }

  if (claim.result !== 'claimed') {
    deps.logger.info('update skipped', { updateId, claim: claim.result });
    return { status: 200, body: { ok: true, skipped: claim.result } };
  }

  const ok = await runClaimed(deps, update, claim.attempt);
  if (ok || claim.attempt >= MAX_ATTEMPTS) return { status: 200, body: { ok } };
  return { status: 500, body: { ok: false, retry: true } };
}

export interface RetrySummary {
  found: number;
  processed: number;
  failed: number;
  skipped: number;
}

/** Sweeper: re-runs failed / stale-locked updates whose backoff has elapsed. */
export async function runRetries(deps: AppDeps, limit = 20): Promise<RetrySummary> {
  const now = deps.now?.() ?? new Date();
  const pending = await deps.store.listRetryableUpdates(now, limit, LOCK_SECONDS);
  const summary: RetrySummary = { found: pending.length, processed: 0, failed: 0, skipped: 0 };
  for (const item of pending) {
    const claim = await deps.store.claimUpdate(item.updateId, item.payload, {
      lockSeconds: LOCK_SECONDS,
      maxAttempts: MAX_ATTEMPTS,
    });
    if (claim.result !== 'claimed') {
      summary.skipped++;
      continue;
    }
    if (await runClaimed(deps, item.payload as TgUpdate, claim.attempt)) summary.processed++;
    else summary.failed++;
  }
  return summary;
}

export function handleCron(deps: AppDeps, req: HttpRequest): Promise<HttpResult> | HttpResult {
  if (!verifyBearer(req.headers['authorization'], deps.config.CRON_SECRET)) {
    return { status: 401, body: { ok: false } };
  }
  return runRetries(deps).then(
    (summary) => ({ status: 200, body: { ok: true, ...summary } }),
    (err) => {
      deps.logger.error('retry sweep failed', { error: err });
      return { status: 500, body: { ok: false } };
    },
  );
}

/** Production wiring, memoized per serverless instance. */
let production: AppDeps | undefined;
export function getProductionDeps(): AppDeps {
  if (production) return production;
  const config = getConfig();
  production = {
    config,
    store: new SupabaseStore(createSupabase(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY)),
    telegram: new TelegramClient({ token: config.TELEGRAM_BOT_TOKEN }),
    logger: createLogger(config.LOG_LEVEL),
  };
  return production;
}
