/**
 * Operator CLI. Usage (env is loaded from .env via `tsx --env-file=.env`):
 *   npm run doctor            validate env, bot, staff group (forum + bot rights)
 *   npm run webhook:info      show getWebhookInfo (no secrets)
 *   npm run webhook:set       register the webhook (requires --yes)
 *   npm run webhook:delete    remove the webhook (requires --yes; never drops pending updates)
 *
 * Secrets are never printed. drop_pending_updates is intentionally never used.
 */
import { loadConfig } from '../src/config/env';
import { TelegramClient } from '../src/telegram/client';
import { redactString } from '../src/utils/logging';

const ALLOWED_UPDATES = ['message'];
const WEBHOOK_SECRET_NAME = 'TELEGRAM_WEBHOOK_SECRET';

async function main() {
  const [cmd = 'doctor', ...flags] = process.argv.slice(2);
  const yes = flags.includes('--yes');
  const config = loadConfig();
  const tg = new TelegramClient({ token: config.TELEGRAM_BOT_TOKEN });

  switch (cmd) {
    case 'doctor': {
      const me = await tg.call<{ id: number; username: string }>('getMe');
      ok(`bot @${me.username} reachable`);
      if (me.username.toLowerCase() !== config.TELEGRAM_BOT_USERNAME.toLowerCase())
        bad(
          `TELEGRAM_BOT_USERNAME (${config.TELEGRAM_BOT_USERNAME}) differs from the real username (${me.username})`,
        );

      const chat = await tg.call<{ title?: string; type: string; is_forum?: boolean }>('getChat', {
        chat_id: Number(config.TELEGRAM_STAFF_GROUP_ID),
      });
      check(
        chat.type === 'supergroup',
        `staff chat "${chat.title}" is a supergroup`,
        'staff chat is not a supergroup',
      );
      check(chat.is_forum, 'Topics are enabled', 'Topics are NOT enabled (Group settings > Topics)');

      const member = await tg.call<{
        status: string;
        can_manage_topics?: boolean;
        can_delete_messages?: boolean;
      }>('getChatMember', { chat_id: Number(config.TELEGRAM_STAFF_GROUP_ID), user_id: me.id });
      check(
        member.status === 'administrator',
        'bot is an administrator',
        'bot must be an administrator of the staff group',
      );
      check(member.can_manage_topics, 'bot has "Manage topics"', 'bot lacks the "Manage topics" admin right');

      for (const id of config.TELEGRAM_ALLOWED_STAFF_IDS) {
        try {
          const m = await tg.call<{ status: string }>('getChatMember', {
            chat_id: Number(config.TELEGRAM_STAFF_GROUP_ID),
            user_id: Number(id),
          });
          check(
            ['creator', 'administrator', 'member'].includes(m.status),
            `staff ${id} is in the group`,
            `staff ${id} is not in the group (${m.status})`,
          );
        } catch {
          bad(`staff ${id}: could not be looked up`);
        }
      }
      check(config.APP_BASE_URL, `APP_BASE_URL = ${config.APP_BASE_URL}`, 'APP_BASE_URL is not set');
      check(
        config.CRON_SECRET,
        'CRON_SECRET set',
        'CRON_SECRET not set (retry endpoint will reject all calls)',
      );
      if (process.exitCode) console.log('\nSome checks failed.');
      break;
    }
    case 'info': {
      const info = await tg.call<Record<string, unknown>>('getWebhookInfo');
      console.log(JSON.stringify(info, null, 2));
      break;
    }
    case 'set-webhook': {
      if (!config.APP_BASE_URL?.startsWith('https://'))
        throw new Error('APP_BASE_URL must be an https:// URL');
      const url = `${config.APP_BASE_URL}${config.WEBHOOK_PATH}`;
      if (!yes) {
        console.log(
          `Would register webhook: ${url}\nallowed_updates: ${ALLOWED_UPDATES.join(',')}\nRe-run with --yes after confirming this is the PRODUCTION domain.`,
        );
        return;
      }
      await tg.call('setWebhook', {
        url,
        secret_token: config[WEBHOOK_SECRET_NAME],
        allowed_updates: ALLOWED_UPDATES,
        max_connections: 20,
      });
      await tg.call('setMyCommands', {
        commands: [{ command: 'start', description: 'Start a conversation with support' }],
        scope: { type: 'all_private_chats' },
      });
      ok(`webhook registered for ${url}`);
      const info = await tg.call<{ url: string; last_error_message?: string; pending_update_count: number }>(
        'getWebhookInfo',
      );
      check(
        info.url === url,
        'getWebhookInfo confirms the URL',
        'getWebhookInfo URL differs from the requested one',
      );
      console.log(
        `pending_update_count=${info.pending_update_count}${info.last_error_message ? ` last_error=${info.last_error_message}` : ''}`,
      );
      break;
    }
    case 'delete-webhook': {
      if (!yes) {
        console.log('Re-run with --yes to delete the webhook (pending updates are kept).');
        return;
      }
      await tg.call('deleteWebhook', { drop_pending_updates: false });
      ok('webhook deleted');
      break;
    }
    default:
      console.log('commands: doctor | info | set-webhook [--yes] | delete-webhook [--yes]');
      process.exitCode = 1;
  }
}

function check(cond: unknown, okMsg: string, badMsg: string) {
  if (cond) ok(okMsg);
  else bad(badMsg);
}
function ok(msg: string) {
  console.log(`  [ok]   ${msg}`);
}
function bad(msg: string) {
  console.log(`  [FAIL] ${msg}`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(redactString(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
