/*
 * stripe-policy checks — price-to-plan mapping and what a subscriptions row
 * should become after a Stripe Subscription object changes.
 *
 *     node tests/stripe-policy.mjs
 *
 * This imports the same module stripe-checkout and stripe-webhook import, so
 * it tests the shipping rules rather than a copy. No Deno, no network, no
 * Stripe account: the two Edge Functions do the I/O, stripe-policy.mjs makes
 * the decisions, and a wrong decision here is either a lost payment or a
 * plan granted for free.
 */

import {
  CHECKOUT_PLANS,
  planForPriceId,
  priceMapFromEnv,
  rowFromSubscription,
  upsertPatchFor,
} from "../supabase/functions/_shared/stripe-policy.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "\n       " + extra : "")); }
};

const PRICE_MAP = { basic: "price_basic", pro: "price_pro", max: "price_max" };

console.log("\n== priceMapFromEnv / planForPriceId ==");
{
  const env = { STRIPE_PRICE_BASIC: "price_basic", STRIPE_PRICE_PRO: "price_pro" };
  const map = priceMapFromEnv((k) => env[k]);
  ok("reads a configured price", map.basic === "price_basic");
  ok("an unset price is null, not undefined", map.max === null);

  ok("a known price resolves to its plan", planForPriceId("price_pro", PRICE_MAP) === "pro");
  ok("an unrecognised price resolves to nothing", planForPriceId("price_mystery", PRICE_MAP) === null);
  ok("no price resolves to nothing", planForPriceId(null, PRICE_MAP) === null);
  ok("every checkout plan is sellable", CHECKOUT_PLANS.length === 3);
}

console.log("\n== rowFromSubscription ==");
{
  const sub = {
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    items: { data: [{ current_period_end: 1_700_000_000, price: { id: "price_pro", recurring: { interval: "month" } } }] },
  };
  const row = rowFromSubscription(sub, PRICE_MAP);
  ok("resolves the plan from the item's price", row.plan === "pro");
  ok("carries the status through verbatim", row.status === "active");
  ok("reads the interval off the price", row.interval === "month");
  ok("converts the period end to an ISO string", row.currentPeriodEnd === new Date(1_700_000_000 * 1000).toISOString());
  ok("a string customer id is used as-is", row.customerId === "cus_1");
  ok("carries the subscription id", row.subscriptionId === "sub_1");

  // Older API versions only ever had current_period_end on the subscription
  // itself, with no items[].current_period_end at all.
  const legacySub = {
    id: "sub_2",
    status: "trialing",
    current_period_end: 1_700_000_100,
    customer: { id: "cus_2" },
    items: { data: [{ price: { id: "price_basic", recurring: { interval: "month" } } }] },
  };
  const legacyRow = rowFromSubscription(legacySub, PRICE_MAP);
  ok("falls back to the subscription-level period end", legacyRow.currentPeriodEnd === new Date(1_700_000_100 * 1000).toISOString());
  ok("reads a customer object's id, not just a customer string", legacyRow.customerId === "cus_2");

  // A subscription.deleted event's object is a full subscription with
  // status already "canceled" — the same shape an update carries.
  const canceledSub = { ...sub, status: "canceled" };
  ok("a canceled subscription's status passes through unchanged", rowFromSubscription(canceledSub, PRICE_MAP).status === "canceled");

  // A price this deploy doesn't recognise (manually attached in the
  // dashboard, or a stale env var) must not silently grant a plan.
  const unknownPriceSub = { ...sub, items: { data: [{ price: { id: "price_unknown" } }] } };
  ok("an unrecognised price resolves to no plan", rowFromSubscription(unknownPriceSub, PRICE_MAP).plan === null);
}

console.log("\n== upsertPatchFor ==");
{
  const full = upsertPatchFor("user-1", {
    plan: "pro", status: "active", interval: "month",
    currentPeriodEnd: "2026-09-01T00:00:00.000Z", customerId: "cus_1", subscriptionId: "sub_1",
  });
  ok("carries every resolved field", full.plan === "pro" && full.stripe_customer_id === "cus_1" && full.stripe_subscription_id === "sub_1");
  ok("always carries the user id and status", full.user_id === "user-1" && full.status === "active");

  // A partial/unrecognised event (unknown price, or a webhook payload
  // missing period-end) must not overwrite a good plan with a guess.
  const partial = upsertPatchFor("user-1", {
    plan: null, status: "past_due", interval: null, currentPeriodEnd: null, customerId: null, subscriptionId: null,
  });
  ok("omits fields it could not resolve", !("plan" in partial) && !("interval" in partial) && !("current_period_end" in partial));
  ok("still updates status, which is always known", partial.status === "past_due");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
