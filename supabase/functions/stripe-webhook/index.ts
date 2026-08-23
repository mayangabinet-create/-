import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

import { priceMapFromEnv, rowFromSubscription, upsertPatchFor } from "../_shared/stripe-policy.mjs";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const stripe = new Stripe(STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
const PRICE_MAP = priceMapFromEnv((k) => Deno.env.get(k));

// Deploy this one function with `--no-verify-jwt` (see README): Stripe calls
// it directly, with no Supabase session to present, and signs the body with
// STRIPE_WEBHOOK_SECRET instead — checked below before anything in the
// payload is trusted.
async function applySubscription(admin: ReturnType<typeof createClient>, userId: string, sub: any) {
  const row = rowFromSubscription(sub, PRICE_MAP);
  const patch = upsertPatchFor(userId, row);
  const { error } = await admin.from("subscriptions").upsert(patch, { onConflict: "user_id" });
  if (error) console.error("subscriptions upsert failed:", error.message);
}

// Every event carries the subscription's own metadata when it was set at
// creation (checkout.session.completed sets it below), so this is the
// fallback for the rare event that doesn't — e.g. a subscription created
// directly in the Stripe dashboard rather than through our checkout.
async function resolveUserId(admin: ReturnType<typeof createClient>, sub: any): Promise<string | null> {
  if (sub.metadata?.supabase_user_id) return sub.metadata.supabase_user_id;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  if (!customerId) return null;
  const { data } = await admin
    .from("subscriptions")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  return data?.user_id ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const signature = req.headers.get("stripe-signature");
  const payload = await req.text();
  if (!signature) {
    return new Response("Missing signature", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(payload, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err instanceof Error ? err.message : err);
    return new Response("Invalid signature", { status: 400 });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as any;
      if (session.mode === "subscription" && session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription as string);
        const userId = session.client_reference_id || (await resolveUserId(admin, sub));
        if (userId) await applySubscription(admin, userId, sub);
        else console.error("checkout.session.completed with no resolvable user_id:", session.id);
      }
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      // A cancellation already arrives with status "canceled" on the same
      // object shape an update does, so both events share this one path.
      const sub = event.data.object as any;
      const userId = await resolveUserId(admin, sub);
      if (userId) await applySubscription(admin, userId, sub);
      else console.error(`${event.type} with no resolvable user_id:`, sub.id);
    }
  } catch (err) {
    console.error(`Error handling ${event.type}:`, err instanceof Error ? err.message : err);
    return new Response("Internal error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
});
