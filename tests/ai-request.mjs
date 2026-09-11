import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const extract = name => {
  const start = source.indexOf(`        async function ${name}(`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n        }', start) + 10);
};
const pending = () => new Promise(() => {});
function setup() {
  const errors = [];
  let requests = 0;
  const ctx = vm.createContext({
    setTimeout, clearTimeout, AbortController, IDLE_TIMEOUT_MS: 10,
    LESSON_IDLE_TIMEOUT_MS: 60, LESSON_TOTAL_TIMEOUT_MS: 150,
    currentUser: { id: 'fixture' }, AI_ENDPOINT: '/fixture', SUPABASE_ANON_KEY: 'fixture',
    supabaseClient: { auth: {
      getSession: async () => ({ data: { session: { access_token: 'fixture' } } }),
      signOut: async () => {},
    } },
    console: { error() {}, warn() {} }, showError: message => errors.push(message),
    showAuthModal() {}, refreshUsage() {},
    fetch: async () => {
      requests++;
      return { ok: true, headers: new Headers(), json: async () => ({ content: [{ type: 'text', text: 'lesson' }] }) };
    },
  });
  vm.runInContext('let lastCallTruncated;\n' + ['withAIWaitLimit', 'callAI'].map(extract).join('\n'), ctx);
  return { ctx, errors, requests: () => requests };
}
async function run(ctx) {
  return ctx.withAIWaitLimit(ctx.callAI('fixture', '', { stream: true }), 'TEST_HUNG', 500);
}
{
  const { ctx, errors, requests } = setup();
  let resolveSession;
  ctx.supabaseClient.auth.getSession = () => new Promise(resolve => { resolveSession = resolve; });
  assert.equal(await run(ctx), null);
  assert.match(errors[0], /sign-in took too long/);
  resolveSession({ data: { session: { access_token: 'late' } } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests(), 0, 'a late session must not start a generation');
  ctx.supabaseClient.auth.getSession = async () => ({ data: { session: { access_token: 'valid' } } });
  assert.equal(await run(ctx), 'lesson', 'retry after recovery works');
}
for (const ok of [true, false]) {
  const { ctx, errors } = setup();
  ctx.fetch = async () => ({ ok, status: 500, headers: new Headers(), json: pending });
  assert.equal(await run(ctx), null);
  assert.match(errors[0], /too long/);
}
{
  const { ctx, errors } = setup();
  ctx.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  ctx.supabaseClient.auth.signOut = pending;
  assert.equal(await run(ctx), null);
  assert.ok(errors.some(message => /sign-in took too long/.test(message)));
}
{
  const { ctx, errors, requests } = setup();
  ctx.supabaseClient.auth.getSession = async () => ({ error: new Error('refresh failed'), data: {} });
  assert.equal(await run(ctx), null);
  assert.equal(requests(), 0);
  assert.match(errors[0], /Couldn't check your sign-in/);
}
console.log('PASS: stalled session, late result, recovery, stalled JSON bodies, stalled sign-out, auth errors');

// A slow but healthy lesson must survive the shorter general-request limit.
{
  const { ctx, errors } = setup();
  ctx.fetch = async (_, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ ok: true, headers: new Headers(),
      json: async () => ({ content: [{ type: 'text', text: 'slow lesson' }] }) }), 25);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
  assert.equal(await ctx.callAI('fixture', '', { stream: true, task: 'lesson' }), 'slow lesson');
  assert.equal(errors.length, 0);
  assert.equal(await ctx.callAI('fixture', '', { stream: true, task: 'path' }), null);
  assert.match(errors[0], /too long/);
}
{
  const { ctx, errors } = setup();
  ctx.fetch = async (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  assert.equal(await ctx.callAI('fixture', '', { stream: true, task: 'lesson' }), null);
  assert.match(errors[0], /too long/);
}
console.log('PASS: slow healthy lesson, unchanged short path timeout, bounded stalled lesson');
