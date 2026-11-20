import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** A ChatHub account is independent from whichever identity provider signed it in. */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  avatarColor: text("avatar_color").notNull().default("#1b6f5c"),
  role: text("role").notNull().default("member"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** Several verified provider identities may safely point to one ChatHub account. */
export const userIdentities = sqliteTable(
  "user_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    tenantId: text("tenant_id"),
    verifiedAt: text("verified_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_identity_provider_subject").on(table.provider, table.providerSubject),
    index("idx_identity_user").on(table.userId),
  ],
);

export const emailCredentials = sqliteTable("email_credentials", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const authSessions = sqliteTable("auth_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_auth_sessions_user").on(table.userId)]);

export const recoveryCodes = sqliteTable("recovery_codes", {
  codeHash: text("code_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_recovery_codes_user").on(table.userId)]);

export const passkeyCredentials = sqliteTable("passkey_credentials", {
  credentialId: text("credential_id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  transports: text("transports"),
  deviceType: text("device_type"),
  backedUp: integer("backed_up", { mode: "boolean" }).notNull().default(false),
  label: text("label").notNull().default("Passkey"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastUsedAt: text("last_used_at"),
}, (table) => [index("idx_passkeys_user").on(table.userId)]);

export const authChallenges = sqliteTable("auth_challenges", {
  id: text("id").primaryKey(),
  challenge: text("challenge").notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const authRateLimits = sqliteTable("auth_rate_limits", {
  keyHash: text("key_hash").primaryKey(),
  windowStart: text("window_start").notNull(),
  attemptCount: integer("attempt_count").notNull(),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  type: text("type").notNull(), // direct | group
  title: text("title").notNull().default(""),
  createdBy: text("created_by").notNull().references(() => users.id),
  lastMessageAt: text("last_message_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const conversationMembers = sqliteTable(
  "conversation_members",
  {
    conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    lastReadMessageId: text("last_read_message_id"),
    joinedAt: text("joined_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.userId] }),
    index("idx_members_user_conversation").on(table.userId, table.conversationId),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    senderId: text("sender_id").notNull().references(() => users.id),
    body: text("body").notNull().default(""),
    replyToMessageId: text("reply_to_message_id"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_messages_conversation_created").on(table.conversationId, table.createdAt, table.id)],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_attachments_message").on(table.messageId)],
);

export const notificationSubscriptions = sqliteTable(
  "notification_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    subscriptionJson: text("subscription_json").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("uq_notification_endpoint").on(table.endpoint), index("idx_notifications_user").on(table.userId)],
);

/** System type spaces are separate from user-defined search tags. */
export const organizerSpaces = sqliteTable("organizer_spaces", {
  userId: text("user_id").notNull().references(() => users.id),
  kind: text("kind").notNull(),
  conversationId: text("conversation_id").notNull().unique().references(() => conversations.id),
}, t => [primaryKey({ columns: [t.userId,t.kind] })]);
export const messageAnnotations = sqliteTable("message_annotations", {
  messageId: text("message_id").primaryKey().references(() => messages.id, { onDelete:"cascade" }),
  caption: text("caption").notNull().default(""),
  tagsJson: text("tags_json").notNull().default("[]"),
});
export const organizerActions = sqliteTable("organizer_actions", {
  token: text("token").primaryKey(), userId: text("user_id").notNull(), sourceId: text("source_id").notNull(),
  action: text("action").notNull(), planJson: text("plan_json").notNull(), expiresAt: text("expires_at").notNull(),
});
export const organizerReceipts = sqliteTable("organizer_receipts", {
  token: text("token").primaryKey().references(() => organizerActions.token), resultJson: text("result_json").notNull(),
});
export const attachmentCleanup = sqliteTable("attachment_cleanup", { objectKey:text("object_key").primaryKey() });
