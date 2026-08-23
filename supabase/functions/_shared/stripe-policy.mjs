/*
 * Pure decision logic shared between stripe-checkout, stripe-portal and
 * stripe-webhook: which Stripe Price ID belongs to which plan, and what a
 * `subscriptions` row should become after a Stripe Subscription object is
 * created, updated, or canceled. No Stripe SDK, no network, no Deno — so it
 * imports the same way from an Edge Function (relative path) and from a
 * plain node test, the same idiom ai-proxy/policy.mjs already uses.
 */

// The only plans checkout ever sells. Trial is earned, not bought, and an
// unrecognised value is never a checkout target — a client asking for
// anything else is rejected before Stripe is even called.
export const CHECKOUT_PLANS = ["basic", "pro", "max"];

export function priceMapFromEnv(getEnv) {
  return {
    basic: getEnv("STRIPE_PRICE_BASIC") || null,
    pro: getEnv("STRIPE_PRICE_PRO") || null,
    max: getEnv("STRIPE_PRICE_MAX") || null,
  };
}

export function planForPriceId(priceId, priceMap) {
  if (!priceId) return null;
  for (const plan of CHECKOUT_PLANS) {
    if (priceMap[plan] && priceMap[plan] === priceId) return plan;
  }
  return null;
}

/**
 * What a Stripe Subscription object says about the account it belongs to.
 * `status` is carried through verbatim rather than translated — ai-proxy and
 * app.js already treat anything other than exactly "active" or "trialing" as
 * no active plan, so Stripe's own vocabulary (past_due, canceled, unpaid,
 * incomplete, incomplete_expired, paused) needs no mapping here, including
 * the "canceled" a subscription.deleted event carries.
 */
export function rowFromSubscription(sub, priceMap) {
  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id ?? null;
  // Newer Stripe API versions moved current_period_end from the subscription
  // itself onto its first item; older ones only ever had it on the
  // subscription. Reading both keeps this working across that move.
  const periodEndSec = item?.current_period_end ?? sub.current_period_end ?? null;
  return {
    plan: planForPriceId(priceId, priceMap),
    status: sub.status,
    interval: item?.price?.recurring?.interval ?? null,
    currentPeriodEnd: periodEndSec ? new Date(periodEndSec * 1000).toISOString() : null,
    customerId: typeof sub.customer === "string" ? sub.customer : (sub.customer?.id ?? null),
    subscriptionId: sub.id,
  };
}

/**
 * The row patch actually written to Postgres — only the fields this event
 * could resolve, so a partial or unrecognised-price event can flip status
 * without ever overwriting a good plan/interval/period-end with a guess.
 */
export function upsertPatchFor(userId, row) {
  const patch = { user_id: userId, status: row.status };
  if (row.plan) patch.plan = row.plan;
  if (row.interval) patch.interval = row.interval;
  if (row.currentPeriodEnd) patch.current_period_end = row.currentPeriodEnd;
  if (row.customerId) patch.stripe_customer_id = row.customerId;
  if (row.subscriptionId) patch.stripe_subscription_id = row.subscriptionId;
  return patch;
}
