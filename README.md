# Telegram Support Bot (Vercel + Supabase)

Customers chat privately with your bot. Each customer gets **one forum topic** in a staff supergroup; staff answer inside the topic and the bot delivers the answer to the customer. Everything is persisted in Supabase, so restarts, redeploys and cold starts lose nothing.

```
Customer private chat → Telegram webhook → Vercel /api/telegram/webhook → Supabase
        ↑                                                                    ↓
 copyMessage ← routing (topic → conversation → customer) ← staff reply in the customer's topic
```

## How it works

- **Webhook** (`api/telegram/webhook.ts`): checks `X-Telegram-Bot-Api-Secret-Token` (constant-time), stores the raw update in `telegram_updates` (the idempotency key is `update_id`), processes it **inside the request** (nothing runs after the response), then marks it `processed`.
- **Failure handling**: if processing fails, the update is marked `failed` with exponential backoff and the webhook answers `500`, so Telegram redelivers it. Redelivery is idempotent (`claim_telegram_update`). `/api/cron/retry` sweeps failed updates and updates stuck in `processing` after a crashed invocation. After 8 attempts an update becomes `dead` (visible in the table, answered `200` so Telegram stops).
- **Per-message idempotency**: `messages` is unique on `(telegram_chat_id, telegram_message_id)`, `message_mappings` on `(staff_group_id, staff_message_id)`; a message is only marked `delivered` after Telegram confirmed the `copyMessage`.
- **One topic per customer**: `ensure_conversation()` (advisory-lock SQL function) + `claim_topic_creation()` guarantee that simultaneous messages create one conversation and one topic. A partial unique index enforces "one open conversation per customer".
- **Routing**: a staff message is routed **only** via the persisted `(staff_group_id, message_thread_id) → conversation → customer` mapping. If the staff member replied to a specific message, that mapping must belong to the same conversation or the message is refused. Usernames, captions and typed ticket numbers are never trusted.
- **Media**: text, photo, video, document, voice are copied with `copyMessage` (no download/re-upload, no Storage needed). Metadata and `file_id`s are stored. Albums are delivered item by item. Audio, stickers, video notes and animations are politely rejected.
- **Topic title**: `@username | #1000`, else `+91… | #1000` (only if the customer shared it via the contact button), else `Name | #1000`, else `Customer #1000`. Titles are renamed automatically when the username/phone changes; the topic and conversation are kept.
- **Contact sharing**: `/start` offers a `request_contact` button. Only the sender's **own** contact is accepted (`contact.user_id == from.id`) and stored as verified; customers can ignore it.
- **Important Telegram limitation**: staff cannot start a conversation with someone who has never pressed _Start_ on the bot. A customer must write to the bot first; after that staff reply through the topic.

### Staff commands (inside a customer topic)

| Command   | Effect                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------- |
| `/ticket` | ticket number, customer name/@username, Telegram ID, phone (if shared)                         |
| `/close`  | closes the conversation + topic; replies are blocked. A new customer message reopens it again. |
| `/reopen` | reopens it                                                                                     |
| `/help`   | command list                                                                                   |
| `// text` | **internal note**: stored, never sent to the customer                                          |

## Prerequisites

Node.js ≥ 20, a Telegram account, a [Supabase](https://supabase.com) project, a [Vercel](https://vercel.com) account, a GitHub repository (for automatic deploys).

## Setup

### 1. Bot

In Telegram, talk to **@BotFather** → `/newbot`. Keep the token secret. Optional: `/setprivacy` → _Disable_ is **not required** if the bot is an admin of the staff group (admins receive all group messages).

### 2. Staff group

1. Create a group, convert it to a **supergroup**, enable **Topics** (Group settings → Topics).
2. Add the bot as **administrator** with at least **Manage topics** (and permission to post messages).
3. Get the group id (`-100…`): add `@RawDataBot` temporarily or open the group in Telegram Web (`#-100…`).
4. Staff = every human member of the staff group; just add people to the group. Optionally, to restrict it, list numeric user ids (e.g. via `@userinfobot`) in `TELEGRAM_ALLOWED_STAFF_IDS` — then only those ids can answer customers or run commands.

### 3. Supabase

Create a project, then apply the migration (pick one):

- **SQL editor**: paste `supabase/migrations/20261029000000_init.sql` and run it.
- **CLI**: `supabase link --project-ref <ref>` then `supabase db push`.

The migration enables RLS on every table with **no policies** and no grants for `anon`/`authenticated`; only the server (service-role key) can read/write. It can be re-run safely. Copy the project URL and the **service-role/secret** key (Settings → API) — never put it in client code.

### 4. Configuration

```bash
cp .env.example .env     # for local use only; .env is git-ignored
```

| Variable                        | Required | Notes                                                                                                           |
| ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`            | yes      | from BotFather                                                                                                  |
| `TELEGRAM_WEBHOOK_SECRET`       | yes      | 16–256 chars `A-Za-z0-9_-`; `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`    |
| `TELEGRAM_BOT_USERNAME`         | yes      | without `@`                                                                                                     |
| `TELEGRAM_STAFF_GROUP_ID`       | yes      | `-100…`                                                                                                         |
| `TELEGRAM_ALLOWED_STAFF_IDS`    | no       | optional comma-separated numeric ids; empty = all staff-group members are staff                                 |
| `SUPABASE_URL`                  | yes      |                                                                                                                 |
| `SUPABASE_SERVICE_ROLE_KEY`     | yes      | server-side secret                                                                                              |
| `APP_BASE_URL`                  | for CLI  | production origin, `https://…`, used by `webhook:set`                                                           |
| `WEBHOOK_PATH`                  | no       | default `/api/telegram/webhook` (must match the file under `api/`)                                              |
| `CRON_SECRET`                   | yes\*    | ≥16 chars; Vercel sends it as `Authorization: Bearer …` to the cron route. \*Without it the sweeper is disabled |
| `LOG_LEVEL`, `NODE_ENV`, `PORT` | no       | `PORT` only for `npm run dev`                                                                                   |

Missing/invalid variables produce an error listing variable **names** only.

### 5. Local development

```bash
npm install
npm run check        # prettier + eslint + tsc + tests
npm run dev          # local server on :$PORT (use a TEST bot + a tunnel, e.g. cloudflared)
npm run doctor       # validates bot, forum mode, bot admin rights, staff membership
```

### 6. Deploy to Vercel

1. Push to GitHub, **Import Project** in Vercel (framework preset: _Other_; no build command, no output directory).
2. Add all variables above under **Settings → Environment Variables**, scoped to **Production only**. Preview deployments then fail env validation on purpose and can never answer real customers or be registered as the webhook.
3. Deploy, then check `https://<your-domain>/api/health` → `{"status":"ok","configured":true,"database":true}`.
4. Register the webhook **from your machine with production values in `.env`** (`APP_BASE_URL` = production domain):

```bash
npm run webhook:set            # dry run: prints the URL it would register
npm run webhook:set -- --yes   # registers url + secret_token + allowed_updates=["message"]
npm run webhook:info           # getWebhookInfo: url, pending_update_count, last_error_message
```

The scripts never print the token or secret and never use `drop_pending_updates`.

5. End-to-end test: with a second Telegram account press _Start_ on the bot, send a message → a topic appears → reply as an allow-listed staff member → the customer receives it.

> **Cron frequency**: `vercel.json` schedules the retry sweeper **daily** because Vercel Hobby only allows daily crons. On Pro, change `schedule` to e.g. `*/5 * * * *`. Even on Hobby, most failures are healed immediately because Telegram itself redelivers on `500`.

## Testing

```bash
npm test             # 64 tests: routing, idempotency, concurrency, failures, retries, auth, migration
npm run typecheck && npm run lint && npm run format:check
```

Unit/flow tests use an in-memory store and a fake Telegram API. `tests/migration.test.ts` applies the real SQL migration to an in-process PostgreSQL (PGlite) and verifies constraints, RLS, privileges and the SQL functions (`ensure_conversation`, `claim_topic_creation`, `claim_telegram_update`). Run integration tests only against a separate Supabase project — never production data.

## Operations

- **Logs**: Vercel → Project → Logs (filter `/api/telegram/webhook`). Logs are JSON with `updateId`, `conversationId`, `ticket`, `messageType`, `durationMs`, `deliveryStatus`, `retryCount`; tokens, secrets and message text are redacted.
- **Telegram side**: `npm run webhook:info` (look at `last_error_message`, `pending_update_count`).
- **Failed deliveries**: staff see `❌ Not delivered` in the topic for permanent failures (e.g. customer blocked the bot). Inspect in SQL:

```sql
select update_id, status, attempt_count, last_error, next_attempt_at from telegram_updates where status <> 'processed' order by update_id desc;
select id, conversation_id, sender_type, delivery_status, error_message, created_at from messages where delivery_status in ('pending','failed') order by created_at desc;
```

- **Re-run a dead update** (after fixing the cause): `update telegram_updates set status='failed', attempt_count=0, next_attempt_at=now() where update_id = <id>;` then call the sweeper: `curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/retry`.
- **Rollback**: redeploy a previous Vercel deployment (Deployments → ⋯ → Promote). The schema is additive; the webhook URL does not change. To pause the bot: `npm run webhook:delete -- --yes` (pending updates are kept by Telegram for up to 24 h).
- **Rotating secrets**: change `TELEGRAM_WEBHOOK_SECRET` in Vercel, redeploy, then `npm run webhook:set -- --yes`.

## Security

- Webhook authenticated with Telegram's secret token (timing-safe); cron route with a bearer secret.
- Staff authorization by exact group id **and** numeric user-id allow-list; anonymous admin posts are ignored.
- RLS on, no policies, no `anon`/`authenticated` grants; service-role key only in server env vars.
- Secrets validated at start-up, redacted in logs and error messages, `.env` git-ignored.
- Phone numbers are stored only when the customer shares their own contact and are shown only inside the staff group (`/ticket`, topic title).

## Known limitations

- **Exactly-once is impossible across the Telegram boundary**: if `copyMessage` succeeds but the process dies before the DB write, a retry may deliver that one message twice. The message row stays `pending`, so it is observable.
- A topic created just before a crash (before it was saved) can be orphaned; it is harmless but must be deleted by hand.
- Message edits and deletions are not synchronised; albums are delivered as individual messages.
- IDs are handled as strings, but PostgREST returns `bigint` as JSON numbers; the code refuses (throws) rather than silently corrupt an id above 2⁵³ (Telegram ids are < 2⁵²).
- Assignment (`assigned_staff_telegram_id`) exists in the schema but has no command yet; there is no admin UI. A dashboard can be built on the existing tables without schema changes.
- No separate `outbox_jobs` table: `telegram_updates` stores the raw update and acts as the durable retry queue, and every handler step is idempotent.
