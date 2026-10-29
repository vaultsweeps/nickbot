import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getProductionDeps, handleCron } from '../../src/app';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let deps;
  try {
    deps = getProductionDeps();
  } catch {
    return res.status(500).json({ ok: false });
  }
  const result = await handleCron(deps, { method: req.method, headers: req.headers, body: undefined });
  res.status(result.status).json(result.body);
}
