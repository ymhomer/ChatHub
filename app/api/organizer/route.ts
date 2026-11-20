import { requireAppUser } from "@/lib/server/chat";
import { previewCommand, executeCommand, searchMessages, updateAnnotation, manageAttachment, convertMessageToTxt, deleteInboxText } from "@/lib/server/organizer";
import { requireSameOrigin, readAuthBody } from "@/lib/server/auth-http";
const headers = { "Cache-Control": "private, no-store" };
function failure(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message === 'UNAUTHENTICATED') return Response.json({ error: 'Please sign in.' }, { status:401, headers });
  const known = /^(Commands only|Unknown |Caption |Filename |Use up to|This |Invalid search|Please organize|Unable to prepare)/.test(message);
  return Response.json({ error: known ? message : 'Content changed or the action could not finish. Refresh and try again.' }, { status:400, headers });
}
export async function GET(request: Request) {
  try {
    const user = await requireAppUser(); const p = new URL(request.url).searchParams;
    return Response.json(await searchMessages(user.id, p.get('q') ?? '', p.get('type') ?? '', p.get('tag') ?? '', Number(p.get('offset') ?? 0)), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireAppUser(); const data = await readAuthBody(request);
    if (data.action === 'preview') return Response.json(await previewCommand(user.id, String(data.sourceId ?? ''), String(data.command ?? ''), String(data.type ?? 'all')), { headers });
    if (data.action === 'confirm' && data.confirmed === true) return Response.json(await executeCommand(user.id, String(data.token ?? '')), { headers });
    if (data.action === 'rename' || data.action === 'delete') {
      await manageAttachment(user.id, String(data.attachmentId ?? ''), data.action, data.filename);
      return Response.json({ ok: true }, { headers });
    }
    if (data.action === 'delete-inbox-text' && data.confirmed === true) {
      await deleteInboxText(user.id, String(data.messageId ?? ''));
      return Response.json({ ok: true }, { headers });
    }
    if (data.action === 'convert-txt') {
      return Response.json(await convertMessageToTxt(user.id, String(data.messageId ?? '')), { headers });
    }
    if (data.action === 'annotate') {
      await updateAnnotation(user.id,String(data.messageId ?? ''),data.caption,data.tags);
      return Response.json({ ok:true }, { headers });
    }
    return Response.json({ error:'Invalid action.' }, { status:400, headers });
  } catch (error) { return failure(error); }
}
