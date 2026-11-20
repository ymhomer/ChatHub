import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';

// Exercise the actual synchronization effect with controlled network timing.
const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  useEffect(() => {\n    if (!user) return;');
const end = source.indexOf('  useEffect(()=>{\n    if(searching)return;', start);
const compiled = (await transform(source.slice(start, end), { loader: 'tsx' })).code;
function setup(selected = 'space-a') {
  let cleanup; const pending = []; const updates = []; const timers = [];
  const events = new Map();
  const doc = { hidden: false, addEventListener: (k, fn) => events.set(k, fn), removeEventListener: k => events.delete(k) };
  const win = { addEventListener: (k, fn) => events.set(k, fn), removeEventListener: k => events.delete(k) };
  const effect = new Function('useEffect','user','selected','refreshVersion','fetch','document','window','setTimeout','clearTimeout','setConversations','setSelected','setMessages','setSyncError', compiled);
  effect(fn => { cleanup = fn(); }, { id: 'user' }, selected, 0,
    (url, options) => new Promise(resolve => pending.push({ url, options, resolve })), doc, win,
    fn => { timers.push(fn); return timers.length; }, () => {},
    value => updates.push(['spaces', value]), () => {}, value => updates.push(['messages', value]), value => updates.push(['error', value]));
  const respond = async (ok = true) => {
    const batch = pending.splice(0);
    for (const request of batch) request.resolve({ ok, json: async () => request.url.includes('/messages') ? { messages: [{ id: 'from-phone' }] } : { conversations: [{ id: selected }] } });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { pending, updates, timers, events, doc, respond, cleanup: () => cleanup() };
}
test('poll receives another device message; focus and online refresh immediately', async () => {
  const s = setup();
  assert.equal(s.pending.length, 2);
  assert.ok(s.pending.every(r => r.options.cache === 'no-store'));
  await s.respond();
  assert.deepEqual(s.updates.find(u => u[0] === 'messages')[1], [{ id: 'from-phone' }]);
  s.timers.at(-1)(); assert.equal(s.pending.length, 2); await s.respond();
  s.events.get('focus')(); assert.equal(s.pending.length, 2);
  s.events.get('online')(); assert.equal(s.pending.length, 2, 'no overlapping refresh');
  await s.respond(); s.cleanup(); assert.equal(s.events.size, 0);
});
test('switching space ignores late responses and aborts old requests', async () => {
  const s = setup(); const signal = s.pending[0].options.signal;
  s.cleanup(); assert.equal(signal.aborted, true);
  await s.respond(); assert.equal(s.updates.length, 0); assert.equal(s.timers.length, 0);
});
test('failed sync retains history, reports failure and retries; hidden tab resumes', async () => {
  const s = setup(); await s.respond(false);
  assert.equal(s.updates.some(u => u[0] === 'messages'), false);
  assert.ok(s.updates.find(u => u[0] === 'error')[1]);
  s.doc.hidden = true; s.timers.at(-1)(); assert.equal(s.pending.length, 0);
  s.doc.hidden = false; s.events.get('visibilitychange')(); assert.equal(s.pending.length, 2);
  await s.respond(); assert.deepEqual(s.updates.at(-1), ['error', '']); s.cleanup();
});
