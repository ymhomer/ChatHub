import { env } from "cloudflare:workers";
import { contentTypes, normalizeTags, TYPE_LABELS, type ChatMessage, type ContentType, type Space, type CommandPreview } from "@/lib/organizer";

import { normalizeTxtSearch, TXT_SEARCH_BYTES, txtFilename } from "@/lib/txt";

let ready: Promise<void> | undefined;
export async function ensureOrganizerSchema() {
  ready ??= Promise.resolve().then(() => env.DB.batch([
    `CREATE TABLE IF NOT EXISTS organizer_spaces (user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id), PRIMARY KEY(user_id,kind), UNIQUE(conversation_id))`,
    `CREATE TABLE IF NOT EXISTS message_annotations (message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, caption TEXT NOT NULL DEFAULT '', tags_json TEXT NOT NULL DEFAULT '[]')`,
    `CREATE TABLE IF NOT EXISTS organizer_actions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, source_id TEXT NOT NULL, action TEXT NOT NULL, plan_json TEXT NOT NULL, expires_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS organizer_receipts (token TEXT PRIMARY KEY REFERENCES organizer_actions(token), result_json TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS friend_codes (user_id TEXT PRIMARY KEY REFERENCES users(id), code TEXT NOT NULL UNIQUE)`,
    `CREATE TABLE IF NOT EXISTS friend_requests (id TEXT PRIMARY KEY, pair TEXT NOT NULL UNIQUE, sender_id TEXT NOT NULL REFERENCES users(id), recipient_id TEXT NOT NULL REFERENCES users(id), state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS friend_requests_recipient ON friend_requests(recipient_id)`,
    `CREATE INDEX IF NOT EXISTS friend_requests_sender ON friend_requests(sender_id)`,
    `CREATE TABLE IF NOT EXISTS attachment_names (attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE, filename TEXT NOT NULL, PRIMARY KEY(attachment_id,filename))`,
    `CREATE TABLE IF NOT EXISTS attachment_txt_search (
      attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
      object_key TEXT NOT NULL, content TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS attachment_cleanup (object_key TEXT PRIMARY KEY)`,
  ].map(sql => env.DB.prepare(sql)))).then(() => {}).catch(error => { ready = undefined; throw error; });
  return ready;
}
const spaceId = (userId: string, kind: string) => `organizer_${userId}_${kind}`;
function spaceStatements(userId: string, kind: string, title: string) {
  const id = spaceId(userId, kind);
  return [
    env.DB.prepare(`INSERT OR IGNORE INTO conversations (id,type,title,created_by) VALUES (?,'group',?,?)`).bind(id, title, userId),
    env.DB.prepare(`INSERT OR IGNORE INTO conversation_members (conversation_id,user_id,role) VALUES (?,?,'admin')`).bind(id, userId),
    env.DB.prepare(`INSERT OR IGNORE INTO organizer_spaces (user_id,kind,conversation_id) VALUES (?,?,?)`).bind(userId, kind, id),
  ];
}
export async function defaultSpace(userId: string) {
  await ensureOrganizerSchema();
  let row = await env.DB.prepare(`SELECT conversation_id AS id FROM organizer_spaces WHERE user_id=? AND kind='default'`).bind(userId).first<{ id: string }>();
  if (row) return row.id;
  // Adopt one existing private space without moving or rewriting any messages.
  const old = await env.DB.prepare(`SELECT c.id FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=? WHERE c.created_by=? AND (c.type<>'direct' OR c.id NOT LIKE 'friend_%') AND (SELECT COUNT(*) FROM conversation_members WHERE conversation_id=c.id)=1 AND NOT EXISTS (SELECT 1 FROM organizer_spaces WHERE conversation_id=c.id) ORDER BY c.created_at,c.id LIMIT 1`).bind(userId, userId).first<{ id: string }>();
  if (old) await env.DB.prepare(`INSERT OR IGNORE INTO organizer_spaces (user_id,kind,conversation_id) VALUES (?,'default',?)`).bind(userId, old.id).run();
  else await env.DB.batch(spaceStatements(userId, 'default', 'Inbox'));
  row = await env.DB.prepare(`SELECT conversation_id AS id FROM organizer_spaces WHERE user_id=? AND kind='default'`).bind(userId).first<{ id: string }>();
  if (!row) throw new Error("Unable to prepare your inbox. Please retry.");
  return row.id;
}
export async function organizerSpaces(userId: string): Promise<Space[]> {
  await defaultSpace(userId);
  const { results } = await env.DB.prepare(`SELECT c.id, c.title, COALESCE(os.kind,'archive') AS kind, cm.role, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) AS count FROM conversation_members cm JOIN conversations c ON c.id=cm.conversation_id LEFT JOIN organizer_spaces os ON os.conversation_id=c.id AND os.user_id=? WHERE cm.user_id=? AND (c.type<>'direct' OR c.id NOT LIKE 'friend_%') ORDER BY CASE os.kind WHEN 'default' THEN 0 WHEN 'video' THEN 1 WHEN 'picture' THEN 2 WHEN 'url' THEN 3 WHEN 'file' THEN 4 ELSE 5 END,c.created_at,c.id`).bind(userId, userId).all<Space>();
  return results.map(s => ({ ...s, title: s.kind === 'default' ? 'Inbox' : s.kind === 'archive' ? (s.title === '我的私人空間' ? 'Saved space' : s.title) : TYPE_LABELS[s.kind] }));
}
const fields = `m.id, m.conversation_id AS conversationId, c.title AS spaceTitle, m.body, m.created_at AS createdAt, m.sender_id AS senderId, u.display_name AS senderName, a.id AS attachmentId, a.filename, a.content_type AS contentType, a.bytes, (CASE WHEN c.type='direct' AND c.id LIKE 'friend_%' THEN m.sender_id=cm.user_id ELSE c.created_by=cm.user_id END) AS canManageFile, COALESCE(n.caption,'') AS caption, COALESCE(n.tags_json,'[]') AS tagsJson, os.kind AS spaceKind`;
const joins = `FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=? JOIN users u ON u.id=m.sender_id LEFT JOIN attachments a ON a.message_id=m.id LEFT JOIN message_annotations n ON n.message_id=m.id LEFT JOIN organizer_spaces os ON os.conversation_id=m.conversation_id AND os.user_id=cm.user_id`;
type Row = Omit<ChatMessage, 'tags' | 'typeTags'> & { tagsJson: string; spaceKind: Space['kind'] };
function mapMessage(row: Row): ChatMessage {
  const { tagsJson, spaceKind, ...message } = row;
  return { ...message, canManageFile: Boolean(row.canManageFile), spaceTitle: spaceKind === 'default' ? 'Inbox' : TYPE_LABELS[spaceKind as ContentType] ?? (row.spaceTitle === '我的私人空間' ? 'Saved space' : row.spaceTitle), tags: JSON.parse(tagsJson), typeTags: contentTypes(row.contentType, row.body, row.caption) };
}
export async function organizerMessages(userId: string, conversationId: string) {
  await ensureOrganizerSchema();
  const member = await env.DB.prepare(`SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?`).bind(conversationId, userId).first();
  if (!member) throw new Error('FORBIDDEN');
  const { results } = await env.DB.prepare(`SELECT ${fields} ${joins} WHERE m.conversation_id=? ORDER BY m.created_at,m.id`).bind(userId, conversationId).all<Row>();
  return results.map(mapMessage);
}
export function indexTxt(attachmentId: string, key: string, content: string) {
  return env.DB.prepare(`INSERT INTO attachment_txt_search(attachment_id,object_key,content)
    SELECT id,object_key,? FROM attachments WHERE id=? AND object_key=?
    ON CONFLICT(attachment_id) DO UPDATE SET object_key=excluded.object_key,content=excluded.content`)
    .bind(normalizeTxtSearch(content), attachmentId, key);
}

async function indexSavedTxt(userId: string) {
  const size = 12;
  const { results } = await env.DB.prepare(`SELECT a.id, a.object_key AS key ${joins}
    LEFT JOIN attachment_txt_search t ON t.attachment_id=a.id AND t.object_key=a.object_key
    WHERE (c.type<>'direct' OR c.id NOT LIKE 'friend_%') AND lower(a.filename) LIKE '%.txt'
      AND t.attachment_id IS NULL LIMIT ?`).bind(userId, size + 1).all<{ id: string; key: string }>();
  if (results.length) {
    const statements = await Promise.all(results.slice(0, size).map(async file => {
      const object = await env.BUCKET.get(file.key, { range: { offset: 0, length: TXT_SEARCH_BYTES } });
      return indexTxt(file.id, file.key, object ? await object.text() : '');
    }));
    await env.DB.batch(statements);
  }
  return results.length > size;
}

export async function convertMessageToTxt(userId: string, id: string) {
  await ensureOrganizerSchema();
  const eligible = `FROM messages m JOIN conversations c ON c.id=m.conversation_id
    JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=?
    WHERE m.id=? AND c.created_by=cm.user_id AND (c.type<>'direct' OR c.id NOT LIKE 'friend_%')
    AND m.body<>'' AND NOT EXISTS (SELECT 1 FROM attachments WHERE message_id=m.id)`;
  const message = await env.DB.prepare(`SELECT m.body ${eligible}`).bind(userId, id).first<{ body: string }>();
  if (!message) throw new Error('This message has already changed or cannot be converted.');
  const attachmentId = `att_${crypto.randomUUID()}`;
  const key = `attachments/txt/${attachmentId}`;
  const bytes = new TextEncoder().encode(message.body);
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: 'text/plain' } });
  let result;
  try {
    result = await env.DB.batch([
      env.DB.prepare(`INSERT INTO attachments(id,message_id,object_key,filename,content_type,bytes)
        SELECT ?,m.id,?,?,'text/plain',? ${eligible} AND m.body=?`)
        .bind(attachmentId, key, txtFilename(), bytes.length, userId, id, message.body),
      env.DB.prepare(`UPDATE messages SET body='' WHERE id=? AND EXISTS (SELECT 1 FROM attachments WHERE id=? AND message_id=?)`)
        .bind(id, attachmentId, id),
      indexTxt(attachmentId, key, new TextDecoder().decode(bytes.slice(0, TXT_SEARCH_BYTES))),
    ]);
  } catch (error) {
    await env.DB.prepare(`INSERT OR IGNORE INTO attachment_cleanup SELECT ? WHERE NOT EXISTS (SELECT 1 FROM attachments WHERE object_key=?)`)
      .bind(key, key).run();
    throw error;
  }
  if (!result[0].meta.changes) {
    await env.BUCKET.delete(key);
    throw new Error('This message has already changed or cannot be converted.');
  }
  return { attachmentId };
}

export async function searchMessages(userId: string, query: string, type = '', tag = '', offset = 0) {
  await defaultSpace(userId);
  if (query.length > 300 || tag.length > 40 || !Number.isInteger(offset) || offset < 0 || offset > 100000 || (type && !Object.hasOwn(TYPE_LABELS,type))) throw new Error('Invalid search filters.');
  const indexing = Boolean(query.trim() && (!type || type === 'file') && !offset && await indexSavedTxt(userId));
  // instr treats %, _ and quotes literally. Never interpolate search text into SQL.
  const clauses = [`(c.type<>'direct' OR c.id NOT LIKE 'friend_%')`, `(?='' OR instr(lower(m.body || ' ' || COALESCE(n.caption,'') || ' ' || COALESCE(a.filename,'') || ' ' || COALESCE(n.tags_json,'')),lower(?))>0 OR EXISTS(SELECT 1 FROM attachment_names h WHERE h.attachment_id=a.id AND instr(lower(h.filename),lower(?))>0) OR (lower(a.filename) LIKE '%.txt' AND EXISTS(
    SELECT 1 FROM attachment_txt_search t WHERE t.attachment_id=a.id AND t.object_key=a.object_key AND instr(t.content,?)>0)))`, `(?='' OR EXISTS(SELECT 1 FROM json_each(COALESCE(n.tags_json,'[]')) WHERE value=?))`];
  if (type === 'picture') clauses.push(`a.content_type LIKE 'image/%'`);
  if (type === 'video') clauses.push(`a.content_type LIKE 'video/%'`);
  if (type === 'file') clauses.push(`a.id IS NOT NULL AND a.content_type NOT LIKE 'image/%' AND a.content_type NOT LIKE 'video/%'`);
  if (type === 'url') clauses.push(`(instr(lower(m.body || ' ' || COALESCE(n.caption,'')),'https://')>0 OR instr(lower(m.body || ' ' || COALESCE(n.caption,'')),'http://')>0)`);
  const { results } = await env.DB.prepare(`SELECT ${fields} ${joins} WHERE ${clauses.join(' AND ')} ORDER BY m.created_at DESC,m.id DESC LIMIT 51 OFFSET ?`).bind(userId, query.trim(), query.trim(), query.trim(), normalizeTxtSearch(query.trim()), tag.trim().toLowerCase(), tag.trim().toLowerCase(), offset).all<Row>();
  return { messages: results.slice(0,50).map(mapMessage), hasMore: results.length > 50, indexing };
}
export async function updateAnnotation(userId: string, messageId: string, caption: unknown, tags: unknown) {
  await ensureOrganizerSchema();
  if (typeof caption !== 'string' || caption.length > 2000) throw new Error('Caption must be at most 2,000 characters.');
  const cleanTags = normalizeTags(tags);
  const result = await env.DB.prepare(`INSERT INTO message_annotations (message_id,caption,tags_json) SELECT m.id,?,? FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN conversation_members cm ON cm.conversation_id=c.id WHERE m.id=? AND cm.user_id=? AND (CASE WHEN c.type='direct' AND c.id LIKE 'friend_%' THEN m.sender_id ELSE c.created_by END)=? ON CONFLICT(message_id) DO UPDATE SET caption=excluded.caption,tags_json=excluded.tags_json`).bind(caption.trim(), JSON.stringify(cleanTags), messageId, userId, userId).run();
  if (!result.meta.changes) throw new Error('This item is no longer available or cannot be edited.');
}
export async function deleteInboxText(userId: string, messageId: string) {
  const inbox = await defaultSpace(userId);
  const deleted = await env.DB.prepare(`DELETE FROM messages
    WHERE id=? AND conversation_id=? AND trim(body)<>''
      AND NOT EXISTS (SELECT 1 FROM attachments WHERE message_id=messages.id)
      AND EXISTS (SELECT 1 FROM conversation_members cm JOIN conversations c ON c.id=cm.conversation_id
        WHERE cm.conversation_id=messages.conversation_id AND cm.user_id=? AND c.created_by=cm.user_id)`)
    .bind(messageId, inbox, userId).run();
  if (!deleted.meta.changes) throw new Error('This Inbox message has changed or is unavailable.');
}

export async function manageAttachment(userId: string, id: string, action: 'rename' | 'delete', value: unknown) {
  await ensureOrganizerSchema();
  const owned = `id=? AND message_id IN (
    SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id
    JOIN conversation_members cm ON cm.conversation_id=c.id
    WHERE (CASE WHEN c.type='direct' AND c.id LIKE 'friend_%' THEN m.sender_id ELSE c.created_by END)=? AND cm.user_id=?
  )`;
  const scoped = [id, userId, userId];
  if (action === 'rename') {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > 255 || name === '.' || name === '..' || /[\x00-\x1f\x7f/\\]/.test(name)) {
      throw new Error('Filename must have 1–255 characters and contain no slashes or control characters.');
    }
    const [, updated] = await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO attachment_names SELECT id,filename FROM attachments WHERE ${owned} AND filename<>?`).bind(...scoped, name),
      env.DB.prepare(`UPDATE attachments SET filename=? WHERE ${owned}`).bind(name, ...scoped),
    ]);
    if (!updated.meta.changes) throw new Error('This file is no longer available or cannot be edited.');
    return;
  }
  const [, removedMessage, deleted] = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO attachment_cleanup SELECT object_key FROM attachments WHERE ${owned}`).bind(...scoped),
    env.DB.prepare(`DELETE FROM messages WHERE id IN (SELECT message_id FROM attachments WHERE ${owned})
      AND conversation_id NOT IN (SELECT id FROM conversations WHERE type='direct' AND id LIKE 'friend_%')
      AND trim(body)='' AND (SELECT COUNT(*) FROM attachments WHERE message_id=messages.id)=1
      AND NOT EXISTS (SELECT 1 FROM message_annotations WHERE message_id=messages.id AND (trim(caption)<>'' OR tags_json<>'[]'))`).bind(...scoped),
    env.DB.prepare(`DELETE FROM attachments WHERE ${owned}`).bind(...scoped),
  ]);
  if (!deleted.meta.changes && !removedMessage.meta.changes) throw new Error('This file is no longer available or cannot be edited.');
  // Remove only empty attachment cards, and keep any saved text, caption or tags.
  await cleanupAttachments().catch(() => {});
}

type Plan = { ids: string[]; targets: Record<string, ContentType>; preview: Omit<CommandPreview,'token'> };
export async function previewCommand(userId: string, sourceId: string, action: string, type: string) {
  if (sourceId !== await defaultSpace(userId)) throw new Error('Commands only work in Inbox.');
  if (action !== 'clear' && action !== 'move') throw new Error('Unknown command.');
  if (action === 'move' && type !== 'all' && !Object.hasOwn(TYPE_LABELS,type)) throw new Error('Unknown content type.');
  const items = await organizerMessages(userId, sourceId);
  const groups: Partial<Record<ContentType, number>> = {};
  const targets: Record<string, ContentType> = {};
  let taken = 0;
  const selected = items.filter(m => {
    if (taken >= 1000) return false;
    if (action === 'clear') { taken++; return true; }
    const target = type === 'all' ? m.typeTags[0] : m.typeTags.includes(type as ContentType) ? type as ContentType : undefined;
    if (!target) return false;
    taken++; targets[m.id] = target; groups[target] = (groups[target] ?? 0) + 1; return true;
  });
  const preview: Plan['preview'] = { action: action as Plan['preview']['action'], count: selected.length, files: selected.filter(m=>m.attachmentId).length, remaining: items.length-selected.length, groups };
  const token = crypto.randomUUID();
  const plan: Plan = { ids: [...new Set(selected.map(m=>m.id))], targets, preview };
  await env.DB.prepare(`INSERT INTO organizer_actions (token,user_id,source_id,action,plan_json,expires_at) VALUES (?,?,?,?,?,?)`).bind(token, userId, sourceId, action, JSON.stringify(plan), new Date(Date.now()+5*60_000).toISOString()).run();
  return { ...preview, token };
}
export async function cleanupAttachments() {
  const { results } = await env.DB.prepare(`SELECT object_key FROM attachment_cleanup LIMIT 50`).all<{ object_key: string }>();
  for (const { object_key } of results) {
    try { await env.BUCKET.delete(object_key); await env.DB.prepare(`DELETE FROM attachment_cleanup WHERE object_key=?`).bind(object_key).run(); }
    catch { /* The durable queue retries during the next command. */ }
  }
}
export async function executeCommand(userId: string, token: string) {
  await ensureOrganizerSchema();
  const action = await env.DB.prepare(`SELECT * FROM organizer_actions WHERE token=? AND user_id=?`).bind(token,userId).first<{ source_id: string; action: string; plan_json: string; expires_at: string }>();
  if (!action) throw new Error('This confirmation is invalid. Run the command again.');
  const receipt = await env.DB.prepare(`SELECT result_json FROM organizer_receipts WHERE token=?`).bind(token).first<{result_json:string}>();
  if (receipt) { await cleanupAttachments(); return JSON.parse(receipt.result_json); }
  if (action.expires_at < new Date().toISOString()) throw new Error('This confirmation expired. Run the command again.');
  if (action.source_id !== await defaultSpace(userId)) throw new Error('Commands only work in Inbox.');
  const plan: Plan = JSON.parse(action.plan_json);
  const statements = [env.DB.prepare(`INSERT INTO organizer_receipts(token,result_json) VALUES (?, CASE WHEN (SELECT COUNT(*) FROM messages WHERE conversation_id=? AND id IN (SELECT value FROM json_each(?)))=? THEN ? ELSE NULL END)`).bind(token,action.source_id,JSON.stringify(plan.ids),plan.ids.length,JSON.stringify(plan.preview))];
  if (action.action === 'move') {
    for (const kind of [...new Set(Object.values(plan.targets))]) statements.push(...spaceStatements(userId,kind,TYPE_LABELS[kind]));
  }
  // Bounded IN groups keep D1's parameter limit below 100, in a single transaction.
  const byTarget = action.action === 'clear' ? { clear: plan.ids } : Object.fromEntries(Object.keys(plan.preview.groups).map(kind => [kind, plan.ids.filter(id=>plan.targets[id]===kind)]));
  for (const [kind,ids] of Object.entries(byTarget)) for (let i=0;i<ids.length;i+=80) {
    const slice=ids.slice(i,i+80); if (!slice.length) continue;
    const condition=`conversation_id=? AND id IN (${slice.map(()=>'?').join(',')})`;
    if (kind === 'clear') {
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO attachment_cleanup(object_key) SELECT object_key FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE ${condition})`).bind(action.source_id,...slice));
      statements.push(env.DB.prepare(`DELETE FROM message_annotations WHERE message_id IN (SELECT id FROM messages WHERE ${condition})`).bind(action.source_id,...slice));
      statements.push(env.DB.prepare(`DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE ${condition})`).bind(action.source_id,...slice));
      statements.push(env.DB.prepare(`DELETE FROM messages WHERE ${condition}`).bind(action.source_id,...slice));
    } else {
      statements.push(env.DB.prepare(`UPDATE messages SET conversation_id=(SELECT conversation_id FROM organizer_spaces WHERE user_id=? AND kind=?) WHERE ${condition}`).bind(userId,kind,action.source_id,...slice));
    }
  }
  try { await env.DB.batch(statements); }
  catch (error) {
    const existing=await env.DB.prepare(`SELECT result_json FROM organizer_receipts WHERE token=?`).bind(token).first<{result_json:string}>();
    if (!existing) throw error;
    return JSON.parse(existing.result_json);
  }
  await cleanupAttachments();
  return plan.preview;
}
