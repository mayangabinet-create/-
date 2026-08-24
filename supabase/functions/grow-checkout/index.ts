import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { CHECKOUT_PLANS, priceMapFromEnv, createPaymentProcessBody } from "../_shared/grow-policy.mjs";

// Matches the real, working integration this was verified against (see
// README — Payments) — not confirmed against Grow's own docs, which weren't
// reachable while building this. Override via GROW_API_BASE_URL if Grow's
// account setup names a different host.
const GROW_API_BASE_URL = Deno.env.get("GROW_API_BASE_URL") || "https://secure.meshulam.co.il/api/light/server/1.0";
const GROW_PAGE_CODE = Deno.env.get("GROW_PAGE_CODE")!;
const GROW_USER_ID = Deno.env.get("GROW_USER_ID")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Unset until this secret is set by hand in the Supabase dashboard, same
// idiom as CARDCOM_ALLOWED_ORIGIN was. Until then any https origin the
// browser itself sends is trusted for the post-checkout redirect: the worst
// a forged one buys is sending the caller's own browser to a page of their
// own choosing, since every call still only ever acts on the caller's own
// account.
const ALLOWED_ORIGIN = Deno.env.get("GROW_ALLOWED_ORIGIN") || null;

const PRICE_MAP = priceMapFromEnv((k) => Deno.env.get(k));

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

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) {
    return json({ error: "Invalid session" }, 401);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const plan = body?.plan;
  if (!CHECKOUT_PLANS.includes(plan)) {
    return json({ error: "invalid_plan" }, 400);
  }
  const amount = PRICE_MAP[plan as "basic" | "pro" | "max"];
  if (!amount) {
    return json({
      error: "plan_not_configured",
      message: `No Grow price is configured for the ${plan} plan yet.`,
    }, 500);
  }

  const origin = typeof body?.origin === "string" ? body.origin : req.headers.get("origin");
  if (!origin || !/^https:\/\//.test(origin) || (ALLOWED_ORIGIN && origin !== ALLOWED_ORIGIN)) {
    return json({ error: "invalid_origin" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const createBody = createPaymentProcessBody({
      plan,
      amount,
      pageCode: GROW_PAGE_CODE,
      userId: GROW_USER_ID,
      successUrl: `${origin}/?checkout=success`,
      cancelUrl: `${origin}/?checkout=cancel`,
      webhookUrl: `${SUPABASE_URL}/functions/v1/grow-webhook`,
    });

    const res = await fetch(`${GROW_API_BASE_URL}/createPaymentProcess`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(createBody).toString(),
    });
    const data = await res.json();

    if (data?.status !== 1 || !data?.data?.url || !data?.data?.processId) {
      console.error("grow-checkout: createPaymentProcess failed:", data);
      return json({ error: "checkout_failed", message: "Could not start checkout. Try again in a moment." }, 502);
    }

    // Correlates the webhook — which is never trusted for who or what, see
    // grow-webhook — back to this account and the plan they picked.
    const { error: insertErr } = await admin.from("grow_pending_checkout").insert({
      process_id: String(data.data.processId),
      user_id: user.id,
      plan,
    });
    if (insertErr) {
      console.error("grow-checkout: failed to record pending checkout:", insertErr.message);
      return json({ error: "checkout_failed", message: "Could not start checkout. Try again in a moment." }, 502);
    }

    return json({ url: data.data.url }, 200);
  } catch (err) {
    console.error("grow-checkout failed:", err instanceof Error ? err.message : err);
    return json({ error: "checkout_failed", message: "Could not start checkout. Try again in a moment." }, 502);
  }
});
