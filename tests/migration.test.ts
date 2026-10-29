import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Applies the real migration files to an in-process PostgreSQL (PGlite) and checks the
 * constraints and SQL functions that the application's concurrency guarantees rely on.
 */
const dir = join(__dirname, '..', 'supabase', 'migrations');
let db: PGlite;

const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0]!;
const rejects = async (sql: string, params: unknown[] = []) => {
  try {
    await db.query(sql, params);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected statement to be rejected');
};

beforeAll(async () => {
  db = new PGlite();
  // Supabase provides these roles; emulate them for the grant/revoke statements.
  await db.exec(
    `create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;`,
  );
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.sql'))
    .sort()) {
    await db.exec(readFileSync(join(dir, f), 'utf8'));
  }
});

describe('migrations', () => {
  it('can be applied twice (idempotent)', async () => {
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith('.sql'))
      .sort()) {
      await db.exec(readFileSync(join(dir, f), 'utf8'));
    }
  });

  it('creates all required tables with RLS enabled and no policies', async () => {
    const t = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`,
    );
    expect(t.rows.map((r) => r.relname)).toEqual([
      'conversations',
      'customers',
      'message_mappings',
      'messages',
      'telegram_updates',
    ]);
    expect(t.rows.every((r) => r.relrowsecurity)).toBe(true);
    expect(
      (await one<{ n: number }>(`select count(*)::int n from pg_policies where schemaname = 'public'`)).n,
    ).toBe(0);
  });

  it('gives anon / authenticated no privileges on tables or functions', async () => {
    const tbl = await one<{ n: number }>(
      `select count(*)::int n from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated')`,
    );
    expect(tbl.n).toBe(0);
    const fn = await one<{ a: boolean; s: boolean }>(
      `select has_function_privilege('anon','public.claim_telegram_update(bigint,jsonb,integer,integer)','execute') a,
              has_function_privilege('service_role','public.claim_telegram_update(bigint,jsonb,integer,integer)','execute') s`,
    );
    expect(fn).toEqual({ a: false, s: true });
  });

  it('stores big Telegram ids and enforces customer constraints', async () => {
    await db.query(
      `insert into customers (telegram_user_id, telegram_username, phone_number) values ($1, 'ok_name', '+919876543210')`,
      ['9007199254740993'],
    );
    expect((await one<{ t: string }>(`select telegram_user_id::text t from customers`)).t).toBe(
      '9007199254740993',
    );
    await rejects(`insert into customers (telegram_user_id) values ($1)`, ['9007199254740993']); // unique
    await rejects(`insert into customers (telegram_user_id, telegram_username) values (2, 'bad name!')`);
    await rejects(`insert into customers (telegram_user_id, phone_number) values (3, '12345')`);
  });

  describe('ensure_conversation', () => {
    it('creates one conversation, is idempotent, reopens closed ones, and starts tickets at 1000', async () => {
      const cust = await one<{ id: string }>(
        `insert into customers (telegram_user_id) values (100) returning id`,
      );
      const call = async () =>
        (
          await one<{
            r: {
              conversation: { id: string; ticket_number: number; status: string };
              created: boolean;
              reopened: boolean;
            };
          }>(`select ensure_conversation($1, -1001234567890) r`, [cust.id])
        ).r;

      const a = await call();
      expect(a).toMatchObject({ created: true, reopened: false });
      expect(a.conversation.ticket_number).toBeGreaterThanOrEqual(1000);
      const b = await call();
      expect(b).toMatchObject({ created: false, reopened: false });
      expect(b.conversation.id).toBe(a.conversation.id);

      await db.query(`update conversations set status='closed', closed_at=now() where id=$1`, [
        a.conversation.id,
      ]);
      const c = await call();
      expect(c).toMatchObject({ created: false, reopened: true });
      expect(c.conversation.status).toBe('open');
      expect(
        (
          await one<{ n: number }>(`select count(*)::int n from conversations where customer_id=$1`, [
            cust.id,
          ])
        ).n,
      ).toBe(1);
    });

    it('DB forbids a second open conversation for the same customer and a topic shared by two conversations', async () => {
      const cust = await one<{ id: string }>(`select id from customers where telegram_user_id = 100`);
      await rejects(`insert into conversations (customer_id, staff_group_id) values ($1, -1001234567890)`, [
        cust.id,
      ]);

      const c2 = await one<{ id: string }>(
        `insert into customers (telegram_user_id) values (101) returning id`,
      );
      const conv2 = await one<{ id: string }>(
        `insert into conversations (customer_id, staff_group_id) values ($1, -1001234567890) returning id`,
        [c2.id],
      );
      await db.query(`update conversations set forum_topic_id = 55 where customer_id = $1`, [cust.id]);
      await rejects(`update conversations set forum_topic_id = 55 where id = $1`, [conv2.id]);
    });

    it('serializes concurrent calls for the same customer', async () => {
      const cust = await one<{ id: string }>(
        `insert into customers (telegram_user_id) values (102) returning id`,
      );
      await Promise.all(
        Array.from({ length: 5 }, () =>
          db.query(`select ensure_conversation($1, -1001234567890)`, [cust.id]),
        ),
      );
      expect(
        (
          await one<{ n: number }>(`select count(*)::int n from conversations where customer_id=$1`, [
            cust.id,
          ])
        ).n,
      ).toBe(1);
    });
  });

  it('claim_topic_creation lets exactly one caller win until the lock expires', async () => {
    const cust = await one<{ id: string }>(
      `insert into customers (telegram_user_id) values (103) returning id`,
    );
    const conv = await one<{ id: string }>(
      `insert into conversations (customer_id, staff_group_id) values ($1, -100999) returning id`,
      [cust.id],
    );
    const claim = async () =>
      (await one<{ c: boolean }>(`select claim_topic_creation($1, 30) c`, [conv.id])).c;
    expect(await claim()).toBe(true);
    expect(await claim()).toBe(false);
    await db.query(
      `update conversations set topic_creating_at = now() - interval '31 seconds' where id = $1`,
      [conv.id],
    );
    expect(await claim()).toBe(true);
    await db.query(`update conversations set forum_topic_id = 9001, topic_creating_at = null where id = $1`, [
      conv.id,
    ]);
    expect(await claim()).toBe(false); // topic exists
  });

  it('claim_telegram_update: claimed → duplicate / in_progress / retry / dead', async () => {
    const claim = async (id: number, max = 3) =>
      (
        await one<{ r: { result: string; attempt: number } }>(
          `select claim_telegram_update($1, '{"update_id":1}'::jsonb, 120, $2) r`,
          [id, max],
        )
      ).r;

    expect(await claim(1)).toEqual({ result: 'claimed', attempt: 1 });
    expect(await claim(1)).toMatchObject({ result: 'in_progress' });
    await db.query(`update telegram_updates set status='failed' where update_id=1`);
    expect(await claim(1)).toEqual({ result: 'claimed', attempt: 2 });
    await db.query(`update telegram_updates set status='processed' where update_id=1`);
    expect(await claim(1)).toMatchObject({ result: 'duplicate' });

    await db.query(
      `update telegram_updates set status='processing', locked_at = now() - interval '5 minutes' where update_id = 1`,
    );
    expect(await claim(1)).toMatchObject({ result: 'claimed', attempt: 3 }); // stale lock reclaimed
    await db.query(`update telegram_updates set status='failed' where update_id=1`);
    expect(await claim(1)).toMatchObject({ result: 'dead' }); // attempts exhausted
    expect(await claim(1)).toMatchObject({ result: 'dead' });
  });

  it('messages are unique per (chat, message) and mappings per (group, staff message)', async () => {
    const cust = await one<{ id: string }>(`select id from customers where telegram_user_id = 100`);
    const conv = await one<{ id: string }>(`select id from conversations where customer_id = $1`, [cust.id]);
    const ins = (mid: number) =>
      db.query(
        `insert into messages (conversation_id, customer_id, sender_type, telegram_chat_id, telegram_message_id, message_type)
         values ($1, $2, 'customer', 100, $3, 'text')`,
        [conv.id, cust.id, mid],
      );
    await ins(1);
    expect(
      await rejects(
        `insert into messages (conversation_id, customer_id, sender_type, telegram_chat_id, telegram_message_id, message_type) values ($1,$2,'customer',100,1,'text')`,
        [conv.id, cust.id],
      ),
    ).toMatch(/unique|duplicate/i);
    await rejects(
      `insert into messages (conversation_id, customer_id, sender_type, telegram_chat_id, telegram_message_id, message_type) values ($1,$2,'bogus',100,2,'text')`,
      [conv.id, cust.id],
    );
    await rejects(
      `insert into messages (conversation_id, customer_id, sender_type, telegram_chat_id, telegram_message_id, message_type) values ($1,$2,'customer',100,3,'sticker')`,
      [conv.id, cust.id],
    );

    const mapIns = () =>
      db.query(
        `insert into message_mappings (conversation_id, customer_id, staff_group_id, forum_topic_id, staff_message_id, customer_chat_id, customer_message_id, mapping_type)
         values ($1,$2,-1001,55,900,100,1,'customer_to_staff')`,
        [conv.id, cust.id],
      );
    await mapIns();
    await rejects(
      `insert into message_mappings (conversation_id, customer_id, staff_group_id, forum_topic_id, staff_message_id, customer_chat_id, customer_message_id, mapping_type) values ($1,$2,-1001,55,900,100,2,'customer_to_staff')`,
      [conv.id, cust.id],
    );
  });
});
