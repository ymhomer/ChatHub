import { cleanTransfers } from '@/lib/server/transfers';

export async function POST() {
  // Only elapsed transfer records are actionable. No caller-controlled IDs or file data.
  try {
    return Response.json({ removed: await cleanTransfers() }, { headers: {'Cache-Control':'no-store'} });
  } catch {
    return Response.json({ error:'Cleanup will be retried.' }, {status:503,headers:{'Cache-Control':'no-store'}});
  }
}
