import { env } from "cloudflare:workers";
import { requireAppUser } from "@/lib/server/chat";
import { cleanupAttachments, ensureOrganizerSchema, indexTxt } from "@/lib/server/organizer";
import { readAuthBody, requireSameOrigin } from "@/lib/server/auth-http";
import { filePreview } from "@/lib/file-preview";

export async function GET(request: Request, context: { params: Promise<{ attachmentId: string }> }) {
  try {
    const user = await requireAppUser();
    const { attachmentId } = await context.params;
    const file = await env.DB.prepare(`SELECT a.object_key AS objectKey, a.content_type AS contentType, a.filename, a.bytes
      FROM attachments a JOIN messages m ON m.id=a.message_id
      JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=? WHERE a.id=?`)
      .bind(user.id, attachmentId).first<{ objectKey: string; contentType: string; filename: string; bytes: number }>();
    if (!file) return new Response("Not found", { status: 404 });

    const wantsPreview = new URL(request.url).searchParams.get('preview') === '1';
    const preview = wantsPreview ? filePreview(file.contentType, file.filename) : null;
    if (wantsPreview && !preview) return new Response('Preview unavailable', { status: 415 });
    const filename = encodeURIComponent(file.filename.toWellFormed()).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16));
    const headers = new Headers({
      "Content-Type": preview?.mime ?? "application/octet-stream",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'",
      "Content-Disposition": `${preview && preview.mime !== 'application/octet-stream' ? 'inline' : 'attachment'}; filename*=UTF-8''${filename}`,
      "Accept-Ranges": "bytes",
      "ETag": `"${file.objectKey}"`,
    });
    const rangeHeader = request.headers.get('Range');
    if (rangeHeader && !request.headers.has('If-Range')) {
      const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader);
      if (match && (match[1] || match[2])) {
        const start = match[1] ? Number(match[1]) : Math.max(0, file.bytes - Number(match[2]));
        const end = match[1] && match[2] ? Math.min(Number(match[2]), file.bytes - 1) : file.bytes - 1;
        if (start > end) {
          headers.set('Content-Range', `bytes */${file.bytes}`);
          return new Response(null, { status: 416, headers });
        }
        const length = end - start + 1;
        const object = await env.BUCKET.get(file.objectKey, { range: { offset: start, length } });
        if (!object) return new Response("Not found", { status: 404 });
        headers.set('Content-Range', `bytes ${start}-${end}/${file.bytes}`);
        headers.set('Content-Length', String(length));
        return new Response(object.body, { status: 206, headers });
      }
    }
    const object = await env.BUCKET.get(file.objectKey);
    if (!object) return new Response("Not found", { status: 404 });
    headers.set('Content-Length', String(object.size));
    return new Response(object.body, { headers });
  } catch (error) {
    if (error instanceof Error && error.message === 'UNAUTHENTICATED') return new Response('Not authorized', { status: 401 });
    return new Response('Unable to load file', { status: 500 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ attachmentId: string }> }) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    requireSameOrigin(request);
    const user = await requireAppUser();
    await ensureOrganizerSchema();
    const { attachmentId } = await context.params;
    const data = await readAuthBody(request);
    if (typeof data.text !== 'string' || new TextEncoder().encode(data.text).length > 65536) {
      return Response.json({ error: 'Editable TXT files can be up to 64 KB.' }, { status: 400, headers });
    }
    const owned = `id=? AND lower(filename) LIKE '%.txt' AND message_id IN (
      SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id
      JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=?
      WHERE (CASE WHEN c.type='direct' AND c.id LIKE 'friend_%' THEN m.sender_id ELSE c.created_by END)=cm.user_id
    )`;
    const previous = await env.DB.prepare(`SELECT object_key AS key FROM attachments WHERE ${owned} AND bytes<=65536`)
      .bind(attachmentId, user.id).first<{ key: string }>();
    if (!previous || request.headers.get('If-Match') !== `"${previous.key}"`) {
      return Response.json({ error: 'This TXT changed or is unavailable. Reopen the preview and retry.' }, { status: 409, headers });
    }
    const key = `attachments/txt/${crypto.randomUUID()}`;
    const bytes = new TextEncoder().encode(data.text);
    await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: 'text/plain' } });
    let changed;
    try {
      const [, updated] = await env.DB.batch([
        env.DB.prepare(`INSERT OR IGNORE INTO attachment_cleanup SELECT object_key FROM attachments WHERE ${owned} AND object_key=?`)
          .bind(attachmentId, user.id, previous.key),
        env.DB.prepare(`UPDATE attachments SET object_key=?, bytes=?, content_type='text/plain' WHERE ${owned} AND object_key=?`)
          .bind(key, bytes.length, attachmentId, user.id, previous.key),
        indexTxt(attachmentId, key, data.text),
      ]);
      changed = updated.meta.changes;
    } catch (error) {
      // Check whether the write committed before reclaiming its object.
      await env.DB.prepare(`INSERT OR IGNORE INTO attachment_cleanup SELECT ? WHERE NOT EXISTS (SELECT 1 FROM attachments WHERE object_key=?)`)
        .bind(key, key).run();
      throw error;
    }
    if (!changed) await env.BUCKET.delete(key);
    await cleanupAttachments().catch(() => {});
    return changed ? Response.json({ ok: true }, { headers }) :
      Response.json({ error: 'This TXT changed. Reopen it before editing again.' }, { status: 409, headers });
  } catch {
    return Response.json({ error: 'Could not save this TXT.' }, { status: 400, headers });
  }
}
