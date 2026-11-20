import { requireAppUser } from '@/lib/server/chat';
import { readAuthBody, requireSameOrigin } from '@/lib/server/auth-http';
import { beginFile, closeFolder, createFolder, ensureTransfers, finishFile, publishFolder, transferFolders, uploadStatus, writePart } from '@/lib/server/transfers';

const headers = { 'Cache-Control': 'no-store' };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers });

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message === 'UNAUTHENTICATED') return json({error:'Please sign in.'},401);
  return json({error:/^(This transfer|Enter a folder|You can have|Choose a |Folder expired|The upload part|Upload all|Finish all)/.test(message)
    ? message : 'Transfer could not finish. Please retry.'},400);
}

export async function GET(request: Request) {
  try {
    const user = await requireAppUser();
    await ensureTransfers();
    const file = new URL(request.url).searchParams.get('file');
    return json(file ? await uploadStatus(user.id,file) : {folders:await transferFolders(user.id)});
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireAppUser();
    await ensureTransfers();
    const data = await readAuthBody(request);
    const id = String(data.id ?? '');
    switch (data.action) {
      case 'create': return json({id:await createFolder(user.id,String(data.name ?? ''))},201);
      case 'begin': return json({id:await beginFile(user.id,id,String(data.name ?? ''),Number(data.bytes),String(data.fingerprint ?? ''))},201);
      case 'finish': await finishFile(user.id,id); break;
      case 'publish': await publishFolder(user.id,id,Number(data.minutes)); break;
      case 'close': await closeFolder(user.id,id); break;
      default: return json({error:'Invalid action.'},400);
    }
    return json({ok:true});
  } catch (error) { return failure(error); }
}

export async function PUT(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireAppUser();
    await ensureTransfers();
    const params = new URL(request.url).searchParams;
    await writePart(user.id,params.get('file') ?? '', Number(params.get('part')), request);
    return json({ok:true});
  } catch (error) { return failure(error); }
}
