// ---------------------------------------------------------------------------
// REFERENCE COPY of the deployed `ai-proxy` Edge Function.
//
// The deployment in the Supabase project ("Mayan ai app", kgkdkkqoebnpahvetwzk)
// is the source of truth — this file is checked in so the server-side rules are
// readable next to the client that has to match them. Editing it changes
// nothing on its own; deploy the function and then update this copy so the two
// don't drift.
//
// Captured from version 4 (ezbr_sha256 254610a08c643234f33366536ca1f507f78b1468d76c3fd735c81d4bb7fac8d9).
// `PLANS` below is mirrored in app.js — change one and you must change the other.
// ---------------------------------------------------------------------------

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// The one place the real Anthropic key lives. Never sent to the browser.
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// The same table `app.js` carries, and the authority. The client's copy shapes
// the UI and the excerpt it builds; this one decides what actually runs. A
// modified client can send any prompt it likes, so every limit here is a clamp.
type Plan = {
  coursesPerMonth: number;
  lessonsPerCourse: number;
  readChars: number;      // of the source document, on a course-plan call
  excerptChars: number;   // of the source document, on a lesson call
  modelCourse: string;
  modelLesson: string;
};

const HAIKU = "claude-haiku-4-5";
const SONNET = "claude-sonnet-5";
const OPUS = "claude-opus-5";

const PLANS: Record<string, Plan> = {
  // One course for the whole trial — a lifetime total, not a daily allowance.
  // A daily floor multiplies by however many days the trial runs; a total does
  // not. Trial runs on the cheapest model at the smallest tier's limits: it is
  // there to show what the product does, not to preview what you might buy.
  trial: { coursesPerMonth: 1, lessonsPerCourse: 10, readChars: 5_000, excerptChars: 2_400, modelCourse: HAIKU, modelLesson: HAIKU },
  basic: { coursesPerMonth: 3, lessonsPerCourse: 10, readChars: 5_000, excerptChars: 2_400, modelCourse: HAIKU, modelLesson: HAIKU },
  pro:   { coursesPerMonth: 5, lessonsPerCourse: 12, readChars: 40_000, excerptChars: 8_000, modelCourse: SONNET, modelLesson: SONNET },
  // Opus plans the course and Sonnet writes the lessons. Choosing which
  // concepts exist and in what prerequisite order is the one hard reasoning
  // step and it is a single call; writing a lesson from a chosen concept and a
  // retrieved passage is routine. Opus for everything costs a third more for
  // no gain on the part anyone judges.
  max:   { coursesPerMonth: 8, lessonsPerCourse: 15, readChars: 120_000, excerptChars: 16_000, modelCourse: OPUS, modelLesson: SONNET },
};

// Chars of prompt template to allow on top of the tier's document budget. The
// lesson template alone is ~6,500 chars, so this has to be generous enough
// never to truncate the instructions themselves.
const TEMPLATE_ALLOWANCE = 12_000;
const FREE_CALL_CHARS = 20_000;   // tutor/feedback carry conversation context

// Tutor and feedback are unmetered so that someone who has spent their quota
// still has the courses they paid for. Unmetered is not unlimited: a runaway
// loop would still cost money, so they keep the old daily backstop.
const FREE_CALLS_PER_DAY = 200;

const KNOWN_TASKS = new Set(["path", "lesson", "tutor", "feedback"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

// What is being bought is derived from max_tokens, never from the client's
// `task` label: a course plan asks for 4000 and a lesson for 5000, while tutor
// (400) and feedback (250) sit far below. Anything under the course threshold
// is clamped to 1000 output tokens, so a request crafted just below the line
// cannot buy a lesson's worth of generation for free.
function classify(maxTokens: number): { kind: "course" | "lesson" | "free"; cap: number } {
  if (maxTokens >= 4500) return { kind: "lesson", cap: 5000 };
  if (maxTokens >= 3500) return { kind: "course", cap: 4000 };
  return { kind: "free", cap: 1000 };
}

// The client asks for a fixed number of concepts, but it is the client asking.
// Rewrite it to the tier's number so a course is a known quantity before it is
// built — without this the same course costs anywhere from 10 to 20 lessons.
const CONCEPT_RE = /Identify\s+(?:exactly\s+)?\d+(?:\s*[-–]\s*\d+)?\s+core concepts/i;

function fixCourseSize(text: string, n: number): string {
  if (CONCEPT_RE.test(text)) {
    return text.replace(CONCEPT_RE, `Identify exactly ${n} core concepts`);
  }
  // Prompt didn't match the shape we expect — state the constraint rather than
  // letting an unrecognised prompt through unbounded.
  return `${text}\n\nIMPORTANT: return exactly ${n} concepts, no more and no fewer.`;
}

function clampText(text: string, budget: number): string {
  return text.length > budget ? text.slice(0, budget) : text;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing Authorization header" }, 401);
  }

  // Scoped to the caller's own JWT — identifies who is asking, nothing more.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) {
    return json({ error: "Invalid session" }, 401);
  }

  // Service-role client — bypasses RLS. Used only to check entitlement and log usage.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: sub } = await admin
    .from("subscriptions")
    .select("status, current_period_end, plan")
    .eq("user_id", user.id)
    .maybeSingle();

  const now = new Date();
  const isActive = sub?.status === "active";
  const isTrialing = sub?.status === "trialing" && !!sub.current_period_end &&
    new Date(sub.current_period_end) > now;

  if (!isActive && !isTrialing) {
    return json({
      error: "subscription_required",
      code: "trial_over",
      message: "Your trial has ended. Subscribe to keep generating lessons.",
    }, 402);
  }

  // Without this, one person with throwaway addresses repeats the trial at
  // will and the lifetime cap means nothing. OAuth sign-ins arrive confirmed.
  if (isTrialing && !user.email_confirmed_at) {
    return json({
      error: "email_unconfirmed",
      code: "email_unconfirmed",
      message: "Confirm your email address, then come back and build your course.",
    }, 429);
  }

  // An unrecognised plan name falls back to the smallest tier, never the
  // largest, so a bad row can't hand out Max limits.
  const planKey = isTrialing ? "trial" : (sub?.plan && PLANS[sub.plan] ? sub.plan : "basic");
  const plan = PLANS[planKey];

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { system, messages, max_tokens, task } = body;
  if (!messages || !Array.isArray(messages) || !messages.length) {
    return json({ error: "messages is required" }, 400);
  }
  // Used for telemetry and nothing that costs money. Reject an unknown value
  // rather than letting it fall through to a default.
  if (task !== undefined && task !== null && !KNOWN_TASKS.has(task)) {
    return json({ error: "unknown_task" }, 400);
  }

  const { kind, cap } = classify(Number(max_tokens) || 0);

  // Quota. Metered work checks and increments in one statement so two
  // concurrent requests can't both pass the check; free work keeps the old
  // daily backstop so an unmetered loop still can't run unbounded.
  if (kind === "free") {
    const { data: withinDaily } = await admin.rpc("consume_daily_ai_call", {
      p_user_id: user.id,
      p_limit: FREE_CALLS_PER_DAY,
    });
    if (!withinDaily) {
      return json({
        error: "daily_limit_reached",
        message: `You've hit today's limit of ${FREE_CALLS_PER_DAY} tutor questions. It resets at midnight UTC.`,
      }, 429);
    }
  } else {
    const { data: verdict, error: quotaErr } = await admin.rpc("consume_ai_quota", {
      p_user_id: user.id,
      p_kind: kind,
      p_course_limit: plan.coursesPerMonth,
      p_lesson_limit: plan.coursesPerMonth * plan.lessonsPerCourse,
      p_trialing: isTrialing,
    });
    if (quotaErr) {
      console.error("consume_ai_quota failed:", quotaErr);
      return json({ error: "quota_check_failed" }, 500);
    }
    if (verdict === "course_quota") {
      return json({
        error: "course_quota",
        code: "course_quota",
        message: isTrialing
          ? "Your free course is done. Pick a plan to keep building."
          : `You've used all ${plan.coursesPerMonth} courses this month.`,
      }, 429);
    }
    if (verdict === "lesson_quota") {
      return json({
        error: "lesson_quota",
        code: "lesson_quota",
        message: "You've used every lesson included this month.",
      }, 429);
    }
  }

  // Clamp what was sent. The client truncates to its own tier's budget, but it
  // is the client doing it, so a modified one could send 120,000 chars on Basic.
  const docBudget = kind === "course" ? plan.readChars
    : kind === "lesson" ? plan.excerptChars
    : 0;
  const charBudget = kind === "free" ? FREE_CALL_CHARS : docBudget + TEMPLATE_ALLOWANCE;

  const safeMessages = messages.map((m: any) => {
    if (typeof m?.content !== "string") return m;
    let content = clampText(m.content, charBudget);
    if (kind === "course") content = fixCourseSize(content, plan.lessonsPerCourse);
    return { ...m, content };
  });

  const model = kind === "course" ? plan.modelCourse : plan.modelLesson;

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: Math.min(Number(max_tokens) || 1024, cap),
      system: typeof system === "string" ? clampText(system, TEMPLATE_ALLOWANCE) : system,
      messages: safeMessages,
    }),
  });

  const result = await anthropicRes.json();

  if (anthropicRes.ok && result.usage) {
    const { input_tokens = 0, output_tokens = 0 } = result.usage;
    await admin.rpc("increment_ai_usage", {
      p_user_id: user.id,
      p_input_tokens: input_tokens,
      p_output_tokens: output_tokens,
      p_cache_hit: false,
    });
  }

  return new Response(JSON.stringify(result), {
    status: anthropicRes.status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
});
