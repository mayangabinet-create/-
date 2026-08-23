/*
 * Pure decision logic shared between cardcom-checkout, cardcom-webhook and
 * cardcom-billing-cron: how much each plan costs, what a LowProfile/Create
 * request body looks like, and what a `subscriptions` row should become
 * after a checkout succeeds or a recurring charge succeeds or fails. No
 * Cardcom SDK, no network, no Deno -- same idiom ai-proxy/policy.mjs and the
 * old stripe-policy.mjs used, so this is what tests/cardcom-policy.mjs
 * exercises directly rather than a copy of it.
 */

// The only plans checkout ever sells. Trial is earned, not bought.
export const CHECKOUT_PLANS = ["basic", "pro", "max"];

export function priceMapFromEnv(getEnv) {
  return {
    basic: positiveNumberOrNull(getEnv("CARDCOM_PRICE_BASIC")),
    pro: positiveNumberOrNull(getEnv("CARDCOM_PRICE_PRO")),
    max: positiveNumberOrNull(getEnv("CARDCOM_PRICE_MAX")),
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
 * The request body for LowProfile/Create. Operation is always
 * ChargeAndCreateToken: the first month is charged immediately and a token
 * is saved in the same call for cardcom-billing-cron to charge next month.
 * ReturnValue carries the plan back on Cardcom's own redirect/result, as a
 * second, independent way to know what was being bought -- cardcom-webhook
 * still trusts cardcom_pending_checkout over this for who the account is,
 * since that row is the one thing only our own server ever wrote.
 */
export function lowProfileCreateBody({ plan, amount, terminalId, apiName, successUrl, failUrl, webhookUrl }) {
  return {
    TerminalNumber: Number(terminalId),
    ApiName: apiName,
    Operation: "ChargeAndCreateToken",
    Amount: amount,
    SuccessRedirectUrl: successUrl,
    FailedRedirectUrl: failUrl,
    WebHookUrl: webhookUrl,
    ReturnValue: plan,
  };
}

/**
 * What `subscriptions` becomes once GetLpResult confirms a checkout really
 * succeeded. Returns null for anything else -- a non-zero ResponseCode, or a
 * response with no TokenInfo -- so the caller never writes a half-finished
 * activation.
 */
export function activationPatchFromLpResult(lpResult) {
  if (lpResult?.ResponseCode !== 0 || !lpResult?.TokenInfo?.Token) return null;
  return {
    status: "active",
    cardcom_token: lpResult.TokenInfo.Token,
    cardcom_token_expiry: monthYearToMMYY(lpResult.TokenInfo.CardMonth, lpResult.TokenInfo.CardYear),
    cardcom_low_profile_id: lpResult.LowProfileId,
    current_period_end: addOneMonth(new Date()).toISOString(),
    cancel_at_period_end: false,
    cardcom_billing_failures: 0,
  };
}

function monthYearToMMYY(month, year) {
  return `${String(month).padStart(2, "0")}${String(year).slice(-2)}`;
}

/**
 * What a subscription's status should become after one recurring-charge
 * attempt cardcom-billing-cron already made -- never called from an
 * untrusted webhook body, only from the cron's own record of what Cardcom's
 * API just returned to it directly. current_period_end is deliberately not
 * decided here: on success the cron has already advanced it as part of the
 * atomic claim; on failure the cron resets it to "now" itself so tomorrow's
 * run retries the same card.
 */
export function chargeOutcomePatch({ ok, consecutiveFailures }) {
  if (ok) return { status: "active" };
  // Three missed days running and the plan lapses: long enough that one
  // bank hiccup doesn't cost someone their course mid-lesson, short enough
  // that a genuinely dead card doesn't stay "active" unpaid for a month.
  const failures = (consecutiveFailures || 0) + 1;
  return failures >= 3 ? { status: "canceled" } : { status: "past_due" };
}
