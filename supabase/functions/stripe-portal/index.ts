import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ALLOWED_ORIGIN = Deno.env.get("STRIPE_ALLOWED_ORIGIN") || null;

const stripe = new Stripe(STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });

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

// Opens Stripe's own Customer Portal — cancellation, payment method updates,
// invoice history — rather than reimplementing any of it here. Nothing this
// function does changes `subscriptions`; whatever the account does in the
// portal comes back through stripe-webhook the same way checkout does.
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

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // A body is optional here (only `origin` is read from it).
  }

  const origin = typeof body?.origin === "string" ? body.origin : req.headers.get("origin");
  if (!origin || !/^https:\/\//.test(origin) || (ALLOWED_ORIGIN && origin !== ALLOWED_ORIGIN)) {
    return json({ error: "invalid_origin" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: sub } = await admin
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!sub?.stripe_customer_id) {
    return json({ error: "no_stripe_customer", message: "Subscribe to a plan first, then manage billing here." }, 404);
  }

  try {
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${origin}/`,
    });
    return json({ url: portalSession.url }, 200);
  } catch (err) {
    console.error("stripe-portal failed:", err instanceof Error ? err.message : err);
    return json({ error: "portal_failed", message: "Could not open billing. Try again in a moment." }, 502);
  }
});
