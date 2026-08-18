import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import {
  classify,
  FREE_CALLS_PER_DAY,
  fixCourseSize,
  KNOWN_TASKS,
  normaliseContent,
  planFor,
  prepareBlocks,
  shouldFixCourseSize,
  sseScanner,
  streamUsage,
  TEMPLATE_ALLOWANCE,
  clampText,
  usageFrom,
  wantsStream,
} from "./policy.mjs";

// The one place the real Anthropic key lives. Never sent to the browser.
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

/**
 * Record what the call cost.
 *
 * The six-argument form needs the `ai_usage_cache_tokens` migration. Falling
 * back to the old four-argument form means the function and the migration can
 * be deployed in either order, and — more to the point — that forgetting the
 * migration loses the cache breakdown rather than silently losing all usage
 * accounting, which is billing data.
 */
async function recordUsage(admin: any, userId: string, u: ReturnType<typeof usageFrom>) {
  const { error } = await admin.rpc("increment_ai_usage", {
    p_user_id: userId,
    p_input_tokens: u.input,
    p_output_tokens: u.output,
    p_cache_hit: u.hit,
    p_cache_write: u.cacheWrite,
    p_cache_read: u.cacheRead,
  });
  if (!error) return;

  console.warn("increment_ai_usage (6-arg) failed, falling back:", error.message);
  const { error: legacyError } = await admin.rpc("increment_ai_usage", {
    p_user_id: userId,
    p_input_tokens: u.input,
    p_output_tokens: u.output,
    p_cache_hit: u.hit,
  });
  if (legacyError) console.error("increment_ai_usage failed:", legacyError);
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

  const { plan } = planFor(sub?.plan, isTrialing);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { system, messages, max_tokens, task } = body;
  const stream = wantsStream(body);
  if (!messages || !Array.isArray(messages) || !messages.length) {
    return json({ error: "messages is required" }, 400);
  }
  // Used for telemetry and nothing that costs money. Reject an unknown value
  // rather than letting it fall through to a default.
  if (task !== undefined && task !== null && !KNOWN_TASKS.has(task)) {
    return json({ error: "unknown_task" }, 400);
  }

  const { kind, cap } = classify(max_tokens);
  const model = kind === "course" ? plan.modelCourse : plan.modelLesson;

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
        message: `You've hit today's limit of ${FREE_CALLS_PER_DAY} free calls. It resets at midnight UTC.`,
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
  const safeMessages = [];
  for (const message of messages) {
    const blocks = normaliseContent(message?.content);
    if (!blocks) {
      return json({ error: "invalid_content" }, 400);
    }
    const prepared = prepareBlocks(blocks, { kind, plan, model });
    if (shouldFixCourseSize(kind, task)) {
      // The client asks for a fixed number of concepts, but it is the client
      // asking. Rewrite it to the tier's number so a course is a known
      // quantity before it is built — unless this is a worksheet call, which
      // asked to enumerate the material's own exercises instead of
      // synthesizing a topic list of any particular size.
      const last = prepared.length - 1;
      prepared[last] = { ...prepared[last], text: fixCourseSize(prepared[last].text, plan.lessonsPerCourse) };
    }
    safeMessages.push({ ...message, content: prepared });
  }

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
      ...(stream ? { stream: true } : {}),
    }),
  });

  // A refused request is a JSON body whichever mode was asked for — an
  // overloaded model, a bad key, a rate limit. It is short, it is the whole
  // answer, and the client's error handling already reads it, so it goes back
  // as it arrives rather than being wrapped in an event stream.
  if (stream && anthropicRes.ok && anthropicRes.body) {
    return streamThrough(anthropicRes, admin, user.id);
  }

  const result = await anthropicRes.json();

  if (anthropicRes.ok && result.usage) {
    await recordUsage(admin, user.id, usageFrom(result.usage));
  }

  return new Response(JSON.stringify(result), {
    status: anthropicRes.status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
});

/**
 * Hand the model's stream to the browser, and read the meter on the way past.
 *
 * The bytes are forwarded untouched — the client parses the same events
 * Anthropic emits, so nothing here has to understand a lesson. What this does
 * understand is cost: the scanner picks the usage out of `message_start` and
 * `message_delta` as they go by, and `flush` writes the total once the stream
 * ends. Usage has to be recorded from inside the pipe because there is no
 * "after the response" left to do it in — the response *is* the pipe.
 *
 * A stream that dies halfway still lands in `flush`, so a lesson that failed
 * to finish is still billed for the tokens it burned. Losing those is how the
 * quota starts disagreeing with the invoice.
 */
function streamThrough(anthropicRes: Response, admin: any, userId: string) {
  const scan = sseScanner();
  const meter = streamUsage();
  const decoder = new TextDecoder();

  const passthrough = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      // `stream: true` keeps a multi-byte character split across two chunks
      // from decoding as two replacement characters — which would corrupt
      // exactly the Hebrew these courses are written in, if we were rewriting
      // the bytes. We are not; this copy is only read for the numbers.
      for (const event of scan(decoder.decode(chunk, { stream: true }))) {
        meter.feed(event);
      }
    },
    async flush() {
      if (meter.sawUsage) await recordUsage(admin, userId, meter.result());
    },
  });

  return new Response(anthropicRes.body!.pipeThrough(passthrough), {
    status: 200,
    headers: {
      ...corsHeaders,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      // Some proxies buffer a response until it closes, which would give the
      // client one long silence and then everything at once — the exact
      // failure streaming exists to remove.
      "x-accel-buffering": "no",
    },
  });
}
