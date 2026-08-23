import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { CHECKOUT_PLANS, priceMapFromEnv, lowProfileCreateBody } from "../_shared/cardcom-policy.mjs";

const CARDCOM_API_URL = "https://secure.cardcom.solutions/api/v11";
const CARDCOM_TERMINAL_ID = Deno.env.get("CARDCOM_TERMINAL_ID")!;
const CARDCOM_API_NAME = Deno.env.get("CARDCOM_API_NAME")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Unset until this secret is set by hand in the Supabase dashboard, same
// idiom as STRIPE_ALLOWED_ORIGIN was. Until then any https origin the
// browser itself sends is trusted for the post-checkout redirect: the worst
// a forged one buys is sending the caller's own browser to a page of their
// own choosing, since every call still only ever acts on the caller's own
// account.
const ALLOWED_ORIGIN = Deno.env.get("CARDCOM_ALLOWED_ORIGIN") || null;

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
      message: `No Cardcom price is configured for the ${plan} plan yet.`,
    }, 500);
  }

  const origin = typeof body?.origin === "string" ? body.origin : req.headers.get("origin");
  if (!origin || !/^https:\/\//.test(origin) || (ALLOWED_ORIGIN && origin !== ALLOWED_ORIGIN)) {
    return json({ error: "invalid_origin" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const createBody = lowProfileCreateBody({
      plan,
      amount,
      terminalId: CARDCOM_TERMINAL_ID,
      apiName: CARDCOM_API_NAME,
      successUrl: `${origin}/?checkout=success`,
      failUrl: `${origin}/?checkout=cancel`,
      webhookUrl: `${SUPABASE_URL}/functions/v1/cardcom-webhook`,
    });

    const res = await fetch(`${CARDCOM_API_URL}/LowProfile/Create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createBody),
    });
    const data = await res.json();

    if (data?.ResponseCode !== 0 || !data?.Url || !data?.LowProfileId) {
      console.error("cardcom-checkout: LowProfile/Create failed:", data);
      return json({ error: "checkout_failed", message: "Could not start checkout. Try again in a moment." }, 502);
    }

    // Correlates the webhook -- which is never trusted for who or what, see
    // cardcom-webhook -- back to this account and the plan they picked.
    const { error: insertErr } = await admin.from("cardcom_pending_checkout").insert({
      low_profile_id: data.LowProfileId,
      user_id: user.id,
      plan,
    });
    if (insertErr) {
      console.error("cardcom-checkout: failed to record pending checkout:", insertErr.message);
      return json({ error: "checkout_failed", message: "Could not start checkout. Try again in a moment." }, 502);
    }

    return json({ url: data.Url }, 200);
  } catch (err) {
    console.error("cardcom-checkout failed:", err instanceof Error ? err.message : err);
    return json({ error: "checkout_failed", message: "Could not start checkout. Try again in a moment." }, 502);
  }
});
