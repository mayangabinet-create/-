/*
 * Pure decision logic shared between grow-checkout, grow-webhook and
 * grow-billing-cron: how much each plan costs, what a createPaymentProcess
 * request body looks like, and what a `subscriptions` row should become
 * after a checkout succeeds or a recurring charge succeeds or fails. No
 * Grow SDK, no network, no Deno -- same idiom ai-proxy/policy.mjs and the
 * old cardcom-policy.mjs used, so this is what tests/grow-policy.mjs
 * exercises directly rather than a copy of it.
 */

export const CHECKOUT_PLANS = ["basic", "pro", "max"];

export function priceMapFromEnv(getEnv) {
  return {
    basic: positiveNumberOrNull(getEnv("GROW_PRICE_BASIC")),
    pro: positiveNumberOrNull(getEnv("GROW_PRICE_PRO")),
    max: positiveNumberOrNull(getEnv("GROW_PRICE_MAX")),
  };
}

function positiveNumberOrNull(v) {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * One calendar month out, with rollover handled the way a billing date
 * should be: Jan 31 + 1 month lands on Feb 28/29, not March 3.
 */
export function addOneMonth(date) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + 1);
  if (d.getUTCDate() !== day) d.setUTCDate(0);
  return d;
}

/**
 * The request body for createPaymentProcess (Grow's Light API), sent
 * application/x-www-form-urlencoded per the real integration this was
 * verified against (see README -- Payments). saveCardToken requests a
 * reusable token in the same call that takes the first payment. cField1
 * carries the plan back on Grow's own side, as a second, independent way to
 * know what was being bought -- grow-webhook still trusts
 * grow_pending_checkout over this for who the account is, since that row is
 * the one thing only our own server ever wrote.
 */
export function createPaymentProcessBody({ plan, amount, pageCode, userId, successUrl, cancelUrl, webhookUrl }) {
  return {
    pageCode,
    userId,
    sum: String(amount),
    description: `AI Learning Path — ${plan} plan`,
    successUrl,
    cancelUrl,
    notifyUrl: webhookUrl,
    saveCardToken: "1",
    cField1: plan,
  };
}

/**
 * What `subscriptions` becomes once getTransactionInfo confirms a checkout
 * really succeeded. Returns null for anything else -- statusCode !== 1, or
 * a response with nothing usable as a saved-card identifier -- so the
 * caller never writes a half-finished activation.
 */
export function activationPatchFromTransactionInfo(txInfo, processId) {
  if (txInfo?.statusCode !== 1) return null;
  const token = txInfo?.transactionToken;
  if (!token) return null;
  return {
    status: "active",
    grow_token: token,
    grow_process_id: String(processId),
    current_period_end: addOneMonth(new Date()).toISOString(),
    cancel_at_period_end: false,
    grow_billing_failures: 0,
  };
}

/**
 * What a subscription's status should become after one recurring-charge
 * attempt grow-billing-cron already made -- never called from an untrusted
 * webhook body, only from the cron's own record of what Grow's API just
 * returned to it directly. current_period_end is deliberately not decided
 * here: on success the cron has already advanced it as part of the atomic
 * claim; on failure the cron resets it to "now" itself so tomorrow's run
 * retries the same card.
 */
export function chargeOutcomePatch({ ok, consecutiveFailures }) {
  if (ok) return { status: "active" };
  // Three missed days running and the plan lapses: long enough that one
  // bank hiccup doesn't cost someone their course mid-lesson, short enough
  // that a genuinely dead card doesn't stay "active" unpaid for a month.
  const failures = (consecutiveFailures || 0) + 1;
  return failures >= 3 ? { status: "canceled" } : { status: "past_due" };
}
