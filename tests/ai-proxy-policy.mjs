/*
 * ai-proxy policy checks — tiers, classification, clamping, and which block
 * gets cached.
 *
 *     node tests/ai-proxy-policy.mjs
 *
 * These import the same module the Edge Function imports, so they test the
 * shipping rules rather than a copy. No Deno, no network, no account: the
 * handler does the I/O, `policy.mjs` makes the decisions, and the decisions
 * are the part that costs money when it is wrong.
 */

import {
  CHARS_PER_TOKEN,
  FREE_CALL_CHARS,
  HAIKU,
  KNOWN_TASKS,
  MAX_CONTENT_BLOCKS,
  OPUS,
  PLANS,
  SONNET,
  TEMPLATE_ALLOWANCE,
  UNLIMITED,
  classify,
  lessonAllowance,
  fixCourseSize,
  minCacheChars,
  normaliseContent,
  planFor,
  prepareBlocks,
  usageFrom,
} from "../supabase/functions/ai-proxy/policy.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "\n       " + extra : "")); }
};

const chars = (n, c = "x") => c.repeat(n);
const lessonOf = (planKey, blocks) =>
  prepareBlocks(blocks.map(text => ({ type: "text", text })),
    { kind: "lesson", plan: PLANS[planKey], model: PLANS[planKey].modelLesson });

console.log("\n== the unlimited plan ==");
{
  const plan = PLANS.unlimited;
  // The int4 boundary is the whole reason this plan needs its own arithmetic:
  // every figure that reaches consume_ai_quota is one of these two.
  const INT4_MAX = 2_147_483_647;
  ok("its monthly course limit fits in the quota function's int4",
     plan.coursesPerMonth <= INT4_MAX && Number.isInteger(plan.coursesPerMonth));
  ok("and so does its lesson allowance, which is a product",
     lessonAllowance(plan) <= INT4_MAX && Number.isInteger(lessonAllowance(plan)),
     String(lessonAllowance(plan)));
  ok("the unclamped product would not have",
     plan.coursesPerMonth * plan.lessonsPerCourse > INT4_MAX);

  // Infinity is the tempting way to write this and the one that silently
  // denies everything: JSON has no Infinity, so it reaches Postgres as null,
  // and `courses_month < null` is null.
  ok("no plan uses Infinity, which JSON would turn into null",
     Object.values(PLANS).every(p => Number.isFinite(p.coursesPerMonth) && Number.isFinite(p.lessonsPerCourse)));
  ok("every plan's allowance survives the same trip",
     Object.values(PLANS).every(p => Number.isInteger(lessonAllowance(p)) && lessonAllowance(p) <= INT4_MAX));
  ok("JSON.stringify keeps it a number", JSON.parse(JSON.stringify({ n: UNLIMITED })).n === UNLIMITED);

  ok("it reads and writes at the largest tier's budgets",
     plan.readChars === PLANS.max.readChars && plan.excerptChars === PLANS.max.excerptChars
     && plan.contextChars === PLANS.max.contextChars);
  // A course is planned by rewriting a number into the prompt. That number is
  // this one, so it has to stay a plausible number of concepts.
  ok("its lessons-per-course stays a number a course can be built from",
     plan.lessonsPerCourse > 0 && plan.lessonsPerCourse <= 30);
  ok("a lesson on it is still clamped to the tier's excerpt",
     lessonOf("unlimited", [chars(60_000), chars(60_000)])[1].text.length
       === PLANS.unlimited.excerptChars + TEMPLATE_ALLOWANCE);

  // It is granted, never sold or guessed into.
  ok("an unrecognised plan name still falls back to basic, not to this one",
     planFor("unlimted", false).key === "basic" && planFor(null, false).key === "basic");
  ok("a trialing account cannot be on it", planFor("unlimited", true).key === "trial");
  ok("but a granted one is", planFor("unlimited", false).key === "unlimited");
}

console.log("\n== classification ==");
{
  ok("a lesson is bought at 5000", classify(5000).kind === "lesson");
  ok("a course is bought at 4000", classify(4000).kind === "course");
  ok("feedback is free work", classify(250).kind === "free");
  ok("just under the course line buys nothing", classify(3499).kind === "free");
  ok("a free call is capped at 1000 output", classify(250).cap === 1000);
  ok("garbage max_tokens is free work", classify(undefined).kind === "free");
  ok("a huge max_tokens is still capped", classify(999999).cap === 6000);
  // A client from before the cap rose asks for 5000 and must still buy a
  // lesson: the threshold is what classifies, the cap is only the ceiling.
  ok("an older client still buys a lesson at 5000", classify(5000).cap === 6000);
  // The dock is gone from the client, but the client being served still sends
  // this label. A server that stops accepting it 400s a request that worked
  // yesterday — the allowlist has to lag the client, not lead it.
  ok("the tutor label is still accepted while old clients send it", KNOWN_TASKS.has("tutor"));
  ok("a tutor call is free work, so it is capped and metered", classify(400).kind === "free");
}

console.log("\n== tier resolution ==");
{
  ok("a trialing user gets trial limits", planFor("max", true).key === "trial");
  ok("an unknown plan falls back to basic", planFor("enterprise", false).key === "basic");
  ok("a missing plan falls back to basic", planFor(undefined, false).key === "basic");
  ok("a real plan is honoured", planFor("pro", false).plan.excerptChars === 8_000);
}

console.log("\n== content normalisation ==");
{
  ok("a legacy string becomes one block",
     normaliseContent("hello")?.length === 1);
  ok("an array of text blocks passes",
     normaliseContent([{ type: "text", text: "a" }, { type: "text", text: "b" }])?.length === 2);
  ok("bare strings in an array are accepted",
     normaliseContent(["a", "b"])?.[1].text === "b");
  // The client does not get to name block types — that is how it would smuggle
  // in an image, a document, or a cache_control of its own.
  ok("a non-text block is rejected",
     normaliseContent([{ type: "image", source: {} }]) === null);
  ok("a client-supplied cache_control is not carried through",
     normaliseContent([{ type: "text", text: "a", cache_control: { type: "ephemeral" } }])[0].cache_control === undefined);
  ok("an empty array is rejected", normaliseContent([]) === null);
  ok("too many blocks are rejected",
     normaliseContent(Array(MAX_CONTENT_BLOCKS + 1).fill("x")) === null);
  ok("a number is rejected", normaliseContent(42) === null);
}

console.log("\n== clamping ==");
{
  const [only] = lessonOf("basic", [chars(500_000)]);
  ok("one oversized block is cut to the tier",
     only.text.length === PLANS.basic.excerptChars + TEMPLATE_ALLOWANCE, String(only.text.length));

  // Without a shared budget a client could buy extra document simply by
  // chopping the same text into more blocks.
  const split = lessonOf("basic", [chars(100_000), chars(100_000), chars(100_000)]);
  const total = split.reduce((n, b) => n + b.text.length, 0);
  ok("splitting into blocks does not buy more document",
     total === PLANS.basic.excerptChars + TEMPLATE_ALLOWANCE, String(total));

  const free = prepareBlocks([{ type: "text", text: chars(100_000) }],
    { kind: "free", plan: PLANS.basic, model: HAIKU });
  ok("a free call has its own budget", free[0].text.length === FREE_CALL_CHARS);

  const course = prepareBlocks([{ type: "text", text: chars(500_000) }],
    { kind: "course", plan: PLANS.max, model: OPUS });
  ok("a course call gets the tier's read budget",
     course[0].text.length === PLANS.max.readChars + TEMPLATE_ALLOWANCE, String(course[0].text.length));
}

console.log("\n== caching ==");
{
  const [context, prompt] = lessonOf("pro", [chars(PLANS.pro.contextChars), "the concept"]);
  ok("the shared block is cached", context.cache_control?.type === "ephemeral");
  ok("the shared block is clamped to contextChars",
     context.text.length === PLANS.pro.contextChars, String(context.text.length));
  ok("the volatile block is never cached", prompt.cache_control === undefined);
  ok("the volatile block keeps its own budget", prompt.text === "the concept");

  // A prefix under the model's minimum is accepted by the API, reported as
  // zero cached tokens, and billed at the write premium — a silent loss.
  const short = lessonOf("pro", [chars(minCacheChars(SONNET) - 1), "q"]);
  ok("a prefix below the model minimum is not marked cacheable",
     short[0].cache_control === undefined);
  const exact = lessonOf("pro", [chars(minCacheChars(SONNET)), "q"]);
  ok("a prefix at exactly the minimum is cacheable",
     exact[0].cache_control?.type === "ephemeral");

  ok("Haiku's minimum is the highest of the three",
     minCacheChars(HAIKU) > minCacheChars(SONNET) && minCacheChars(SONNET) > minCacheChars(OPUS));
  ok("the minimum is computed conservatively",
     minCacheChars(SONNET) === 1024 * CHARS_PER_TOKEN);

  // Trial and Basic run on Haiku with contextChars 0 — the feature is off
  // there on purpose, and off must mean no write premium.
  const basic = lessonOf("basic", [chars(200_000), "q"]);
  ok("a tier with no context budget caches nothing",
     basic.every(b => b.cache_control === undefined));
  ok("and its blocks still share one budget",
     basic.reduce((n, b) => n + b.text.length, 0) === PLANS.basic.excerptChars + TEMPLATE_ALLOWANCE);

  // Max plans on Opus but writes lessons on Sonnet, so the lesson block is
  // measured against Sonnet's minimum, not Opus's.
  ok("max lessons are measured against the lesson model",
     PLANS.max.modelLesson === SONNET && PLANS.max.contextChars >= minCacheChars(SONNET));

  const single = lessonOf("pro", [chars(50_000)]);
  ok("a single block is not treated as a cacheable prefix",
     single[0].cache_control === undefined);

  const courseCall = prepareBlocks(
    [{ type: "text", text: chars(50_000) }, { type: "text", text: "q" }],
    { kind: "course", plan: PLANS.pro, model: SONNET });
  ok("course calls are never cached (one call per course, nothing to reuse)",
     courseCall.every(b => b.cache_control === undefined));
}

console.log("\n== course size rewrite ==");
{
  ok("a range is rewritten to the tier's number",
     fixCourseSize("Identify 10-20 core concepts a learner must", 12)
       .includes("Identify exactly 12 core concepts"));
  ok("an already-exact count is still rewritten",
     fixCourseSize("Identify exactly 30 core concepts", 10)
       .includes("Identify exactly 10 core concepts"));
  ok("an unrecognised prompt gets the constraint appended",
     fixCourseSize("Do whatever you like", 15).includes("exactly 15 concepts"));
}

console.log("\n== usage accounting ==");
{
  // input_tokens is only the uncached remainder — reporting it alone as
  // "tokens used" makes a cache hit look like a request that read nothing.
  const hit = usageFrom({ input_tokens: 300, output_tokens: 900, cache_read_input_tokens: 24_000 });
  ok("a cache hit is recorded as a hit", hit.hit === true);
  ok("a cache hit counts what was actually read", hit.totalRead === 24_300, String(hit.totalRead));

  const write = usageFrom({ input_tokens: 300, output_tokens: 900, cache_creation_input_tokens: 24_000 });
  ok("a cache write is not a hit", write.hit === false);
  ok("a cache write counts what was read", write.totalRead === 24_300);
  ok("a write is reported separately from a read",
     write.cacheWrite === 24_000 && write.cacheRead === 0);

  const plain = usageFrom({ input_tokens: 1_000, output_tokens: 500 });
  ok("an uncached call is unchanged", plain.totalRead === 1_000 && plain.hit === false);
  ok("a missing usage object does not throw", usageFrom(undefined).totalRead === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
