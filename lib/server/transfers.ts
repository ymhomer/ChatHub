import { env } from 'cloudflare:workers';
import { MAX_TRANSFER_FILE, MAX_TRANSFER_TOTAL, PART_BYTES, TRANSFER_MINUTES, type TransferFile, type TransferFolder } from '@/lib/transfers';

const day = 86400000;
const quota = 4 * MAX_TRANSFER_FILE;
const maxFiles = 20;
const invalid = () => new Error('This transfer is unavailable or has expired.');
let schema: Promise<unknown> | undefined;

export async function ensureTransfers() {
  schema ??= env.DB.batch([
    `CREATE TABLE IF NOT EXISTS temp_folders (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL,
      deadline INTEGER NOT NULL, expires INTEGER, token TEXT UNIQUE, closed INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS temp_folders_owner ON temp_folders(owner,deadline)`,
    `CREATE TABLE IF NOT EXISTS temp_files (
      id TEXT PRIMARY KEY, folder TEXT NOT NULL REFERENCES temp_folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL, bytes INTEGER NOT NULL, fingerprint TEXT NOT NULL, upload TEXT,
      status TEXT NOT NULL DEFAULT 'uploading', created INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS temp_files_folder ON temp_files(folder)`,
    `CREATE TABLE IF NOT EXISTS temp_parts (
      file TEXT NOT NULL REFERENCES temp_files(id) ON DELETE CASCADE, part INTEGER NOT NULL,
      etag TEXT NOT NULL, PRIMARY KEY(file,part)
    )`,
  ].map(sql => env.DB.prepare(sql))).catch((error: unknown) => { schema = undefined; throw error; });
  await schema;
}

const active = 'closed IS NULL AND deadline>? AND (expires IS NULL OR expires>?)';
const draft = active + ' AND expires IS NULL';
const key = (id: string) => 'temporary-transfers/' + id;

export async function transferFolders(owner: string): Promise<TransferFolder[]> {
  const now = Date.now();
  const [folders, files] = await env.DB.batch([
    env.DB.prepare(`SELECT id,name,expires,token FROM temp_folders WHERE owner=? AND ${active} ORDER BY created DESC`).bind(owner, now, now),
    env.DB.prepare(`SELECT x.id,x.folder,x.name,x.bytes,x.status,x.fingerprint FROM temp_files x JOIN temp_folders f ON f.id=x.folder
      WHERE f.owner=? AND ${active} ORDER BY x.created,x.id`).bind(owner, now, now),
  ]);
  const entries = files.results as (TransferFile & { folder: string })[];
  return (folders.results as Omit<TransferFolder,'files'>[]).map(folder => ({
    ...folder, files: entries.filter(file => file.folder === folder.id),
  }));
}

export async function createFolder(owner: string, name: string) {
  name = name.trim();
  if (!name || name.length > 100) throw new Error('Enter a folder name up to 100 characters.');
  const now = Date.now();
  const id = crypto.randomUUID();
  const result = await env.DB.prepare(`INSERT INTO temp_folders(id,owner,name,created,deadline)
    SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM temp_folders WHERE owner=? AND ${active})<5`)
    .bind(id, owner, name, now, now+day, owner, now, now).run();
  if (!result.meta.changes) throw new Error('You can have up to 5 active temporary folders.');
  return id;
}

type Upload = TransferFile & { upload: string | null; folder: string };

async function findUpload(owner: string, id: string) {
  const now = Date.now();
  return env.DB.prepare(`SELECT x.* FROM temp_files x JOIN temp_folders f ON f.id=x.folder
    WHERE x.id=? AND f.owner=? AND ${draft}`).bind(id, owner, now, now).first<Upload>();
}

export async function beginFile(owner: string, folder: string, name: string, bytes: number, fingerprint: string) {
  if (!name.trim() || name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(name) ||
      !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_TRANSFER_FILE || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error('Choose a file from 1 byte to 1 GiB with a valid name.');
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  const result = await env.DB.prepare(`INSERT INTO temp_files(id,folder,name,bytes,fingerprint,created)
    SELECT ?,id,?,?,?,? FROM temp_folders WHERE id=? AND owner=? AND ${draft}
    AND (SELECT COUNT(*) FROM temp_files WHERE folder=?)<?
    AND COALESCE((SELECT SUM(bytes) FROM temp_files WHERE folder=?),0)+?<=?
    AND COALESCE((SELECT SUM(x.bytes) FROM temp_files x JOIN temp_folders f ON f.id=x.folder WHERE f.owner=?),0)+?<=?`)
    .bind(id, name, bytes, fingerprint, now, folder, owner, now, now, folder, maxFiles, folder, bytes, MAX_TRANSFER_TOTAL, owner, bytes, quota).run();
  if (!result.meta.changes) throw new Error('Folder expired or the transfer storage limit was reached.');
  return id;
}

export async function uploadStatus(owner: string, id: string) {
  const file = await findUpload(owner,id);
  if (!file) throw invalid();
  const parts = await env.DB.prepare('SELECT part FROM temp_parts WHERE file=? ORDER BY part').bind(id).all<{part:number}>();
  return { ready: file.status === 'ready', parts: parts.results.map((row: {part:number}) => row.part) };
}

export async function writePart(owner: string, id: string, part: number, request: Request) {
  const file = await findUpload(owner,id);
  const count = file ? Math.ceil(file.bytes/PART_BYTES) : 0;
  if (!file || file.status !== 'uploading' || !Number.isInteger(part) || part < 1 || part > count) throw invalid();
  const bytes = part === count ? file.bytes - (count-1)*PART_BYTES : PART_BYTES;
  if (Number(request.headers.get('Content-Length')) !== bytes || !request.body) throw new Error('The upload part has an incorrect size.');
  let upload = file.upload;
  if (!upload) {
    const created = await env.BUCKET.createMultipartUpload(key(id), { httpMetadata: { contentType: 'application/octet-stream' } });
    const set = await env.DB.prepare('UPDATE temp_files SET upload=? WHERE id=? AND upload IS NULL AND status=\'uploading\'')
      .bind(created.uploadId,id).run();
    if (set.meta.changes) upload = created.uploadId;
    else {
      await created.abort();
      upload = (await findUpload(owner,id))?.upload ?? null;
    }
    if (!upload) throw invalid();
  }
  const uploaded = await env.BUCKET.resumeMultipartUpload(key(id),upload).uploadPart(part, request.body);
  await env.DB.prepare(`INSERT INTO temp_parts(file,part,etag) SELECT id,?,? FROM temp_files
    WHERE id=? AND upload=? AND status='uploading'
    ON CONFLICT(file,part) DO UPDATE SET etag=excluded.etag`).bind(part,uploaded.etag,id,upload).run();
}

export async function finishFile(owner: string, id: string) {
  const file = await findUpload(owner,id);
  if (!file) throw invalid();
  if (file.status === 'ready') return;
  if (!file.upload) throw new Error('Upload all parts first.');
  if (!(await env.BUCKET.head(key(id)))) {
    const { results } = await env.DB.prepare('SELECT part AS partNumber,etag FROM temp_parts WHERE file=? ORDER BY part')
      .bind(id).all<{partNumber:number;etag:string}>();
    if (results.length !== Math.ceil(file.bytes/PART_BYTES)) throw new Error('Upload all parts first.');
    await env.BUCKET.resumeMultipartUpload(key(id),file.upload).complete(results);
  }
  const now = Date.now();
  const done = await env.DB.prepare(`UPDATE temp_files SET status='ready' WHERE id=? AND
    EXISTS (SELECT 1 FROM temp_folders WHERE id=temp_files.folder AND owner=? AND ${draft})`)
    .bind(id,owner,now,now).run();
  if (!done.meta.changes) throw invalid();
}

export async function publishFolder(owner: string, id: string, minutes: number) {
  if (!TRANSFER_MINUTES.includes(minutes)) throw new Error('Choose a valid expiration time.');
  const now = Date.now();
  const expires = now + minutes*60000;
  const token = crypto.randomUUID().replaceAll('-','') + crypto.randomUUID().replaceAll('-','');
  const result = await env.DB.prepare(`UPDATE temp_folders SET token=?,expires=?,deadline=? WHERE id=? AND owner=? AND ${draft}
    AND EXISTS (SELECT 1 FROM temp_files WHERE folder=temp_folders.id)
    AND NOT EXISTS (SELECT 1 FROM temp_files WHERE folder=temp_folders.id AND status<>'ready')`)
    .bind(token,expires,expires,id,owner,now,now).run();
  if (!result.meta.changes) throw new Error('Finish all files in the draft before sharing.');
}

export async function closeFolder(owner: string, id: string) {
  await env.DB.prepare('UPDATE temp_folders SET closed=? WHERE id=? AND owner=? AND closed IS NULL').bind(Date.now(),id,owner).run();
}

export async function publicTransfer(token: string) {
  if (!/^[\da-f]{64}$/.test(token)) return null;
  await ensureTransfers();
  const now = Date.now();
  const folder = await env.DB.prepare(`SELECT f.id,f.name,f.expires FROM temp_folders f JOIN users u ON u.id=f.owner
    WHERE f.token=? AND f.expires>? AND f.closed IS NULL AND u.status='active'`).bind(token,now).first<{id:string;name:string;expires:number}>();
  if (!folder) return null;
  const { results } = await env.DB.prepare("SELECT id,name,bytes FROM temp_files WHERE folder=? AND status='ready' ORDER BY created,id")
    .bind(folder.id).all<Pick<TransferFile,'id'|'name'|'bytes'>>();
  return { ...folder, files: results };
}

export async function transferDownload(file: Pick<TransferFile,'id'|'name'|'bytes'>, request: Request) {
  const rangeHeader = request.headers.get('Range');
  const match = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  const headers = new Headers({
    'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
    'Accept-Ranges':'bytes','Content-Type':'application/octet-stream',
    'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name.toWellFormed()).replace(/[!'()*]/g, c=>'%'+c.charCodeAt(0).toString(16))}`,
  });
  let range: {offset:number;length:number} | undefined;
  if (match && (match[1] || match[2])) {
    const start = match[1] ? Number(match[1]) : Math.max(0,file.bytes-Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]),file.bytes-1) : file.bytes-1;
    if (start > end) {
      headers.set('Content-Range',`bytes */${file.bytes}`);
      return new Response(null,{status:416,headers});
    }
    range = {offset:start,length:end-start+1};
    headers.set('Content-Range',`bytes ${start}-${end}/${file.bytes}`);
  }
  const object = await env.BUCKET.get(key(file.id),range ? {range} : undefined);
  if (!object) return null;
  headers.set('Content-Length',String(range?.length ?? object.size));
  return new Response(object.body,{status:range?206:200,headers});
}

export async function cleanTransfers() {
  await ensureTransfers();
  // Allow requests already streaming a part or completing a file to settle.
  const before = Date.now()-15*60000;
  const { results } = await env.DB.prepare(`SELECT x.id,x.upload,x.status FROM temp_files x JOIN temp_folders f ON f.id=x.folder
    WHERE f.deadline<=? OR f.closed<=? LIMIT 20`).bind(before,before).all<{id:string;upload:string|null;status:string}>();
  for (const file of results) {
    if (file.upload && file.status !== 'ready' && !(await env.BUCKET.head(key(file.id)))) {
      try { await env.BUCKET.resumeMultipartUpload(key(file.id),file.upload).abort(); }
      catch (error) {
        if (!(error instanceof Error) || !/10024|NoSuchUpload|does not exist/i.test(error.message)) throw error;
      }
    }
    await env.BUCKET.delete(key(file.id));
    await env.DB.prepare('DELETE FROM temp_files WHERE id=?').bind(file.id).run();
  }
  await env.DB.prepare(`DELETE FROM temp_folders WHERE (deadline<=? OR closed<=?)
    AND NOT EXISTS (SELECT 1 FROM temp_files WHERE folder=temp_folders.id)`).bind(before,before).run();
  return results.length;
}
