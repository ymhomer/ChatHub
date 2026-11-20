import { env } from 'cloudflare:workers';
import { createMessage } from '@/lib/server/chat';
import { defaultSpace, ensureOrganizerSchema } from '@/lib/server/organizer';

import { MAX_DOWNLOAD_FILES } from '@/lib/share-download';
import { filenameTimestamp } from '@/lib/txt';
import { downloadZip } from '@/lib/server/share-zip';

const maxFile = 10 * 1024 * 1024;
type Share = { token: string; kind: 'download' | 'upload'; ownerId: string; target: string; expires: number; name: string };

export async function ensureShares() {
  await ensureOrganizerSchema();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS file_shares (
    token TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
    name TEXT NOT NULL, expires INTEGER NOT NULL, remaining INTEGER NOT NULL DEFAULT 20
  )`).run();
}

const fields = 'token, owner_id AS ownerId, kind, target, expires, s.name';
const ownedFiles = `FROM attachments a JOIN messages m ON m.id=a.message_id
  JOIN conversations c ON c.id=m.conversation_id
  JOIN conversation_members cm ON cm.conversation_id=c.id
  WHERE a.id=? AND cm.user_id=?
  AND (CASE WHEN c.type='direct' AND c.id LIKE 'friend_%' THEN m.sender_id ELSE c.created_by END)=cm.user_id`;

export async function listShares(user: string) {
  const { results } = await env.DB.prepare(`SELECT ${fields} FROM file_shares s WHERE owner_id=? AND expires>? ORDER BY expires DESC LIMIT 100`)
    .bind(user, Date.now()).all<Share>();
  return results;
}

export async function createShare(user: string, kind: Share['kind'], target: string, minutes: number, targets?: unknown) {
  if (![15, 60, 1440].includes(minutes)) throw new Error('Choose a valid expiry.');
  let name: string;
  if (kind === 'download') {
    const ids = targets === undefined ? [target] : targets;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_DOWNLOAD_FILES ||
      ids.some(id => typeof id !== 'string' || !id || id.length > 100) || new Set(ids).size !== ids.length) {
      throw new Error(`Choose a valid selection of up to ${MAX_DOWNLOAD_FILES} files.`);
    }
    const files = await lookupDownloadFiles(user, ids);
    if (!files) throw new Error('This file cannot be shared. Check the selected files.');
    target = ids.length === 1 ? ids[0] : JSON.stringify(ids);
    name = files.length === 1 ? files[0].filename : `${files.length} files · ZIP`;
  } else {
    target ||= await defaultSpace(user);
    const space = await env.DB.prepare(`SELECT c.title, os.kind FROM organizer_spaces os JOIN conversations c ON c.id=os.conversation_id
      WHERE os.user_id=? AND os.conversation_id=?`).bind(user, target).first<{ title: string; kind: string }>();
    if (!space) throw new Error('Choose a valid destination.');
    name = space.kind === 'default' ? 'Inbox' : space.title;
  }
  const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const expires = Date.now() + minutes * 60000;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM file_shares WHERE owner_id=? AND expires<=?').bind(user, Date.now()),
    env.DB.prepare('INSERT INTO file_shares(token, owner_id, kind, target, name, expires) VALUES (?,?,?,?,?,?)')
      .bind(token, user, kind, target, name, expires),
  ]);
  return { token, kind, expires, name };
}

export async function revokeShare(user: string, token: string) {
  await env.DB.prepare('DELETE FROM file_shares WHERE token=? AND owner_id=?').bind(token, user).run();
}

export async function activeShare(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  await ensureShares();
  return env.DB.prepare(`SELECT ${fields} FROM file_shares s JOIN users u ON u.id=s.owner_id
    WHERE token=? AND expires>? AND u.status='active'`).bind(token, Date.now()).first<Share>();
}

type DownloadFile = { key: string; filename: string };

async function lookupDownloadFiles(user: string, ids: string[]) {
  const statement = env.DB.prepare(`SELECT a.object_key AS key, a.filename ${ownedFiles}`);
  const results = await env.DB.batch<DownloadFile>(ids.map(id => statement.bind(id, user)));
  const files = results.map(result => result.results[0]);
  return files.every(Boolean) ? files : null;
}

function downloadHeaders(name: string, type: string) {
  const filename = encodeURIComponent(name.toWellFormed()).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16));
  return new Headers({
    'Content-Type': type, 'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  });
}

export async function sharedDownload(share: Share) {
  const ids: string[] = share.target.startsWith('[') ? JSON.parse(share.target) : [share.target];
  const files = await lookupDownloadFiles(share.ownerId, ids);
  if (!files) return null;

  if (files.length === 1) {
    const object = await env.BUCKET.get(files[0].key);
    if (!object) return null;
    const headers = downloadHeaders(files[0].filename, 'application/octet-stream');
    headers.set('Content-Length', String(object.size));
    return new Response(object.body, { headers });
  }

  const available = await Promise.all(files.map(file => env.BUCKET.head(file.key)));
  if (available.some(object => !object)) return null;
  const archive = downloadZip(files.map(file => ({
    name: file.filename,
    async open() {
      const object = await env.BUCKET.get(file.key);
      if (!object) throw new Error('A shared file is no longer available.');
      return object.body;
    },
  })));
  return new Response(archive, { headers: downloadHeaders(`ChatHub_${filenameTimestamp()}.zip`, 'application/zip') });
}

export async function receiveSharedFile(share: Share, file: File) {
  if (file.size > maxFile) return false;
  const reserved = await env.DB.prepare('UPDATE file_shares SET remaining=remaining-1 WHERE token=? AND expires>? AND remaining>0')
    .bind(share.token, Date.now()).run();
  if (!reserved.meta.changes) return false;
  try {
    await createMessage(share.ownerId, { conversationId: share.target, body: '', file, saveToSpace: true });
  } catch (error) {
    await env.DB.prepare('UPDATE file_shares SET remaining=remaining+1 WHERE token=?').bind(share.token).run();
    throw error;
  }
  return true;
}
