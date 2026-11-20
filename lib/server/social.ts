import { env } from 'cloudflare:workers';
import { ensureOrganizerSchema } from '@/lib/server/organizer';
import type { DirectChat, FriendRequest, SocialState } from '@/lib/social';

export async function socialState(userId: string): Promise<SocialState> {
  await ensureOrganizerSchema();
  const [code, requests, chats] = await Promise.all([
    getFriendCode(userId),
    env.DB.prepare(`SELECT r.id, u.display_name AS name, r.recipient_id=? AS incoming
      FROM friend_requests r JOIN users u ON u.id=CASE WHEN r.sender_id=? THEN r.recipient_id ELSE r.sender_id END
      WHERE r.state='pending' AND (r.sender_id=? OR r.recipient_id=?) AND u.status='active'
      ORDER BY r.created_at DESC,r.id`).bind(userId,userId,userId,userId).all<FriendRequest>(),
    env.DB.prepare(`SELECT c.id, COALESCE(NULLIF(peer.display_name,''),'ChatHub friend') AS name,
      latest.id AS latestId, latest.sender_id AS latestSender,
      CASE WHEN a.id IS NOT NULL THEN 'Sent a file: ' || a.filename ELSE substr(latest.body,1,120) END AS summary,
      (SELECT COUNT(*) FROM messages newer WHERE newer.conversation_id=c.id AND newer.sender_id<>mine.user_id
        AND (seen.id IS NULL OR (newer.created_at,newer.id)>(seen.created_at,seen.id))) AS unread
      FROM conversation_members mine JOIN conversations c ON c.id=mine.conversation_id AND c.type='direct'
      JOIN conversation_members other ON other.conversation_id=c.id AND other.user_id<>mine.user_id
      JOIN users peer ON peer.id=other.user_id AND peer.status='active'
      LEFT JOIN messages seen ON seen.id=mine.last_read_message_id
      LEFT JOIN messages latest ON latest.id=(SELECT id FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1)
      LEFT JOIN attachments a ON a.message_id=latest.id
      WHERE mine.user_id=? AND c.id LIKE 'friend_%'
      ORDER BY COALESCE(latest.created_at,c.created_at) DESC,c.id`).bind(userId).all<DirectChat>(),
  ]);
  return { code, requests: requests.results.map(r=>({...r,incoming:Boolean(r.incoming)})), chats: chats.results };
}

async function getFriendCode(userId: string) {
  const lookup = env.DB.prepare('SELECT code FROM friend_codes WHERE user_id=?').bind(userId);
  const existing = await lookup.first<{code:string}>();
  if (existing) return existing.code;
  await env.DB.prepare('INSERT OR IGNORE INTO friend_codes(user_id,code) VALUES (?,?)')
    .bind(userId, crypto.randomUUID().replaceAll('-', '')).run();
  return (await lookup.first<{code:string}>())?.code ?? '';
}

export async function inviteFriend(sender: string, input: unknown) {
  await ensureOrganizerSchema();
  const code = typeof input === 'string' ? input.trim().toLowerCase().replaceAll('-', '') : '';
  if (!/^[0-9a-f]{32}$/.test(code)) throw new Error('Enter a valid ChatHub friend code.');
  const recipient = await env.DB.prepare(`SELECT u.id FROM users u JOIN friend_codes f ON f.user_id=u.id WHERE f.code=? AND u.status='active'`).bind(code).first<{id:string}>();
  if (!recipient || recipient.id===sender) throw new Error('This friend code is unavailable.');
  const pair = JSON.stringify([sender,recipient.id].sort());
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO friend_requests(id,pair,sender_id,recipient_id)
    SELECT ?,?,?,? WHERE NOT EXISTS (
      SELECT 1 FROM conversations c JOIN conversation_members a ON a.conversation_id=c.id AND a.user_id=?
      JOIN conversation_members b ON b.conversation_id=c.id AND b.user_id=? WHERE c.type='direct' AND c.id LIKE 'friend_%'
    )`).bind(crypto.randomUUID(),pair,sender,recipient.id,sender,recipient.id).run();
  if (!result.meta.changes) throw new Error('A request or chat already exists. Check your friend requests.');
}

export async function answerFriend(userId: string, id: string, accept: boolean) {
  await ensureOrganizerSchema();
  const request = await env.DB.prepare(`SELECT sender_id FROM friend_requests r JOIN users u ON u.id=r.sender_id
    WHERE r.id=? AND r.recipient_id=? AND r.state='pending' AND u.status='active'`).bind(id,userId).first<{sender_id:string}>();
  if (!request) throw new Error('This friend request is no longer available.');
  if (!accept) {
    await env.DB.prepare("DELETE FROM friend_requests WHERE id=? AND recipient_id=? AND state='pending'").bind(id,userId).run();
    return;
  }
  const chat = 'friend_' + id;
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO conversations(id,type,created_by)
      SELECT ?,'direct',sender_id FROM friend_requests WHERE id=? AND recipient_id=? AND state='pending'`).bind(chat,id,userId),
    env.DB.prepare(`INSERT OR IGNORE INTO conversation_members(conversation_id,user_id)
      SELECT ?,sender_id FROM friend_requests WHERE id=? AND recipient_id=? AND state='pending'
      UNION ALL SELECT ?,recipient_id FROM friend_requests WHERE id=? AND recipient_id=? AND state='pending'`).bind(chat,id,userId,chat,id,userId),
    env.DB.prepare("DELETE FROM friend_requests WHERE id=? AND recipient_id=? AND state='pending'").bind(id,userId),
  ]);
}

export async function markChatRead(userId: string, chatId: string, messageId: string) {
  if (!chatId.startsWith('friend_')) return;
  await env.DB.prepare(`UPDATE conversation_members AS mine SET last_read_message_id=?
    WHERE mine.user_id=? AND mine.conversation_id=? AND EXISTS (
      SELECT 1 FROM messages m LEFT JOIN messages seen ON seen.id=mine.last_read_message_id
      WHERE m.id=? AND m.conversation_id=mine.conversation_id
      AND (seen.id IS NULL OR (m.created_at,m.id)>(seen.created_at,seen.id))
    )`).bind(messageId,userId,chatId,messageId).run();
}
