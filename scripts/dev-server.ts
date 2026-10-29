/**
 * Local development server (no Vercel account needed). Expose it with a tunnel such as
 * `cloudflared tunnel --url http://localhost:3000`, then point APP_BASE_URL at the tunnel
 * and run `npm run webhook:set -- --yes` against a TEST bot only.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { getProductionDeps, handleCron, handleWebhook } from '../src/app';
import { getConfig } from '../src/config/env';

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

const config = getConfig();
const deps = getProductionDeps();

createServer(async (req, res) => {
  const path = (req.url ?? '').split('?')[0];
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  if (path === config.WEBHOOK_PATH) {
    const r = await handleWebhook(deps, {
      method: req.method,
      headers: req.headers,
      body: await readJson(req),
    });
    return send(r.status, r.body);
  }
  if (path === '/api/cron/retry') {
    const r = await handleCron(deps, { method: req.method, headers: req.headers, body: undefined });
    return send(r.status, r.body);
  }
  if (path === '/api/health') return send(200, { status: 'ok' });
  send(404, { ok: false });
}).listen(config.PORT, () => console.log(`dev server listening on :${config.PORT}${config.WEBHOOK_PATH}`));
