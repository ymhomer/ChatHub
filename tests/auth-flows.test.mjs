import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';

const migration = await readFile(new URL('../drizzle/0000_lazy_black_widow.sql', import.meta.url), 'utf8');
const result = await build({
  entryPoints: ['lib/server/auth.ts'], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node24',
  plugins: [{ name: 'test-boundaries', setup(b) {
    b.onResolve({ filter: /^(cloudflare:workers|next\/headers|@\/app\/chatgpt-auth|@\/lib\/server\/chat|@simplewebauthn\/server)$/ }, args => ({ path: args.path, namespace: 'auth-test' }));
    b.onLoad({ filter: /.*/, namespace: 'auth-test' }, args => ({ contents: {
      'cloudflare:workers': 'export const env = { get DB() { return globalThis.__authHarness.d1; } };',
      'next/headers': 'export async function cookies() { return { get(name) { const v = globalThis.__authHarness.cookies[name]; return v ? {value:v} : undefined; } }; }',
      '@/app/chatgpt-auth': 'export async function getChatGPTUser() { return globalThis.__authHarness.chatgpt; }',
      '@/lib/server/chat': `export async function createPrivateSpace(id) { const db = globalThis.__authHarness.sql; const c = crypto.randomUUID(); db.prepare("INSERT INTO conversations(id,type,title,created_by) VALUES(?, 'group', 'private', ?)").run(c,id); db.prepare("INSERT INTO conversation_members(conversation_id,user_id,role) VALUES(?,?,'admin')").run(c,id); }`,
      '@simplewebauthn/server': 'export const generateAuthenticationOptions = () => {}; export const generateRegistrationOptions = () => {}; export const verifyAuthenticationResponse = () => {}; export const verifyRegistrationResponse = () => {};',
    }[args.path] }));
  } }],
});
const code = result.outputFiles[0].text;
const testDir = await mkdtemp(join(tmpdir(), 'chathub-auth-'));
const bundlePath = join(testDir,'auth.mjs');
await writeFile(bundlePath,code);
after(async()=>{ await rm(testDir,{recursive:true,force:true}); });

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.db, this.sql, params); }
  all() { return { results: this.db.prepare(this.sql).all(...this.params), success: true }; }
  raw() { const s = this.db.prepare(this.sql); s.setReturnArrays(true); return s.all(...this.params); }
  run() { const info = this.db.prepare(this.sql).run(...this.params); return { success: true, meta: { changes: info.changes } }; }
  first(column) { const row = this.db.prepare(this.sql).get(...this.params); return row ? column ? row[column] : row : null; }
}
async function harness() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON'); sql.exec(migration);
  const h = { sql, cookies: {}, chatgpt: null, d1: { prepare: q => new Statement(sql,q), batch(statements) {
    sql.exec('BEGIN');
    try { const rows = statements.map(s => s.all()); sql.exec('COMMIT'); return rows; }
    catch (e) { sql.exec('ROLLBACK'); throw e; }
  } } };
  globalThis.__authHarness = h;
  h.auth = await import(pathToFileURL(bundlePath).href + '?' + crypto.randomUUID());
  h.one = (q,...params) => sql.prepare(q).get(...params);
  h.count = table => Number(h.one(`SELECT COUNT(*) AS n FROM ${table}`).n);
  h.session = result => { h.cookies.chathub_session = result.session.cookie.split(';')[0].split('=')[1]; };
  h.native = () => { h.chatgpt = { id: 'gpt-source', email: 'profile@example.test', displayName:'GPT',fullName:null }; h.cookies = {}; };
  await h.auth.ensureAuthSchema();
  return h;
}
const password = 'A-unique-test-password-79';
async function separate(h) {
  h.native(); const source = await h.auth.getAppUser();
  h.chatgpt = null;
  const target = await h.auth.registerEmail('existing@example.test',password);
  h.native();
  return { source:source.id, target:target.user.id, codes:target.recoveryCodes };
}

// Uses the production auth functions + Drizzle queries on a real SQLite database.
// Only the platform identity/cookie boundary is simulated.
test('ChatGPT first: no password is reported, then new Email joins the SAME account', async () => {
  const h=await harness(); h.native();
  const current = await h.auth.getAppUser();
  const before = await h.auth.authMethods();
  assert.equal(before.hasPassword,false); assert.equal(before.email,null);
  assert.equal((await h.auth.emailLinkState('  New@Example.test ')).state,'new');
  h.sql.prepare("INSERT INTO recovery_codes(code_hash,user_id) VALUES('legacy-orphan',?)").run(current.id);
  const linked = await h.auth.linkEmailCredentials('  New@Example.test ',password);
  assert.equal(h.count('recovery_codes'),8);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM recovery_codes WHERE code_hash='legacy-orphan'").n,0);
  assert.equal(linked.recoveryCodes.length,8); assert.equal(h.count('users'),1);
  const methods=await h.auth.authMethods(); assert.equal(methods.email,'new@example.test'); assert.equal(methods.hasPassword,true);
  await assert.rejects(h.auth.linkEmailCredentials('another@example.test',password),/EMAIL_ALREADY_LINKED/);
  h.chatgpt=null; const login=await h.auth.loginEmail('NEW@example.test',password); h.session(login);
  assert.equal((await h.auth.getAppUser()).id,current.id);
  h.native(); assert.equal((await h.auth.getAppUser()).id,current.id);
});

test('Email first: confirmed native ChatGPT identity links without creating a second account', async () => {
  const h=await harness(); const email=await h.auth.registerEmail('first@example.test',password); h.session(email);
  h.chatgpt={id:'native-new',email:'first@example.test',displayName:'GPT'};
  await assert.rejects(h.auth.linkChatGPTIdentity(),/LINK_INTENT_REQUIRED/);
  const begin=await h.auth.beginChatGPTLink(); h.cookies.chathub_link_intent=begin.cookie.split(';')[0].split('=')[1];
  assert.equal((await h.auth.linkChatGPTIdentity()).linked,true);
  assert.equal(h.count('users'),1); assert.equal(h.count('user_identities'),2);
  h.cookies={}; assert.equal((await h.auth.getAppUser()).id,email.user.id);
});

test('ChatGPT first + existing Email: explicit merge preserves both spaces, messages, attachments, passkeys, recovery codes', async () => {
  const h=await harness(); const ids=await separate(h);
  const c=h.one('SELECT id FROM conversations WHERE created_by=?',ids.source).id;
  const other=h.one('SELECT id FROM conversations WHERE created_by=?',ids.target).id;
  h.sql.prepare("INSERT INTO conversation_members(conversation_id,user_id,role) VALUES(?,?,'member')").run(c,ids.target);
  h.sql.prepare("INSERT INTO messages(id,conversation_id,sender_id,body) VALUES('m',?,?, 'keep text')").run(c,ids.source);
  h.sql.prepare("INSERT INTO attachments(id,message_id,object_key,filename,content_type,bytes) VALUES('att','m','attachments/unchanged','file.txt','text/plain',4)").run();
  h.sql.prepare("INSERT INTO passkey_credentials(credential_id,user_id,public_key) VALUES('pk-source',?,'key'),('pk-target',?,'key')").run(ids.source,ids.target);
  h.sql.prepare("INSERT INTO notification_subscriptions(id,user_id,endpoint,subscription_json) VALUES('notify',?,'endpoint','{}')").run(ids.source);
  const state=await h.auth.emailLinkState('existing@example.test'); assert.equal(state.state,'existing');
  await assert.rejects(h.auth.prepareAccountMerge(state.email,'wrong'),/INVALID_LOGIN/);
  const preview=await h.auth.prepareAccountMerge(state.email,password);
  assert.equal(preview.sourceConversations,1); assert.equal(preview.targetConversations,2); assert.equal(preview.passkeys,2);
  assert.equal(h.one('SELECT status FROM users WHERE id=?',ids.source).status,'active');
  const result=await h.auth.confirmAccountMerge(preview.token); h.session(result); h.chatgpt=null;
  assert.equal((await h.auth.getAppUser()).id,ids.target);
  assert.equal(h.one('SELECT status FROM users WHERE id=?',ids.source).status,'merged');
  assert.equal(h.one('SELECT COUNT(*) AS n FROM conversation_members WHERE user_id=?',ids.target).n,2);
  assert.equal(h.one('SELECT role FROM conversation_members WHERE user_id=? AND conversation_id=?',ids.target,c).role,'admin');
  assert.equal(h.one("SELECT sender_id FROM messages WHERE id='m'").sender_id,ids.target);
  assert.equal(h.one("SELECT object_key FROM attachments WHERE id='att'").object_key,'attachments/unchanged');
  assert.equal(h.one('SELECT created_by FROM conversations WHERE id=?',c).created_by,ids.target);
  assert.equal(h.one('SELECT created_by FROM conversations WHERE id=?',other).created_by,ids.target);
  assert.equal(h.one('SELECT COUNT(*) AS n FROM passkey_credentials WHERE user_id=?',ids.target).n,2);
  assert.equal(h.one("SELECT user_id FROM notification_subscriptions WHERE id='notify'").user_id,ids.target);
  assert.equal(h.one('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id=?',ids.target).n,8);
  assert.equal((await h.auth.loginEmail(state.email,password)).user.id,ids.target);
  h.native(); assert.equal((await h.auth.getAppUser()).id,ids.target);
  await assert.rejects(h.auth.confirmAccountMerge(preview.token),/CHALLENGE_EXPIRED/);
});

test('Email first + ChatGPT already has a space: callback proof + Email password + confirmation', async () => {
  const h=await harness(); const ids=await separate(h);
  const login=await h.auth.loginEmail('existing@example.test',password); h.session(login);
  const begin=await h.auth.beginChatGPTLink(); h.cookies.chathub_link_intent=begin.cookie.split(';')[0].split('=')[1];
  const linked=await h.auth.linkChatGPTIdentity(); assert.equal(linked.mergeRequired,true);
  await assert.rejects(h.auth.prepareAccountMerge(linked.email,'wrong',linked.proofId),/INVALID_LOGIN/);
  const preview=await h.auth.prepareAccountMerge(linked.email,password,linked.proofId);
  assert.equal(h.one('SELECT status FROM users WHERE id=?',ids.source).status,'active');
  const merged=await h.auth.confirmAccountMerge(preview.token); h.session(merged);
  const methods=await h.auth.authMethods(); assert.equal(methods.chatgptLinked,true); assert.equal(methods.email,linked.email);
  assert.equal((await h.auth.getAppUser()).id,ids.target);
});

test('Cancelled/expired/wrong-account merge never moves data', async () => {
  const h=await harness(); const ids=await separate(h);
  const preview=await h.auth.prepareAccountMerge('existing@example.test',password);
  assert.equal(h.one('SELECT status FROM users WHERE id=?',ids.source).status,'active');
  const another=await h.auth.registerEmail('unrelated@example.test',password); h.session(another); h.chatgpt=null;
  await assert.rejects(h.auth.confirmAccountMerge(preview.token),/CHALLENGE_EXPIRED/);
  h.native(); h.sql.prepare("UPDATE auth_challenges SET expires_at='2000-01-01' WHERE id=?").run(preview.token);
  await assert.rejects(h.auth.confirmAccountMerge(preview.token),/CHALLENGE_EXPIRED/);
  assert.equal(h.one('SELECT status FROM users WHERE id=?',ids.source).status,'active');
  assert.equal(h.one("SELECT user_id FROM user_identities WHERE provider='chatgpt'").user_id,ids.source);
});

test('Password changed after preview: atomic guard aborts with no data transfer', async () => {
  const h=await harness(); const ids=await separate(h);
  const preview=await h.auth.prepareAccountMerge('existing@example.test',password);
  h.sql.prepare("UPDATE email_credentials SET password_hash='changed' WHERE user_id=?").run(ids.target);
  await assert.rejects(h.auth.confirmAccountMerge(preview.token),/MERGE_CHANGED/);
  assert.equal(h.count('account_merge_guards'),0);
  assert.equal(h.one('SELECT status FROM users WHERE id=?',ids.source).status,'active');
  assert.equal(h.one('SELECT COUNT(*) AS n FROM conversation_members WHERE user_id=?',ids.source).n,1);
});

test('Database failure partway through merge rolls back memberships, identities and sessions', async () => {
  const h=await harness(); const ids=await separate(h);
  const preview=await h.auth.prepareAccountMerge('existing@example.test',password);
  const previousSessions=h.count('auth_sessions');
  h.sql.exec("CREATE TRIGGER fail_merge BEFORE UPDATE OF status ON users WHEN NEW.status = 'merged' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
  await assert.rejects(h.auth.confirmAccountMerge(preview.token),/MERGE_CHANGED/);
  assert.equal(h.count('auth_sessions'),previousSessions);
  assert.equal(h.count('account_merge_guards'),0);
  assert.equal(h.one('SELECT status FROM users WHERE id=?',ids.source).status,'active');
  assert.equal(h.one("SELECT user_id FROM user_identities WHERE provider='chatgpt'").user_id,ids.source);
  assert.equal(h.one('SELECT COUNT(*) AS n FROM conversation_members WHERE user_id=?',ids.source).n,1);
  assert.equal(h.one('SELECT COUNT(*) AS n FROM conversation_members WHERE user_id=?',ids.target).n,1);
});

test('Double confirm succeeds only once; old sessions are revoked', async () => {
  const h=await harness(); const ids=await separate(h);
  const sourceSession=await h.auth.issueSession(ids.source);
  const oldToken=sourceSession.cookie.split(';')[0].split('=')[1];
  const preview=await h.auth.prepareAccountMerge('existing@example.test',password);
  const attempts=await Promise.allSettled([h.auth.confirmAccountMerge(preview.token),h.auth.confirmAccountMerge(preview.token)]);
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(h.one('SELECT COUNT(*) AS n FROM auth_sessions WHERE token_hash=?',createHash('sha256').update(oldToken).digest('hex')).n,0);
});

test('A second ChatGPT identity cannot overwrite an already linked target', async () => {
  const h=await harness(); const ids=await separate(h);
  h.sql.prepare("INSERT INTO user_identities(id,user_id,provider,provider_subject) VALUES('other-link',?,'chatgpt','different-gpt')").run(ids.target);
  await assert.rejects(h.auth.prepareAccountMerge('existing@example.test',password),/MERGE_CONFLICT/);
  assert.equal(h.one('SELECT status FROM users WHERE id=?',ids.source).status,'active');
});

test('Registration failure is atomic: no orphan user, credential, code or space', async () => {
  const h=await harness();
  h.sql.exec("CREATE TRIGGER fail_space BEFORE INSERT ON conversations BEGIN SELECT RAISE(ABORT, 'simulated space failure'); END");
  await assert.rejects(h.auth.registerEmail('atomic@example.test',password));
  for (const table of ['users','user_identities','email_credentials','recovery_codes','conversations','messages']) assert.equal(h.count(table),0,table);
});

test('Simultaneous first ChatGPT requests converge on one account and one space', async () => {
  const h=await harness(); h.native();
  const [one,two]=await Promise.all([h.auth.getAppUser(),h.auth.getAppUser()]);
  assert.equal(one.id,two.id); assert.equal(h.count('users'),1); assert.equal(h.count('conversations'),1);
});

test('Recovery code works after binding and invalidates the old password and ALL old codes', async () => {
  const h=await harness(); h.native();
  const linked=await h.auth.linkEmailCredentials('recover@example.test',password);
  const nextPassword='New-test-password-only-28';
  const recovered=await h.auth.recoverEmailPassword('recover@example.test',linked.recoveryCodes[0].toLowerCase(),nextPassword);
  assert.equal(recovered.recoveryCodes.length,8);
  await assert.rejects(h.auth.loginEmail('recover@example.test',password),/INVALID_LOGIN/);
  assert.ok((await h.auth.loginEmail('recover@example.test',nextPassword)).user.id);
  await assert.rejects(h.auth.recoverEmailPassword('recover@example.test',linked.recoveryCodes[1],password),/INVALID_RECOVERY/);
});

test('Concurrent recovery using different old codes succeeds only once', async () => {
  const h=await harness();
  const user=await h.auth.registerEmail('recover-race@example.test',password);
  const outcomes=await Promise.allSettled([
    h.auth.recoverEmailPassword('recover-race@example.test',user.recoveryCodes[0],'New-long-password-one-36'),
    h.auth.recoverEmailPassword('recover-race@example.test',user.recoveryCodes[1],'New-long-password-two-37'),
  ]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(h.count('recovery_codes'),8);
});

test('ChatGPT linking intent is single-use and bound to the starting Email session', async () => {
  const h=await harness(); const a=await h.auth.registerEmail('intent-a@example.test',password); h.session(a);
  const begin=await h.auth.beginChatGPTLink(); const intent=begin.cookie.split(';')[0].split('=')[1];
  const b=await h.auth.registerEmail('intent-b@example.test',password); h.session(b);
  h.chatgpt={id:'intent-gpt',email:'native@example.test',displayName:'native'}; h.cookies.chathub_link_intent=intent;
  await assert.rejects(h.auth.linkChatGPTIdentity(),/CHALLENGE_EXPIRED/);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM user_identities WHERE provider='chatgpt'").n,0);
  h.session(a); h.cookies.chathub_link_intent=intent;
  assert.equal((await h.auth.linkChatGPTIdentity()).linked,true);
  await assert.rejects(h.auth.linkChatGPTIdentity(),/CHALLENGE_EXPIRED/);
});

test('Production PBKDF2 limit: registration and login work when >100000 iterations are rejected', async () => {
  const h=await harness();
  const original=crypto.subtle.deriveBits;
  const calls=[];
  crypto.subtle.deriveBits=function(algorithm,...args) {
    if(algorithm.name==='PBKDF2') {
      calls.push(algorithm.iterations);
      if(algorithm.iterations>100000) throw new DOMException('Iteration counts above 100000 are not supported','NotSupportedError');
    }
    return original.call(this,algorithm,...args);
  };
  try {
    const registered=await h.auth.registerEmail('production-cap@example.test',password);
    assert.equal((await h.auth.loginEmail('production-cap@example.test',password)).user.id,registered.user.id);
    assert.equal(await h.auth.checkPasswordRuntime(),true);
    assert.ok(calls.length>=4); assert.ok(calls.every(x=>x<=100000));
  } finally { crypto.subtle.deriveBits=original; }
});
