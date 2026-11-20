export type MergePlan = {
  sourceId: string;
  targetId: string;
  email: string;
  chatgptSubject: string;
  credentialHash: string;
};

/** All statements execute in one D1 batch (one transaction). */
export function accountMergeQueries(plan: MergePlan) {
  const { sourceId: source, targetId: target, email, chatgptSubject, credentialHash } = plan;
  if (source === target) throw new Error("SAME_ACCOUNT");
  return [
    // A NOT NULL violation aborts the entire batch if either identity changed.
    // A unique source claim also prevents replay/concurrent merges of one account.
    { sql: `INSERT INTO account_merge_guards (source_user_id, target_user_id) VALUES (?, (
      SELECT t.id FROM users t JOIN email_credentials e ON e.user_id = t.id
      WHERE t.id = ? AND t.status = 'active' AND t.role = 'member' AND e.password_hash = ?
      AND EXISTS (SELECT 1 FROM user_identities WHERE user_id = t.id AND provider = 'email' AND provider_subject = ?)
      AND NOT EXISTS (SELECT 1 FROM user_identities WHERE user_id = t.id AND provider = 'chatgpt')
      AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active' AND role = 'member')
      AND EXISTS (SELECT 1 FROM user_identities WHERE user_id = ? AND provider = 'chatgpt' AND provider_subject = ?)
      AND (SELECT COUNT(*) FROM user_identities WHERE user_id = ? AND provider = 'chatgpt') = 1
      AND NOT EXISTS (SELECT 1 FROM user_identities WHERE user_id = ? AND provider = 'email')
      AND NOT EXISTS (SELECT 1 FROM email_credentials WHERE user_id = ?)
    ))`, params: [source, target, credentialHash, email, source, source, chatgptSubject, source, source, source] },
    { sql: `INSERT INTO conversation_members (conversation_id, user_id, role, last_read_message_id, joined_at)
      SELECT conversation_id, ?, role, last_read_message_id, joined_at FROM conversation_members WHERE user_id = ?
      ON CONFLICT(conversation_id, user_id) DO UPDATE SET
      role = CASE WHEN conversation_members.role = 'admin' OR excluded.role = 'admin' THEN 'admin' ELSE conversation_members.role END,
      last_read_message_id = COALESCE(conversation_members.last_read_message_id, excluded.last_read_message_id)`, params: [target, source] },
    { sql: "DELETE FROM conversation_members WHERE user_id = ?", params: [source] },
    { sql: "UPDATE conversations SET created_by = ? WHERE created_by = ?", params: [target, source] },
    { sql: "UPDATE messages SET sender_id = ? WHERE sender_id = ?", params: [target, source] },
    { sql: "UPDATE OR IGNORE friend_codes SET user_id=? WHERE user_id=?", params: [target, source] },
    { sql: "DELETE FROM friend_codes WHERE user_id=?", params: [source] },
    { sql: `UPDATE OR IGNORE friend_requests SET pair=json_array(min(?,recipient_id),max(?,recipient_id)),sender_id=?
      WHERE sender_id=? AND recipient_id<>?`, params: [target,target,target,source,target] },
    { sql: `UPDATE OR IGNORE friend_requests SET pair=json_array(min(?,sender_id),max(?,sender_id)),recipient_id=?
      WHERE recipient_id=? AND sender_id<>?`, params: [target,target,target,source,target] },
    { sql: "DELETE FROM friend_requests WHERE sender_id=? OR recipient_id=?", params: [source,source] },
    { sql: "UPDATE passkey_credentials SET user_id = ? WHERE user_id = ?", params: [target, source] },
    { sql: "UPDATE notification_subscriptions SET user_id = ? WHERE user_id = ?", params: [target, source] },
    { sql: "UPDATE user_identities SET user_id = ? WHERE user_id = ?", params: [target, source] },
    { sql: "DELETE FROM recovery_codes WHERE user_id = ?", params: [source] },
    { sql: "DELETE FROM auth_sessions WHERE user_id IN (?, ?)", params: [source, target] },
    { sql: "DELETE FROM auth_challenges WHERE user_id IN (?, ?)", params: [source, target] },
    { sql: "UPDATE users SET status = 'merged' WHERE id = ?", params: [source] },
  ];
}
