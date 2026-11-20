import { TXT_SEARCH_BYTES } from "@/lib/txt";
import { and, eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { conversationMembers } from "@/db/schema";
import { defaultSpace, ensureOrganizerSchema, indexTxt, organizerSpaces, organizerMessages } from "@/lib/server/organizer";
import { normalizeTags, parseCommand } from "@/lib/organizer";
import { requireAuthUser, type AppUser } from "@/lib/server/auth";

export type { AppUser } from "@/lib/server/auth";

export async function requireAppUser(): Promise<AppUser> {
  const user = await requireAuthUser();
  if (!user) throw new Error("UNAUTHENTICATED");
  return user;
}

export async function createPrivateSpace(userId: string) {
  return defaultSpace(userId);
}

export async function assertMember(userId: string, conversationId: string) {
  const db = getDb();
  const [member] = await db.select({ userId: conversationMembers.userId }).from(conversationMembers)
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId))).limit(1);
  if (!member) throw new Error("FORBIDDEN");
}

export const listConversations = organizerSpaces;
export const listMessages = organizerMessages;

export async function createMessage(userId: string, input: { conversationId: string; body: string; file: File | null; caption?: string; tags?: unknown; saveToSpace?: boolean }) {
  const inbox = await defaultSpace(userId);
  const direct = input.conversationId.startsWith('friend_') && await env.DB.prepare(`SELECT 1 FROM conversations c
    JOIN conversation_members peer ON peer.conversation_id=c.id AND peer.user_id<>?
    JOIN users u ON u.id=peer.user_id AND u.status='active' WHERE c.id=? AND c.type='direct'`).bind(userId,input.conversationId).first();
  const ownedSpace = input.saveToSpace && input.file && await env.DB.prepare(
    `SELECT 1 FROM organizer_spaces WHERE user_id=? AND conversation_id=?`
  ).bind(userId, input.conversationId).first();
  if (input.conversationId !== inbox && !direct && !ownedSpace) throw new Error("READ_ONLY_SPACE");
  await assertMember(userId, input.conversationId);
  const body = input.body.trim();
  if (!direct && parseCommand(body)) throw new Error("USE_COMMAND_PREVIEW");
  const caption = input.caption?.trim() ?? "";
  const tags = normalizeTags(input.tags ?? []);
  if (body.length > 20000 || caption.length > 2000) throw new Error("TEXT_TOO_LONG");
  if (!body && !input.file) throw new Error("EMPTY_MESSAGE");
  if (input.file && input.file.size > 10 * 1024 * 1024) throw new Error("FILE_TOO_LARGE");
  await ensureOrganizerSchema();
  const messageId = `msg_${crypto.randomUUID()}`;
  const attachmentId = input.file ? `att_${crypto.randomUUID()}` : null;
  const objectKey = attachmentId ? `attachments/${input.conversationId}/${attachmentId}` : null;
  const now = new Date().toISOString();
  if (input.file && objectKey) await env.BUCKET.put(objectKey, input.file.stream(), { httpMetadata: { contentType: input.file.type || "application/octet-stream" } });
  try {
    const statements = [
      env.DB.prepare(`INSERT INTO messages(id,conversation_id,sender_id,body,created_at) VALUES (?,?,?,?,?)`).bind(messageId,input.conversationId,userId,body,now),
      env.DB.prepare(`INSERT INTO message_annotations(message_id,caption,tags_json) VALUES (?,?,?)`).bind(messageId,caption,JSON.stringify(tags)),
      env.DB.prepare(`UPDATE conversations SET last_message_at=? WHERE id=?`).bind(now,input.conversationId),
    ];
    if (input.file && attachmentId && objectKey) statements.push(env.DB.prepare(`INSERT INTO attachments(id,message_id,object_key,filename,content_type,bytes) VALUES (?,?,?,?,?,?)`).bind(attachmentId,messageId,objectKey,input.file.name.slice(0,255),input.file.type || "application/octet-stream",input.file.size));
    if (input.file && attachmentId && objectKey && /\.txt$/i.test(input.file.name)) {
      statements.push(indexTxt(attachmentId, objectKey, await input.file.slice(0, TXT_SEARCH_BYTES).text()));
    }
    await env.DB.batch(statements);
  } catch (error) {
    if (objectKey) {
      await env.DB.prepare(`INSERT OR IGNORE INTO attachment_cleanup(object_key) VALUES (?)`).bind(objectKey).run();
    }
    throw error;
  }
  return { id: messageId, attachmentId };
}

export async function saveChatAttachment(userId: string, id: string) {
  await ensureOrganizerSchema();
  const file = await env.DB.prepare(`SELECT a.filename, a.content_type AS type, a.object_key AS objectKey, a.bytes,
    COALESCE(n.caption,'') AS caption FROM attachments a JOIN messages m ON m.id=a.message_id
    JOIN conversations c ON c.id=m.conversation_id AND c.type='direct' AND c.id LIKE 'friend_%'
    JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=?
    LEFT JOIN message_annotations n ON n.message_id=m.id WHERE a.id=?`)
    .bind(userId,id).first<{filename:string;type:string;objectKey:string;bytes:number;caption:string}>();
  if (!file || file.bytes > 10 * 1024 * 1024) throw new Error('This attachment is unavailable.');
  const object = await env.BUCKET.get(file.objectKey);
  if (!object) throw new Error('This attachment is unavailable.');
  return createMessage(userId, { conversationId: await defaultSpace(userId), body: '', caption: file.caption,
    file: new File([await object.arrayBuffer()], file.filename, { type: file.type }) });
}
