import { describe, expect, it } from 'vitest';
import { handleCron, handleWebhook, MAX_ATTEMPTS, runRetries } from '../src/app';
import { TelegramApiError } from '../src/utils/errors';
import { Harness } from './helpers/harness';

describe('webhook authentication & validation', () => {
  it('rejects a wrong or missing secret with 401 and does nothing', async () => {
    const h = new Harness();
    const c = h.customer(1);
    expect((await h.send(c.update, 'wrong')).status).toBe(401);
    expect((await h.send(c.update, null)).status).toBe(401);
    expect((await h.send(c.update, 'x'.repeat(200))).status).toBe(401);
    expect(h.store.updates.size).toBe(0);
    expect(h.tg.calls).toHaveLength(0);
  });

  it('rejects non-POST and malformed bodies', async () => {
    const h = new Harness();
    const headers = { 'x-telegram-bot-api-secret-token': 'test_secret_token_0123456789abcdef' };
    expect((await handleWebhook(h.deps, { method: 'GET', headers, body: {} })).status).toBe(405);
    expect((await handleWebhook(h.deps, { method: 'POST', headers, body: { nope: 1 } })).status).toBe(400);
    expect((await handleWebhook(h.deps, { method: 'POST', headers, body: undefined })).status).toBe(400);
  });
});

describe('idempotency', () => {
  it('processes a duplicate update_id only once (no second topic, message or copy)', async () => {
    const h = new Harness();
    const c = h.customer(10, { username: 'dup' });
    expect((await c.send()).body).toMatchObject({ ok: true });
    const second = await c.send();
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ skipped: 'duplicate' });
    expect(h.store.conversations).toHaveLength(1);
    expect(h.store.messages).toHaveLength(1);
    expect(h.tg.of('createForumTopic')).toHaveLength(1);
    expect(h.tg.of('copyMessage')).toHaveLength(1);
  });

  it('a redelivered Telegram message under a NEW update_id is still deduplicated by message id', async () => {
    const h = new Harness();
    const a = h.customer(11, { username: 'dup2' });
    await a.send();
    const again = { update: { ...a.update, update_id: h.nextUpdateId() } };
    await h.send(again.update);
    expect(h.tg.of('copyMessage')).toHaveLength(1);
  });

  it('concurrent deliveries of the same update are processed once', async () => {
    const h = new Harness();
    const c = h.customer(12, { username: 'par' });
    const rs = await Promise.all([c.send(), c.send(), c.send()]);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(h.tg.of('copyMessage')).toHaveLength(1);
    expect(h.tg.of('createForumTopic')).toHaveLength(1);
  });
});

describe('failure handling and retries', () => {
  it('Telegram outage → 500, stored for retry, message stays pending (never marked delivered)', async () => {
    const h = new Harness();
    h.tg.failNext('createForumTopic', new TelegramApiError('createForumTopic', 502, 'Bad Gateway'));
    const c = h.customer(20, { username: 'flaky' });
    const r = await c.send();
    expect(r.status).toBe(500);
    expect(h.store.messages[0]!.deliveryStatus).toBe('pending');
    expect(h.store.updates.get(String(c.update.update_id))).toMatchObject({ status: 'failed', attempt: 1 });

    // Telegram redelivers: succeeds, no duplicate message row
    const r2 = await c.send();
    expect(r2.status).toBe(200);
    expect(h.store.messages).toHaveLength(1);
    expect(h.store.messages[0]!.deliveryStatus).toBe('delivered');
    expect(h.tg.of('createForumTopic').length).toBe(2); // 1st failed, 2nd succeeded
    expect(h.store.conversations).toHaveLength(1);
  });

  it('429 rate limit is retryable', async () => {
    const h = new Harness();
    h.tg.failNext('copyMessage', new TelegramApiError('copyMessage', 429, 'Too Many Requests', 30));
    const c = h.customer(21);
    expect((await c.send()).status).toBe(500);
    expect((await c.send()).status).toBe(200);
  });

  it('Supabase failure on claim → 500 so Telegram retries; nothing was lost or processed', async () => {
    const h = new Harness();
    const c = h.customer(22);
    h.store.down = true;
    expect((await c.send()).status).toBe(500);
    h.store.down = false;
    expect((await c.send()).status).toBe(200);
    expect(h.tg.of('copyMessage')).toHaveLength(1);
  });

  it('sweeper retries failed updates only after backoff elapsed and marks them processed', async () => {
    const h = new Harness();
    h.tg.failNext('copyMessage', new TelegramApiError('copyMessage', 500, 'oops'));
    const c = h.customer(23, { username: 'sweep' });
    expect((await c.send()).status).toBe(500);

    expect(await runRetries(h.deps)).toMatchObject({ found: 0 }); // backoff not elapsed
    h.nowMs += h.backoff(1) * 1000 + 1;
    const summary = await runRetries(h.deps);
    expect(summary).toMatchObject({ found: 1, processed: 1, failed: 0 });
    expect(h.store.updates.get(String(c.update.update_id))!.status).toBe('processed');
    expect(h.store.messages[0]!.deliveryStatus).toBe('delivered');
    expect(h.tg.of('copyMessage')).toHaveLength(2);
  });

  it('recovers updates stuck in "processing" after a crashed invocation', async () => {
    const h = new Harness();
    const c = h.customer(24);
    await h.store.claimUpdate(String(c.update.update_id), c.update); // claimed, then function died
    expect(await runRetries(h.deps)).toMatchObject({ found: 0 });
    h.nowMs += 121_000;
    expect(await runRetries(h.deps)).toMatchObject({ found: 1, processed: 1 });
  });

  it('gives up after MAX_ATTEMPTS: status dead, 200 so Telegram stops redelivering', async () => {
    const h = new Harness();
    h.tg.failNext('copyMessage', new TelegramApiError('copyMessage', 500, 'down'), 100);
    const c = h.customer(25);
    let status = 0;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      h.nowMs += 4_000_000;
      status = (await c.send()).status;
    }
    expect(status).toBe(200);
    expect(h.store.updates.get(String(c.update.update_id))!.status).toBe('dead');
    expect((await c.send()).body).toMatchObject({ skipped: 'dead' });
  });

  it('permanent Telegram rejection of a customer message marks it failed and informs the customer', async () => {
    const h = new Harness();
    h.tg.failNext(
      'copyMessage',
      new TelegramApiError('copyMessage', 400, 'Bad Request: something permanent'),
    );
    const r = await h.customer(26).send();
    expect(r.status).toBe(200);
    expect(h.store.messages[0]).toMatchObject({ deliveryStatus: 'failed' });
    expect(h.store.messages[0]!.errorMessage).toContain('permanent');
    expect(String(h.tg.of('sendMessage').at(-1)!.text)).toContain('could not pass');
  });
});

describe('cron endpoint', () => {
  it('requires the bearer secret', async () => {
    const h = new Harness();
    const req = (auth?: string) => ({
      method: 'GET',
      headers: auth ? { authorization: auth } : {},
      body: undefined,
    });
    expect((await handleCron(h.deps, req())).status).toBe(401);
    expect((await handleCron(h.deps, req('Bearer nope'))).status).toBe(401);
    expect((await handleCron(h.deps, req('Bearer cron_secret_0123456789'))).status).toBe(200);
  });
});
