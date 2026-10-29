import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getProductionDeps } from '../src/app';

// Reports only booleans: no secrets, no customer data, no error details.
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  let configured = true;
  let database = false;
  try {
    const deps = getProductionDeps();
    await deps.store.ping();
    database = true;
  } catch (err) {
    if (err instanceof Error && err.name === 'RetryableError') configured = true;
    else configured = false;
  }
  const ok = configured && database;
  res.setHeader('cache-control', 'no-store');
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', configured, database });
}
