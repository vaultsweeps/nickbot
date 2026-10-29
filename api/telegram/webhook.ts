import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getProductionDeps, handleWebhook } from '../../src/app';

// Vercel parses the JSON body for us. All work is awaited before responding, so nothing is
// left running after the response (serverless functions may be frozen once it is sent).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  let deps;
  try {
    deps = getProductionDeps();
  } catch {
    // Misconfiguration (details are in `npm run doctor`, never in the response).
    return res.status(500).json({ ok: false });
  }
  const result = await handleWebhook(deps, { method: req.method, headers: req.headers, body: req.body });
  res.status(result.status).json(result.body);
}
