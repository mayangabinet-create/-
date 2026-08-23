import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

import { CHECKOUT_PLANS, priceMapFromEnv } from "../_shared/stripe-policy.mjs";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Unset until the app's real domain is settled (see README — GitHub Pages
// isn't enabled yet). Until then any https origin the browser itself sends
// is trusted for the post-checkout redirect: the worst a forged one buys is
// sending the caller's own browser to a page of the caller's own choosing,
// since the session can only ever act on its own account.
const ALLOWED_ORIGIN = Deno.env.get("STRIPE_ALLOWED_ORIGIN") || null;

const stripe = new Stripe(STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
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
  if (userErr || !user || !user.email) {
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
  const priceId = PRICE_MAP[plan];
  if (!priceId) {
    return json({
      error: "plan_not_configured",
      message: `No Stripe price is configured for the ${plan} plan yet.`,
    }, 500);
  }

  const origin = typeof body?.origin === "string" ? body.origin : req.headers.get("origin");
  if (!origin || !/^https:\/\//.test(origin) || (ALLOWED_ORIGIN && origin !== ALLOWED_ORIGIN)) {
    return json({ error: "invalid_origin" }, 400);
  }

  // Service-role client — bypasses RLS. Used only to read/write this
  // account's own Stripe customer id, keyed by their own verified user id.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: existing } = await admin
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();

    let customerId = existing?.stripe_customer_id || null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
      if (existing) {
        await admin.from("subscriptions").update({ stripe_customer_id: customerId }).eq("user_id", user.id);
      } else {
        // Should not normally happen — the trial trigger creates this row at
        // signup — but a checkout attempt must never be blocked by it being
        // missing. "incomplete" grants nothing: ai-proxy only treats
        // "active"/"trialing" as an entitlement, so this placeholder can't
        // itself unlock anything ahead of the webhook confirming payment.
        await admin.from("subscriptions").insert({ user_id: user.id, stripe_customer_id: customerId, status: "incomplete" });
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/?checkout=success`,
      cancel_url: `${origin}/?checkout=cancel`,
      client_reference_id: user.id,
      subscription_data: { metadata: { supabase_user_id: user.id, plan } },
    });

    return json({ url: session.url }, 200);
  } catch (err) {
    console.error("stripe-checkout failed:", err instanceof Error ? err.message : err);
    return json({ error: "checkout_failed", message: "Could not start checkout. Try again in a moment." }, 502);
  }
});
