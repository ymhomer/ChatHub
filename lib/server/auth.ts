import { and, eq, gt, lt } from "drizzle-orm";
import { cookies } from "next/headers";
import { env } from "cloudflare:workers";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { getDb } from "@/db";
import { authChallenges, authSessions, emailCredentials, passkeyCredentials, recoveryCodes, userIdentities, users, conversations, conversationMembers, messages } from "@/db/schema";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { ensureOrganizerSchema } from "@/lib/server/organizer";
import { accountMergeQueries, type MergePlan } from "@/lib/server/account-merge";

const SESSION_COOKIE = "chathub_session";
const SESSION_DAYS = 30;
// Production Sites Workers currently cap PBKDF2 at 100,000 iterations.
const PBKDF2_ITERATIONS = 100_000;
const RP_NAME = "ChatHub";
function passkeyOrigin() {
  return (env as { CHATHUB_FRONTEND_ORIGIN?: string }).CHATHUB_FRONTEND_ORIGIN
    ?? "https://chathub.ymhomer.chatgpt.site";
}
let schemaReady: Promise<void> | undefined;

export type AppUser = { id: string; displayName: string; email: string };

export async function ensureAuthSchema() {
  schemaReady ??= (async () => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS auth_recovery_claims (code_hash TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS account_merge_guards (source_user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id), target_user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS email_credentials (user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE, password_hash TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id)`,
      `CREATE TABLE IF NOT EXISTS recovery_codes (code_hash TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id)`,
      `CREATE TABLE IF NOT EXISTS passkey_credentials (credential_id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0, transports TEXT, device_type TEXT, backed_up INTEGER NOT NULL DEFAULT 0, label TEXT NOT NULL DEFAULT 'Passkey', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT)`,
      `CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkey_credentials(user_id)`,
      `CREATE TABLE IF NOT EXISTS auth_challenges (id TEXT PRIMARY KEY NOT NULL, challenge TEXT NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, purpose TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS auth_rate_limits (key_hash TEXT PRIMARY KEY NOT NULL, window_start TEXT NOT NULL, attempt_count INTEGER NOT NULL)`,
    ];
    for (const statement of statements) await env.DB.prepare(statement).run();
  })().catch((error) => { schemaReady = undefined; throw error; });
  return schemaReady;
}

export async function authRateAllowed(request: Request, scope: string, limit: number, windowMs = 15 * 60_000) {
  await ensureAuthSchema();
  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const keyHash = await sha256(`${scope}:${ip}`);
  const row = await env.DB.prepare(`INSERT INTO auth_rate_limits (key_hash, window_start, attempt_count) VALUES (?1, ?2, 1) ON CONFLICT(key_hash) DO UPDATE SET attempt_count = CASE WHEN window_start < ?3 THEN 1 ELSE attempt_count + 1 END, window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END RETURNING attempt_count`)
    .bind(keyHash, now, cutoff).first<{ attempt_count: number }>();
  return (row?.attempt_count ?? limit + 1) <= limit;
}

function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decodeBase64url(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), char => char.charCodeAt(0));
}

function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64url(value);
}

async function sha256(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password: string) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${base64url(salt)}$${base64url(new Uint8Array(bits))}`;
}

export async function checkPasswordRuntime() {
  const testPassword = "ChatHub-public-runtime-check-only";
  const encoded = await hashPassword(testPassword);
  return verifyPassword(testPassword, encoded);
}

async function verifyPassword(password: string, encoded: string) {
  const [scheme, countText, saltText, expected] = encoded.split("$");
  if (scheme !== "pbkdf2-sha256" || !countText || !saltText || !expected) return false;
  const salt = decodeBase64url(saltText);
  const count = Number(countText);
  if (!Number.isInteger(count) || count < 100_000 || count > 1_000_000) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: count }, key, 256));
  return base64url(bits) === expected;
}

function normalizedEmail(email: string) {
  return email.trim().toLowerCase();
}

function emailValid(email: string) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateRecoveryCodes() {
  return Array.from({ length: 8 }, () => {
    const raw = randomToken(12).toUpperCase().replace(/[-_]/g, "");
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
  });
}



export async function issueSession(userId: string) {
  await ensureAuthSchema();
  const raw = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await getDb().insert(authSessions).values({ tokenHash: await sha256(raw), userId, expiresAt });
  return { cookie: `${SESSION_COOKIE}=${raw}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`, expiresAt };
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function sessionUser(): Promise<AppUser | null> {
  await ensureAuthSchema();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = getDb();
  const [row] = await db.select({ id: users.id, displayName: users.displayName }).from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .where(and(eq(authSessions.tokenHash, await sha256(token)), gt(authSessions.expiresAt, new Date().toISOString()), eq(users.status, "active"))).limit(1);
  if (!row) return null;
  const [emailIdentity] = await db.select({ email: userIdentities.providerSubject }).from(userIdentities)
    .where(and(eq(userIdentities.userId, row.id), eq(userIdentities.provider, "email"))).limit(1);
  return { id: row.id, displayName: row.displayName, email: emailIdentity?.email ?? "" };
}

function initialSpaceQueries(userId: string) {
  const db = getDb();
  const conversationId = `space_${crypto.randomUUID()}`;
  return [
    db.insert(conversations).values({ id: conversationId, type: "group", title: "Inbox", createdBy: userId, lastMessageAt: new Date().toISOString() }),
    db.insert(conversationMembers).values({ conversationId, userId, role: "admin" }),
    db.insert(messages).values({ id: `msg_${crypto.randomUUID()}`, conversationId, senderId: userId, body: "Welcome to your Inbox. Save notes, links and files here, then use /move all to organize them." }),
  ];
}

export async function getAppUser(): Promise<AppUser | null> {
  const session = await sessionUser();
  if (session) return session;
  const identity = await getChatGPTUser();
  if (!identity) return null;
  await ensureAuthSchema();
  const db = getDb();
  const [known] = await db.select({ id: users.id, displayName: users.displayName }).from(userIdentities)
    .innerJoin(users, eq(userIdentities.userId, users.id))
    .where(and(eq(userIdentities.provider, "chatgpt"), eq(userIdentities.providerSubject, identity.id), eq(users.status, "active"))).limit(1);
  if (known) return { ...known, email: identity.email };
  const [matchingEmail] = await db.select({ userId: userIdentities.userId }).from(userIdentities)
    .where(and(eq(userIdentities.provider, "email"), eq(userIdentities.providerSubject, normalizedEmail(identity.email)))).limit(1);
  if (matchingEmail) throw new Error("ACCOUNT_LINK_REQUIRED");
  const userId = `usr_${crypto.randomUUID()}`;
  try {
    await db.batch([
      db.insert(users).values({ id: userId, displayName: identity.displayName }),
      db.insert(userIdentities).values({ id: `ident_${crypto.randomUUID()}`, userId, provider: "chatgpt", providerSubject: identity.id }),
      ...initialSpaceQueries(userId),
    ]);
  } catch (error) {
    // Two parallel first-page requests may race to create the same identity.
    const [created] = await db.select({ id: users.id, displayName: users.displayName }).from(userIdentities)
      .innerJoin(users, eq(userIdentities.userId, users.id))
      .where(and(eq(userIdentities.provider, "chatgpt"), eq(userIdentities.providerSubject, identity.id), eq(users.status, "active"))).limit(1);
    if (created) return { ...created, email: identity.email };
    throw error;
  }
  return { id: userId, displayName: identity.displayName, email: identity.email };
}

export async function requireAuthUser() {
  const user = await getAppUser();
  if (!user) throw new Error("UNAUTHENTICATED");
  return user;
}

export async function registerEmail(emailInput: string, password: string) {
  await ensureAuthSchema();
  const email = normalizedEmail(emailInput);
  if (!emailValid(email)) throw new Error("INVALID_EMAIL");
  if (password.length < 12 || password.length > 128) throw new Error("INVALID_PASSWORD");
  const db = getDb();
  const [existing] = await db.select({ id: userIdentities.id }).from(userIdentities)
    .where(and(eq(userIdentities.provider, "email"), eq(userIdentities.providerSubject, email))).limit(1);
  if (existing) throw new Error("EMAIL_EXISTS");
  const userId = `usr_${crypto.randomUUID()}`;
  const codes = generateRecoveryCodes();
  await db.batch([
    db.insert(users).values({ id: userId, displayName: email }),
    db.insert(userIdentities).values({ id: `ident_${crypto.randomUUID()}`, userId, provider: "email", providerSubject: email }),
    db.insert(emailCredentials).values({ userId, passwordHash: await hashPassword(password) }),
    ...(await Promise.all(codes.map(code => sha256(code.replaceAll("-", "").toUpperCase())))).map(codeHash => db.insert(recoveryCodes).values({ codeHash, userId })),
    ...initialSpaceQueries(userId),
  ]);
  return { user: { id: userId, displayName: email, email }, recoveryCodes: codes, session: await issueSession(userId) };
}

export async function linkEmailCredentials(emailInput: string, password: string) {
  const user = await requireAuthUser();
  await ensureAuthSchema();
  const email = normalizedEmail(emailInput);
  if (!emailValid(email)) throw new Error("INVALID_EMAIL");
  if (password.length < 12 || password.length > 128) throw new Error("INVALID_PASSWORD");
  const db = getDb();
  const [ownEmail] = await db.select({ id: userIdentities.id }).from(userIdentities)
    .where(and(eq(userIdentities.provider, "email"), eq(userIdentities.userId, user.id))).limit(1);
  if (ownEmail) throw new Error("EMAIL_ALREADY_LINKED");
  const [current] = await db.select({ userId: userIdentities.userId }).from(userIdentities)
    .where(and(eq(userIdentities.provider, "email"), eq(userIdentities.providerSubject, email))).limit(1);
  if (current) throw new Error(current.userId === user.id ? "EMAIL_ALREADY_LINKED" : "EMAIL_EXISTS");
  const [hasPassword] = await db.select({ userId: emailCredentials.userId }).from(emailCredentials).where(eq(emailCredentials.userId, user.id)).limit(1);
  if (hasPassword) throw new Error("EMAIL_ALREADY_LINKED");
  const codes = generateRecoveryCodes();
  await db.batch([
    db.insert(userIdentities).values({ id: `ident_${crypto.randomUUID()}`, userId: user.id, provider: "email", providerSubject: email }),
    db.insert(emailCredentials).values({ userId: user.id, passwordHash: await hashPassword(password) }),
    db.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id)),
    ...(await Promise.all(codes.map(code => sha256(code.replaceAll("-", "").toUpperCase())))).map(codeHash => db.insert(recoveryCodes).values({ codeHash, userId: user.id })),
  ]);
  return { recoveryCodes: codes };
}

export async function loginEmail(emailInput: string, password: string) {
  await ensureAuthSchema();
  const email = normalizedEmail(emailInput);
  const db = getDb();
  const [row] = await db.select({ userId: users.id, displayName: users.displayName, passwordHash: emailCredentials.passwordHash })
    .from(userIdentities).innerJoin(users, eq(userIdentities.userId, users.id)).innerJoin(emailCredentials, eq(emailCredentials.userId, users.id))
    .where(and(eq(userIdentities.provider, "email"), eq(userIdentities.providerSubject, email), eq(users.status, "active"))).limit(1);
  if (!row || !(await verifyPassword(password, row.passwordHash))) throw new Error("INVALID_LOGIN");
  return { user: { id: row.userId, displayName: row.displayName, email }, session: await issueSession(row.userId) };
}

export async function recoverEmailPassword(emailInput: string, recoveryCode: string, password: string) {
  await ensureAuthSchema();
  const email = normalizedEmail(emailInput);
  if (password.length < 12 || password.length > 128) throw new Error("INVALID_PASSWORD");
  const db = getDb();
  const codeHash = await sha256(recoveryCode.replaceAll("-", "").replaceAll(" ", "").toUpperCase());
  const [row] = await db.select({ userId: userIdentities.userId }).from(userIdentities).innerJoin(recoveryCodes, eq(recoveryCodes.userId, userIdentities.userId))
    .where(and(eq(userIdentities.provider, "email"), eq(userIdentities.providerSubject, email), eq(recoveryCodes.codeHash, codeHash))).limit(1);
  if (!row) throw new Error("INVALID_RECOVERY");
  const codes = generateRecoveryCodes();
  const passwordHash = await hashPassword(password);
  const hashes = await Promise.all(codes.map(code => sha256(code.replaceAll("-", "").toUpperCase())));
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO auth_recovery_claims(code_hash, user_id) VALUES (?, (SELECT user_id FROM recovery_codes WHERE code_hash = ? AND user_id = ?))").bind(codeHash, codeHash, row.userId),
      env.DB.prepare("UPDATE email_credentials SET password_hash = ?, updated_at = ? WHERE user_id = ?").bind(passwordHash, new Date().toISOString(), row.userId),
      env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(row.userId),
      env.DB.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(row.userId),
      ...hashes.map(hash => env.DB.prepare("INSERT INTO recovery_codes(code_hash, user_id) VALUES (?, ?)").bind(hash, row.userId)),
    ]);
  } catch { throw new Error("INVALID_RECOVERY"); }
  return { recoveryCodes: codes, session: await issueSession(row.userId) };
}

export async function beginChatGPTLink() {
  const user = await requireAuthUser();
  const intent = await saveChallenge("link", user.id, "chatgpt-link");
  return { cookie: `chathub_link_intent=${intent}; Path=/api/auth/link-chatgpt; HttpOnly; Secure; SameSite=Lax; Max-Age=300` };
}

export async function linkChatGPTIdentity() {
  const user = await requireAuthUser();
  const intent = (await cookies()).get("chathub_link_intent")?.value;
  if (!intent) throw new Error("LINK_INTENT_REQUIRED");
  await consumeChallenge(intent, "chatgpt-link", user.id);
  const identity = await getChatGPTUser();
  if (!identity) throw new Error("CHATGPT_SIGNIN_REQUIRED");
  const db = getDb();
  const [existing] = await db.select({ userId: userIdentities.userId }).from(userIdentities)
    .where(and(eq(userIdentities.provider, "chatgpt"), eq(userIdentities.providerSubject, identity.id))).limit(1);
  if (existing?.userId === user.id) return { linked: true };
  const [ownChatGPT] = await db.select({ id: userIdentities.id }).from(userIdentities)
    .where(and(eq(userIdentities.provider, "chatgpt"), eq(userIdentities.userId, user.id))).limit(1);
  if (ownChatGPT) throw new Error("CHATGPT_ALREADY_LINKED");
  if (existing) {
    const proofId = await saveChallenge(JSON.stringify({ sourceId: existing.userId, chatgptSubject: identity.id }), user.id, "merge-chatgpt-proof");
    const [emailIdentity] = await db.select({ email: userIdentities.providerSubject }).from(userIdentities)
      .where(and(eq(userIdentities.userId, user.id), eq(userIdentities.provider, "email"))).limit(1);
    if (!emailIdentity) throw new Error("MERGE_UNSUPPORTED");
    return { mergeRequired: true, proofId, email: emailIdentity.email };
  }
  await db.insert(userIdentities).values({ id: `ident_${crypto.randomUUID()}`, userId: user.id, provider: "chatgpt", providerSubject: identity.id });
  return { linked: true };
}

export async function emailLinkState(emailInput: string) {
  const user = await requireAuthUser();
  const email = normalizedEmail(emailInput);
  if (!emailValid(email)) throw new Error("INVALID_EMAIL");
  const [identity] = await getDb().select({ userId: userIdentities.userId }).from(userIdentities)
    .where(and(eq(userIdentities.provider, "email"), eq(userIdentities.providerSubject, email))).limit(1);
  return { email, state: identity?.userId === user.id ? "linked" : identity ? "existing" : "new" };
}

async function readChallenge(id: string, purpose: string, userId: string) {
  const [row] = await getDb().select().from(authChallenges).where(and(eq(authChallenges.id, id), eq(authChallenges.purpose, purpose), eq(authChallenges.userId, userId))).limit(1);
  if (!row || row.expiresAt < new Date().toISOString()) throw new Error("CHALLENGE_EXPIRED");
  return row.challenge;
}

async function validateMergeAccounts(sourceId: string, targetId: string) {
  const db = getDb();
  const [source] = await db.select().from(users).where(eq(users.id, sourceId)).limit(1);
  const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
  if (!source || !target || source.id === target.id || source.status !== "active" || target.status !== "active" || source.role !== "member" || target.role !== "member") throw new Error("MERGE_UNSUPPORTED");
  const sourceIdentities = await db.select().from(userIdentities).where(eq(userIdentities.userId, sourceId));
  const targetIdentities = await db.select().from(userIdentities).where(eq(userIdentities.userId, targetId));
  if (sourceIdentities.some(x => x.provider === "email") || sourceIdentities.filter(x => x.provider === "chatgpt").length !== 1 || targetIdentities.some(x => x.provider === "chatgpt") || targetIdentities.filter(x => x.provider === "email").length !== 1) throw new Error("MERGE_CONFLICT");
  const [sourceCredential] = await db.select().from(emailCredentials).where(eq(emailCredentials.userId, sourceId)).limit(1);
  if (sourceCredential) throw new Error("MERGE_CONFLICT");
  return sourceIdentities.find(x => x.provider === "chatgpt")!.providerSubject;
}

export async function prepareAccountMerge(emailInput: string, password: string, proofId?: string) {
  const current = await requireAuthUser();
  const email = normalizedEmail(emailInput);
  if (!emailValid(email)) throw new Error("INVALID_EMAIL");
  const db = getDb();
  const [target] = await db.select({ userId: userIdentities.userId, passwordHash: emailCredentials.passwordHash }).from(userIdentities)
    .innerJoin(emailCredentials, eq(emailCredentials.userId, userIdentities.userId))
    .where(and(eq(userIdentities.provider, "email"), eq(userIdentities.providerSubject, email))).limit(1);
  if (!target || !(await verifyPassword(password, target.passwordHash))) throw new Error("INVALID_LOGIN");
  let sourceId = current.id;
  let proofSubject: string | undefined;
  if (proofId) {
    if (target.userId !== current.id) throw new Error("MERGE_CONFLICT");
    const proof = JSON.parse(await readChallenge(proofId, "merge-chatgpt-proof", current.id)) as { sourceId: string; chatgptSubject: string };
    sourceId = proof.sourceId;
    proofSubject = proof.chatgptSubject;
  }
  const chatgptSubject = await validateMergeAccounts(sourceId, target.userId);
  if (proofSubject && proofSubject !== chatgptSubject) throw new Error("MERGE_CONFLICT");
  const plan: MergePlan = { sourceId, targetId: target.userId, email, chatgptSubject, credentialHash: target.passwordHash };
  const token = await saveChallenge(JSON.stringify(plan), current.id, "account-merge");
  if (proofId) await consumeChallenge(proofId, "merge-chatgpt-proof", current.id);
  const count = async (sql: string, id: string) => (await env.DB.prepare(sql).bind(id).first<{ count: number }>())?.count ?? 0;
  return { token, email,
    sourceConversations: await count("SELECT COUNT(*) AS count FROM conversation_members WHERE user_id = ?", sourceId),
    targetConversations: await count("SELECT COUNT(*) AS count FROM conversation_members WHERE user_id = ?", target.userId),
    passkeys: await count("SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = ?", sourceId) + await count("SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = ?", target.userId),
  };
}

export async function confirmAccountMerge(token: string) {
  const current = await requireAuthUser();
  const plan = JSON.parse(await consumeChallenge(token, "account-merge", current.id)) as MergePlan;
  await validateMergeAccounts(plan.sourceId, plan.targetId);
  try {
    await ensureOrganizerSchema();
    await env.DB.batch(accountMergeQueries(plan).map(query => env.DB.prepare(query.sql).bind(...query.params)));
  } catch {
    throw new Error("MERGE_CHANGED");
  }
  return { session: await issueSession(plan.targetId) };
}

export async function authMethods() {
  const user = await requireAuthUser();
  await ensureAuthSchema();
  const db = getDb();
  const identities = await db.select({ provider: userIdentities.provider, value: userIdentities.providerSubject })
    .from(userIdentities).where(eq(userIdentities.userId, user.id));
  const passkeys = await db.select({ credentialId: passkeyCredentials.credentialId, label: passkeyCredentials.label, createdAt: passkeyCredentials.createdAt, lastUsedAt: passkeyCredentials.lastUsedAt })
    .from(passkeyCredentials).where(eq(passkeyCredentials.userId, user.id));
  const [credential] = await db.select({ userId: emailCredentials.userId }).from(emailCredentials)
    .where(eq(emailCredentials.userId, user.id)).limit(1);
  return { user, email: identities.find((x) => x.provider === "email")?.value ?? null, hasPassword: Boolean(credential), chatgptLinked: identities.some((x) => x.provider === "chatgpt"), passkeys };
}

async function saveChallenge(challenge: string, userId: string | null, purpose: string) {
  const id = randomToken(18);
  await getDb().delete(authChallenges).where(lt(authChallenges.expiresAt, new Date().toISOString()));
  await getDb().insert(authChallenges).values({ id, challenge, userId, purpose, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() });
  return id;
}

async function consumeChallenge(id: string, purpose: string, userId: string | null) {
  const row = await env.DB.prepare("DELETE FROM auth_challenges WHERE id = ? AND purpose = ? AND user_id IS ? AND expires_at > ? RETURNING challenge")
    .bind(id, purpose, userId, new Date().toISOString()).first<{ challenge: string }>();
  if (!row) throw new Error("CHALLENGE_EXPIRED");
  return row.challenge;
}

export async function passkeyRegistrationOptions() {
  const user = await requireAuthUser();
  await ensureAuthSchema();
  const db = getDb();
  const credentials = await db.select({ credentialId: passkeyCredentials.credentialId, transports: passkeyCredentials.transports }).from(passkeyCredentials).where(eq(passkeyCredentials.userId, user.id));
  const options = await generateRegistrationOptions({
    rpName: RP_NAME, rpID: new URL(passkeyOrigin()).hostname, userID: new TextEncoder().encode(user.id), userName: user.email,
    userDisplayName: user.displayName, attestationType: "none", supportedAlgorithmIDs: [-7, -257],
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    excludeCredentials: credentials.map((entry) => ({ id: entry.credentialId, transports: JSON.parse(entry.transports ?? "[]") })),
  });
  const challengeId = await saveChallenge(options.challenge, user.id, "passkey-register");
  return { options, challengeId };
}

export async function verifyPasskeyRegistration(challengeId: string, response: Parameters<typeof verifyRegistrationResponse>[0]["response"], label: string) {
  const user = await requireAuthUser();
  const expectedChallenge = await consumeChallenge(challengeId, "passkey-register", user.id);
  const verification = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: passkeyOrigin(), expectedRPID: new URL(passkeyOrigin()).hostname, requireUserVerification: false });
  if (!verification.verified || !verification.registrationInfo) throw new Error("PASSKEY_VERIFICATION_FAILED");
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  await getDb().insert(passkeyCredentials).values({
    credentialId: credential.id, userId: user.id, publicKey: base64url(credential.publicKey),
    counter: credential.counter, transports: JSON.stringify(credential.transports ?? []),
    deviceType: credentialDeviceType, backedUp: credentialBackedUp, label: label.trim().slice(0, 60) || "Passkey",
  });
  return { verified: true };
}

export async function passkeyAuthenticationOptions() {
  await ensureAuthSchema();
  const options = await generateAuthenticationOptions({ rpID: new URL(passkeyOrigin()).hostname, userVerification: "preferred", allowCredentials: [] });
  const challengeId = await saveChallenge(options.challenge, null, "passkey-login");
  return { options, challengeId };
}

export async function verifyPasskeyAuthentication(challengeId: string, response: Parameters<typeof verifyAuthenticationResponse>[0]["response"]) {
  const expectedChallenge = await consumeChallenge(challengeId, "passkey-login", null);
  const credentialId = response.id;
  const db = getDb();
  const [stored] = await db.select().from(passkeyCredentials).where(eq(passkeyCredentials.credentialId, credentialId)).limit(1);
  if (!stored) throw new Error("INVALID_PASSKEY");
  const credential: WebAuthnCredential = {
    id: stored.credentialId,
    publicKey: decodeBase64url(stored.publicKey),
    counter: stored.counter,
    transports: JSON.parse(stored.transports ?? "[]"),
  };
  const verification = await verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin: passkeyOrigin(), expectedRPID: new URL(passkeyOrigin()).hostname, credential, requireUserVerification: false });
  if (!verification.verified) throw new Error("INVALID_PASSKEY");
  const now = new Date().toISOString();
  await db.update(passkeyCredentials).set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: now }).where(eq(passkeyCredentials.credentialId, credentialId));
  const [user] = await db.select({ id: users.id, displayName: users.displayName }).from(users).where(eq(users.id, stored.userId)).limit(1);
  if (!user) throw new Error("INVALID_PASSKEY");
  const [emailIdentity] = await db.select({ email: userIdentities.providerSubject }).from(userIdentities).where(and(eq(userIdentities.userId, user.id), eq(userIdentities.provider, "email"))).limit(1);
  const [chatgptIdentity] = await db.select({ id: userIdentities.id }).from(userIdentities).where(and(eq(userIdentities.userId, user.id), eq(userIdentities.provider, "chatgpt"))).limit(1);
  return { user: { ...user, email: emailIdentity?.email ?? "" }, session: await issueSession(user.id), chatgptLinked: Boolean(chatgptIdentity) };
}

export async function deletePasskey(credentialId: string) {
  const user = await requireAuthUser();
  await ensureAuthSchema();
  const db = getDb();
  const [emailCredential] = await db.select({ userId: emailCredentials.userId }).from(emailCredentials).where(eq(emailCredentials.userId, user.id)).limit(1);
  const [chatgptIdentity] = await db.select({ id: userIdentities.id }).from(userIdentities).where(and(eq(userIdentities.userId, user.id), eq(userIdentities.provider, "chatgpt"))).limit(1);
  const passkeys = await db.select({ credentialId: passkeyCredentials.credentialId }).from(passkeyCredentials).where(eq(passkeyCredentials.userId, user.id));
  if (!emailCredential && !chatgptIdentity && passkeys.length <= 1) throw new Error("LAST_SIGNIN_METHOD");
  await db.delete(passkeyCredentials).where(and(eq(passkeyCredentials.credentialId, credentialId), eq(passkeyCredentials.userId, user.id)));
}
