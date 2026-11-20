import { requireSameOrigin, readAuthBody } from '@/lib/server/auth-http';
import { requireAppUser } from '@/lib/server/chat';
import { createShare, ensureShares, listShares, revokeShare } from '@/lib/server/shares';

const headers = { 'Cache-Control': 'private, no-store' };

export async function GET() {
  try {
    const user = await requireAppUser();
    await ensureShares();
    return Response.json({ links: await listShares(user.id) }, { headers });
  } catch {
    return Response.json({ error: 'Unable to load sharing links.' }, { status: 400, headers });
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireAppUser();
    const data = await readAuthBody(request);
    await ensureShares();
    if (data.action === 'revoke') {
      await revokeShare(user.id, String(data.token ?? ''));
      return Response.json({ ok: true }, { headers });
    }
    if (data.kind === 'download' || data.kind === 'upload') {
      return Response.json(await createShare(user.id, data.kind, String(data.target ?? ''), Number(data.minutes), data.targets), { headers });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return Response.json({ error: /^(Choose a valid|This file cannot)/.test(message) ? message : 'Unable to change this link.' }, { status: 400, headers });
  }
  return Response.json({ error: 'Invalid request.' }, { status: 400, headers });
}
