/*
 * ai-proxy's I/O layer — the part supabase/functions/ai-proxy/policy.mjs's
 * own tests (tests/ai-proxy-policy.mjs) deliberately don't cover, because it
 * lives in index.ts: the HTTP handler itself. Auth/session verification,
 * the entitlement gate (subscription status, trial expiry, unconfirmed
 * email), quota enforcement and its status codes, and the split between the
 * streaming and non-streaming response paths — none of it had any test.
 *
 *     deno run --allow-net --allow-env \
 *       --import-map=tests/ai-proxy-io.import_map.json tests/ai-proxy-io.test.ts
 *
 * index.ts is a Deno Edge Function: `Deno.serve(...)` at module scope starts
 * a real HTTP listener the moment it's imported, and it imports the real
 * `jsr:@supabase/supabase-js@2` client. Rather than reimplementing
 * PostgREST's wire protocol to fake that client's HTTP calls, the import
 * map redirects it (and the types-only edge-runtime.d.ts import) to local
 * stubs — same idiom as this repo's other suites, which always stub
 * `supabaseClient` directly rather than its wire format. What runs here is
 * the real, unmodified index.ts, driven over real HTTP loopback; only the
 * two things outside this app's own code (Supabase, Anthropic) are faked.
 */

import { createClient, mock, resetMock } from "./ai-proxy-io.supabase-js-stub.ts";
void createClient; // imported so the module is in the graph before index.ts's own import resolves to it

Deno.env.set("ANTHROPIC_API_KEY", "test-anthropic-key");
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");

const realFetch = globalThis.fetch;
const anthropic = {
  queue: [] as Array<{ status?: number; json?: unknown; streamEvents?: unknown[] }>,
  requests: [] as Array<{ body: any }>,
};
function sseBody(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const frames = events.map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`);
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < frames.length) controller.enqueue(encoder.encode(frames[i++]));
      else controller.close();
    },
  });
}
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (url === "https://api.anthropic.com/v1/messages") {
    anthropic.requests.push({ body: JSON.parse(String(init?.body ?? "{}")) });
    const next = anthropic.queue.shift();
    if (!next) throw new Error("no mocked Anthropic response queued");
    if (next.streamEvents) return new Response(sseBody(next.streamEvents), { status: next.status ?? 200 });
    return new Response(JSON.stringify(next.json ?? {}), { status: next.status ?? 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

await import("../supabase/functions/ai-proxy/index.ts");

const BASE = "http://localhost:8000";
for (let i = 0; i < 100; i++) {
  try { await fetch(BASE, { method: "OPTIONS" }); break; } catch { await new Promise((r) => setTimeout(r, 25)); }
}

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "\n       " + extra : "")); }
}

function baseBody(overrides: Record<string, unknown> = {}) {
  return { messages: [{ role: "user", content: "hello" }], max_tokens: 500, ...overrides };
}
async function call(
  body: unknown,
  { auth = "Bearer faketoken", method = "POST", raw }: { auth?: string | null; method?: string; raw?: string } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== null) headers["authorization"] = auth;
  return fetch(BASE, {
    method,
    headers,
    body: method === "OPTIONS" || method === "GET" ? undefined : (raw ?? JSON.stringify(body)),
  });
}
function queueAnthropicJson(json: unknown, status = 200) {
  anthropic.queue.push({ json, status });
}

// ----------------------------------------------------------------- method/auth
console.log("\n== method and auth ==");
{
  const res = await call(undefined, { method: "OPTIONS" });
  ok("OPTIONS is answered without touching auth or Supabase", res.status === 200);
  ok("and carries the CORS header", res.headers.get("access-control-allow-origin") === "*");

  resetMock();
  const notPost = await call(undefined, { method: "GET" });
  ok("a non-POST method is rejected", notPost.status === 405);
  ok("with the documented error", (await notPost.json()).error === "Method not allowed");

  resetMock();
  const noAuth = await call(baseBody(), { auth: null });
  ok("a missing Authorization header is 401 before anything else runs", noAuth.status === 401);
  ok("naming what's missing", (await noAuth.json()).error === "Missing Authorization header");

  resetMock();
  mock.userError = { message: "bad token" };
  const badSession = await call(baseBody());
  ok("a session Supabase itself rejects is 401", badSession.status === 401);
  ok("as an invalid session, not the raw Supabase error", (await badSession.json()).error === "Invalid session");
}

// ------------------------------------------------------------------ entitlement
console.log("\n== entitlement gate ==");
{
  resetMock();
  mock.subscription = null;
  const noSub = await call(baseBody());
  ok("no subscription row at all is refused", noSub.status === 402);
  ok("as trial_over", (await noSub.json()).code === "trial_over");

  resetMock();
  mock.subscription = { status: "canceled" };
  const canceled = await call(baseBody());
  ok("a canceled subscription is refused the same way", canceled.status === 402);

  resetMock();
  mock.subscription = { status: "trialing", current_period_end: new Date(Date.now() - 86400000).toISOString() };
  const expiredTrial = await call(baseBody());
  ok("a trial whose period_end has already passed does not count as trialing", expiredTrial.status === 402);

  resetMock();
  mock.subscription = { status: "trialing", current_period_end: new Date(Date.now() + 86400000).toISOString() };
  mock.user!.email_confirmed_at = null;
  const unconfirmed = await call(baseBody());
  ok("an unconfirmed email during trial is refused separately from an expired one", unconfirmed.status === 429);
  ok("as email_unconfirmed", (await unconfirmed.json()).code === "email_unconfirmed");

  resetMock();
  mock.subscription = { status: "active" };
  queueAnthropicJson({ usage: { input_tokens: 1, output_tokens: 1 } });
  const active = await call(baseBody());
  ok("an active subscription needs no trial/email check at all", active.status === 200);
}

// -------------------------------------------------------------------- request body
console.log("\n== request validation ==");
{
  resetMock();
  const badJson = await call(undefined, { raw: "{not json" });
  ok("unparseable JSON is 400", badJson.status === 400);
  ok("naming the body as the problem", (await badJson.json()).error === "Invalid JSON body");

  resetMock();
  const noMessages = await call({ max_tokens: 500 });
  ok("a request with no messages array is 400", noMessages.status === 400);

  resetMock();
  const emptyMessages = await call(baseBody({ messages: [] }));
  ok("an empty messages array is 400 too, not treated as zero work", emptyMessages.status === 400);

  resetMock();
  const badTask = await call(baseBody({ task: "definitely_not_a_real_task" }));
  ok("an unrecognised task label is refused rather than silently accepted", badTask.status === 400);
  ok("as unknown_task", (await badTask.json()).error === "unknown_task");

  resetMock();
  const badContent = await call(baseBody({ messages: [{ role: "user", content: 12345 }] }));
  ok("message content that is neither a string nor a block array is 400", badContent.status === 400);
  ok("as invalid_content", (await badContent.json()).error === "invalid_content");
}

// -------------------------------------------------------------------------- quota
console.log("\n== quota enforcement ==");
{
  resetMock();
  mock.rpc.consume_daily_ai_call = () => ({ data: false, error: null });
  const dailyOut = await call(baseBody({ max_tokens: 500 })); // classify() -> "free"
  ok("free-tier work checks the daily cap", dailyOut.status === 429);
  ok("as daily_limit_reached", (await dailyOut.json()).error === "daily_limit_reached");

  resetMock();
  mock.rpc.consume_ai_quota = () => ({ data: "course_quota", error: null });
  const courseOut = await call(baseBody({ max_tokens: 3600 })); // classify() -> "course"
  ok("a course over the monthly cap is refused", courseOut.status === 429);
  const courseBody = await courseOut.json();
  ok("as course_quota", courseBody.code === "course_quota");
  ok("with the paid-plan message, since this account isn't trialing", /used all/.test(courseBody.message));

  resetMock();
  mock.subscription = { status: "trialing", current_period_end: new Date(Date.now() + 86400000).toISOString() };
  mock.rpc.consume_ai_quota = () => ({ data: "course_quota", error: null });
  const trialCourseOut = await call(baseBody({ max_tokens: 3600 }));
  ok("the same refusal reads differently for a trial account", /free course is done/.test((await trialCourseOut.json()).message));

  resetMock();
  mock.rpc.consume_ai_quota = () => ({ data: "lesson_quota", error: null });
  const lessonOut = await call(baseBody({ max_tokens: 5000 })); // classify() -> "lesson"
  ok("a lesson over the monthly cap is refused separately from a course", lessonOut.status === 429);
  ok("as lesson_quota", (await lessonOut.json()).code === "lesson_quota");

  resetMock();
  mock.rpc.consume_ai_quota = () => ({ data: null, error: { message: "db down" } });
  const quotaErr = await call(baseBody({ max_tokens: 3600 }));
  ok("a failed quota check fails the request rather than defaulting to allow", quotaErr.status === 500);
  ok("as quota_check_failed", (await quotaErr.json()).error === "quota_check_failed");
}

// ------------------------------------------------------------------------- happy path
console.log("\n== a normal, successful call ==");
{
  resetMock();
  queueAnthropicJson({ content: [{ type: "text", text: "hi" }], usage: { input_tokens: 100, output_tokens: 50 } });
  const res = await call(baseBody({ max_tokens: 500 }));
  ok("a normal call succeeds", res.status === 200);
  const body = await res.json();
  ok("and the model's response is forwarded as-is", body.content?.[0]?.text === "hi");
  const usageCall = mock.calls.find((c) => c.name === "increment_ai_usage");
  ok("usage is recorded against the signed-in account", (usageCall?.params as any)?.p_user_id === "user-1");
  ok("with the token counts the model actually reported",
     (usageCall?.params as any)?.p_input_tokens === 100 && (usageCall?.params as any)?.p_output_tokens === 50);

  resetMock();
  queueAnthropicJson({ usage: { input_tokens: 1, output_tokens: 1 } });
  await call(baseBody({ max_tokens: 3600, task: "path" })); // course kind, not "worksheet"
  const sentText = anthropic.requests.at(-1)!.body.messages[0].content[0].text;
  ok("a course-planning call has its concept count rewritten server-side",
     /IMPORTANT: return exactly 10 concepts/.test(sentText), sentText);

  resetMock();
  queueAnthropicJson({ usage: { input_tokens: 1, output_tokens: 1 } });
  await call(baseBody({ max_tokens: 3600, task: "worksheet" }));
  const worksheetText = anthropic.requests.at(-1)!.body.messages[0].content[0].text;
  ok("a worksheet call is left alone — it enumerates the material's own exercises, not a topic count",
     !/IMPORTANT: return exactly/.test(worksheetText));

  resetMock();
  queueAnthropicJson({ usage: { input_tokens: 1, output_tokens: 1 } });
  await call(baseBody({ max_tokens: 999999 })); // classify() -> "lesson", cap 6000
  ok("an outsized max_tokens is clamped server-side, not trusted from the client",
     anthropic.requests.at(-1)!.body.max_tokens === 6000);
}

// ---------------------------------------------------------------------- streaming
console.log("\n== streaming ==");
{
  resetMock();
  anthropic.queue.push({
    status: 200,
    streamEvents: [
      { type: "message_start", message: { usage: { input_tokens: 200, output_tokens: 0, cache_creation_input_tokens: 10, cache_read_input_tokens: 0 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
      { type: "message_delta", usage: { output_tokens: 42 } },
    ],
  });
  const streamed = await call(baseBody({ stream: true, max_tokens: 500 }));
  ok("a streaming request gets a streamed response", streamed.status === 200);
  ok("with the SSE content type", (streamed.headers.get("content-type") ?? "").includes("text/event-stream"));
  ok("and buffering disabled end-to-end", streamed.headers.get("x-accel-buffering") === "no");
  const text = await streamed.text();
  ok("the bytes are forwarded to the client untouched", text.includes('"text":"Hello"'));

  let usageCall;
  for (let i = 0; i < 40 && !usageCall; i++) {
    usageCall = mock.calls.find((c) => c.name === "increment_ai_usage");
    if (!usageCall) await new Promise((r) => setTimeout(r, 25));
  }
  ok("usage is recorded once the stream finishes draining, not skipped because there's no JSON body",
     !!usageCall);
  ok("using the totals read off the stream itself (input + cache write, and the last output count)",
     (usageCall?.params as any)?.p_input_tokens === 200 &&
     (usageCall?.params as any)?.p_cache_write === 10 &&
     (usageCall?.params as any)?.p_output_tokens === 42);

  resetMock();
  anthropic.queue.push({ status: 529, json: { error: { message: "overloaded" } } });
  const refused = await call(baseBody({ stream: true, max_tokens: 500 }));
  ok("a refused request is passed through as plain JSON even when streaming was asked for",
     refused.status === 529);
  const refusedBody = await refused.json();
  ok("carrying Anthropic's own error rather than being wrapped in an SSE envelope",
     refusedBody.error?.message === "overloaded");
  ok("and nothing is billed for a call that never ran",
     !mock.calls.some((c) => c.name === "increment_ai_usage"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
Deno.exit(fail ? 1 : 0);
