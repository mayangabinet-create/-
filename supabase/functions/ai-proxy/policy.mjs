/*
 * Everything ai-proxy decides, with no Deno and no network in it.
 *
 * The handler in index.ts is I/O: read the JWT, read the subscription, call
 * Anthropic, write usage. The rules — what a tier may buy, what counts as a
 * lesson, how much of the document survives, which block gets cached — live
 * here, because those are the parts worth testing and the parts that cost
 * money when they are wrong.
 *
 * Deno imports this directly; `tests/ai-proxy-policy.mjs` imports the same
 * file, so the tests exercise the shipping rules rather than a copy.
 */

export const HAIKU = "claude-haiku-4-5";
export const SONNET = "claude-sonnet-5";
export const OPUS = "claude-opus-5";

/**
 * The tier table, and the authority. `app.js` carries a copy that shapes the
 * UI; this one decides what actually runs, because a modified client can send
 * any prompt it likes.
 *
 * `contextChars` is new: the shared slice of the document sent with *every*
 * lesson of a course, identical each time so it can be cached. `excerptChars`
 * is unchanged — the passage retrieved for one concept, different every call
 * and therefore never cacheable.
 *
 * Trial and Basic run on Haiku, whose minimum cacheable prefix is 4,096
 * tokens. Their `contextChars` is 0 — not an oversight. Caching only repays
 * its write premium when the same prefix is read again, and a prefix that
 * never reaches the minimum is billed at the premium and never read. Turning
 * this on for Haiku means first raising the budget past ~16,000 characters,
 * which costs real money per course; that decision should be made against the
 * hit rate the paid tiers are about to start reporting, not against a guess.
 */
export const PLANS = {
  trial: { coursesPerMonth: 1, lessonsPerCourse: 10, readChars: 5_000, excerptChars: 2_400, contextChars: 0, modelCourse: HAIKU, modelLesson: HAIKU },
  basic: { coursesPerMonth: 3, lessonsPerCourse: 10, readChars: 5_000, excerptChars: 2_400, contextChars: 0, modelCourse: HAIKU, modelLesson: HAIKU },
  pro: { coursesPerMonth: 5, lessonsPerCourse: 12, readChars: 40_000, excerptChars: 8_000, contextChars: 24_000, modelCourse: SONNET, modelLesson: SONNET },
  max: { coursesPerMonth: 8, lessonsPerCourse: 15, readChars: 120_000, excerptChars: 16_000, contextChars: 48_000, modelCourse: OPUS, modelLesson: SONNET },
};

/**
 * How much the lesson prompt itself may take, on top of the excerpt it shares
 * a block with. Raised from 12,000 when the prompt started carrying a line
 * about how the learner has been doing: at 11,500 characters the widest
 * prompt — a maths concept, whose template shelf is the largest — had 350
 * characters of room left, and a prompt that overruns is truncated from the
 * tail, where its own JSON schema lives.
 *
 * It is a ceiling, not a payload. Nothing is sent because the room exists;
 * raising it costs whatever the prompt actually grows by, which is a fraction
 * of a cent per lesson, and buys back the margin that catches the next few
 * templates in the test rather than in a lesson that will not open.
 */
export const TEMPLATE_ALLOWANCE = 13_000;
export const FREE_CALL_CHARS = 20_000;
export const FREE_CALLS_PER_DAY = 200;
/**
 * `tutor` is still here although the dock that sent it has been deleted from
 * the client, because the server has to outlive the client it talks to. The
 * removal lives on an unmerged branch; the app being served still asks tutor
 * questions, and a label dropped from this set is a 400 on a request that used
 * to work. It costs nothing to keep — tutor calls classify as free work, so
 * they are capped at 1,000 output tokens and metered against the daily
 * backstop like any other. Drop it once the client without the dock has been
 * deployed and has stopped sending it.
 */
export const KNOWN_TASKS = new Set(["path", "lesson", "tutor", "feedback"]);

// A client that sends fifty blocks is not a client we wrote.
export const MAX_CONTENT_BLOCKS = 8;

/**
 * Minimum prefix each model will actually cache, in tokens. Below this the API
 * accepts `cache_control`, reports `cache_creation_input_tokens: 0`, and
 * charges full price — it fails silently, which is the failure worth guarding
 * against.
 */
export const CACHE_MIN_TOKENS = {
  [HAIKU]: 4096,
  [SONNET]: 1024,
  [OPUS]: 512,
};

/**
 * Characters per token, assumed low on purpose.
 *
 * Hebrew runs about 2.5 characters per token and English about 4. Taking the
 * higher figure means we credit a block with the *fewest* tokens it could
 * contain, so a block we mark cacheable clears the minimum in either language.
 * Erring the other way would mark Hebrew-sized blocks eligible that English
 * text of the same length would not fill — and pay the write premium for a
 * cache entry that is never created.
 */
export const CHARS_PER_TOKEN = 4;

export function minCacheChars(model) {
  const tokens = CACHE_MIN_TOKENS[model];
  return tokens === undefined ? Infinity : tokens * CHARS_PER_TOKEN;
}

/**
 * What is being bought, derived from `max_tokens` rather than the client's
 * `task` label: a course plan asks for 4000 and a lesson for 6000, while
 * feedback (250) sits far below. Anything under the course threshold is
 * clamped to 1000 output tokens, so a request crafted just below the line
 * cannot buy a lesson's worth of generation for free.
 *
 * The lesson cap rose from 5000 with the drawn-figure lesson format: a lesson
 * that runs out of output tokens mid-JSON is a lesson that will not open. The
 * threshold did not move, so a client still asking for 5000 classifies as a
 * lesson exactly as it did — old clients keep working, they just don't use the
 * extra room.
 */
export function classify(maxTokens) {
  const n = Number(maxTokens) || 0;
  if (n >= 4500) return { kind: "lesson", cap: 6000 };
  if (n >= 3500) return { kind: "course", cap: 4000 };
  return { kind: "free", cap: 1000 };
}

export function planFor(planName, isTrialing) {
  if (isTrialing) return { key: "trial", plan: PLANS.trial };
  // An unrecognised plan name falls back to the smallest tier, never the
  // largest, so a bad row cannot hand out Max limits.
  const key = planName && PLANS[planName] ? planName : "basic";
  return { key, plan: PLANS[key] };
}

export const CONCEPT_RE = /Identify\s+(?:exactly\s+)?\d+(?:\s*[-–]\s*\d+)?\s+core concepts/i;

export function fixCourseSize(text, n) {
  if (CONCEPT_RE.test(text)) {
    return text.replace(CONCEPT_RE, `Identify exactly ${n} core concepts`);
  }
  return `${text}\n\nIMPORTANT: return exactly ${n} concepts, no more and no fewer.`;
}

export function clampText(text, budget) {
  return text.length > budget ? text.slice(0, budget) : text;
}

/**
 * Accept a message's `content` in either shape and return plain text blocks.
 *
 * Legacy clients send a string. A caching client sends
 * `[<shared document>, <this lesson's prompt>]`, and the split is the whole
 * point: caching matches on a prefix, so the half that repeats has to be a
 * separate block, and it has to come first.
 *
 * Only text blocks are allowed through. The client does not get to name block
 * types — that is how it would smuggle in an image, a document, or a
 * `cache_control` of its own choosing.
 */
export function normaliseContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return null;
  if (!content.length || content.length > MAX_CONTENT_BLOCKS) return null;

  const blocks = [];
  for (const block of content) {
    if (typeof block === "string") { blocks.push({ type: "text", text: block }); continue; }
    if (!block || block.type !== "text" || typeof block.text !== "string") return null;
    blocks.push({ type: "text", text: block.text });
  }
  return blocks;
}

/**
 * Clamp one message's blocks to the tier and mark the cacheable one.
 *
 * On a lesson call with two or more blocks, the first is the shared document
 * context and the rest are this lesson's prompt. The first is clamped to
 * `contextChars`, the rest share `excerptChars` plus the template allowance,
 * and `cache_control` goes on the first only if the tier funds it and the
 * block is long enough for the model to actually cache.
 *
 * A one-hour TTL costs twice a normal write against a five-minute TTL's 1.25x,
 * and breaks even on the third read rather than the second. Lessons are opened
 * when a learner reaches them, not in a batch, so the shorter window is the
 * one whose downside is bounded: someone working through two lessons in a
 * sitting still wins, and someone doing one a day pays 25% more on the input
 * half of a single call rather than 100%.
 */
export function prepareBlocks(blocks, { kind, plan, model }) {
  const cacheable = kind === "lesson" && blocks.length >= 2 && plan.contextChars > 0;

  if (!cacheable) {
    const budget = kind === "free" ? FREE_CALL_CHARS
      : (kind === "course" ? plan.readChars : plan.excerptChars) + TEMPLATE_ALLOWANCE;
    // Without a cache split every block shares one budget, so a client cannot
    // buy extra document by chopping the same text into more blocks.
    let remaining = budget;
    return blocks.map(block => {
      const text = clampText(block.text, Math.max(0, remaining));
      remaining -= text.length;
      return { type: "text", text };
    });
  }

  const context = clampText(blocks[0].text, plan.contextChars);
  const rest = [];
  let remaining = plan.excerptChars + TEMPLATE_ALLOWANCE;
  for (const block of blocks.slice(1)) {
    const text = clampText(block.text, Math.max(0, remaining));
    remaining -= text.length;
    rest.push({ type: "text", text });
  }

  const first = { type: "text", text: context };
  if (context.length >= minCacheChars(model)) {
    first.cache_control = { type: "ephemeral" };   // 5-minute TTL, the default
  }
  return [first, ...rest];
}

/**
 * Streaming.
 *
 * A lesson is up to 6,000 output tokens and a Max course plan is 4,000 of
 * Opus's, and output tokens are generated one at a time: that is minutes of
 * wall clock no amount of clamping removes. Held as one request/response the
 * caller sees nothing at all until the last token lands — and past a certain
 * length nothing is what it sees, because a non-streamed request is also the
 * one that hits a gateway's idle timeout.
 *
 * So the proxy streams. The bytes go to the browser as they arrive, which
 * moves the wait from "a spinner for two minutes" to "text appearing", and
 * removes the timeout with it.
 *
 * The client asks for it (`stream: true`) rather than getting it whichever way
 * the function was last deployed: a browser that predates this still sends
 * nothing and still gets one JSON body back. Old client, new function; new
 * client, old function — both work, which is what lets the two be deployed in
 * either order.
 */
export function wantsStream(body) {
  return body?.stream === true;
}

/**
 * Split an SSE byte stream into the JSON payloads it carries.
 *
 * Chunks arrive at whatever boundary the network chose — half a frame, three
 * frames, a frame split mid-word — so the scanner keeps the tail and only
 * emits frames terminated by a blank line. Everything else here is a
 * consequence of that: parse nothing until the frame is whole.
 *
 * Returns the parsed `data:` payloads. A frame whose data is not JSON (the
 * `[DONE]` sentinel other vendors send, a comment keep-alive) is skipped
 * rather than thrown, because a passthrough must survive frames it does not
 * understand.
 */
export function sseScanner() {
  let buffer = "";
  return function push(chunk) {
    buffer += chunk;
    const out = [];
    // \r\n\r\n is as legal a frame terminator as \n\n, and a proxy that
    // rewrites line endings would otherwise silently stop the whole stream.
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";
    for (const frame of parts) {
      const data = frame
        .split(/\r?\n/)
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try { out.push(JSON.parse(data)); } catch { /* not ours to interpret */ }
    }
    return out;
  };
}

/**
 * Usage, accumulated from the events rather than read off a finished body.
 *
 * A stream reports its cost in two places: `message_start` carries the input
 * side (including the cache read and write, which is the number that says
 * whether the shared context paid for itself), and `message_delta` carries a
 * running output count whose last value is the total. Neither alone is the
 * bill.
 *
 * `sawUsage` is what the caller meters on. A stream that broke halfway
 * reports the tokens it did use — the tokens were spent whether or not the
 * learner got a lesson out of them, and not recording them is how usage
 * accounting quietly drifts from what the API charged.
 */
export function streamUsage() {
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let seen = false;

  return {
    feed(event) {
      const u = event?.type === "message_start" ? event.message?.usage : event?.usage;
      if (!u) return;
      seen = true;
      // input and cache figures are stated once, on message_start; output is
      // restated on every delta and the last one wins.
      for (const key of ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
        if (Number.isFinite(Number(u[key]))) totals[key] = Math.max(totals[key], Number(u[key]) || 0);
      }
      if (Number.isFinite(Number(u.output_tokens))) totals.output_tokens = Number(u.output_tokens) || 0;
    },
    get sawUsage() { return seen; },
    result() { return usageFrom(totals); },
  };
}

/**
 * Cache accounting, straight from the response.
 *
 * `input_tokens` is only the uncached remainder — the three fields have to be
 * added to get what the request actually read. Reporting `input_tokens` alone
 * as "tokens used" would make every cache hit look like a request that read
 * almost nothing.
 */
export function usageFrom(usage) {
  const u = usage || {};
  const input = Number(u.input_tokens) || 0;
  const output = Number(u.output_tokens) || 0;
  const cacheWrite = Number(u.cache_creation_input_tokens) || 0;
  const cacheRead = Number(u.cache_read_input_tokens) || 0;
  return {
    input,
    output,
    cacheWrite,
    cacheRead,
    totalRead: input + cacheWrite + cacheRead,
    hit: cacheRead > 0,
  };
}
