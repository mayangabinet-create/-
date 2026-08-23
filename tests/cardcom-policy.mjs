/*
 * Node test for supabase/functions/_shared/cardcom-policy.mjs -- the pure
 * decision logic behind checkout, activation, and the monthly billing cron.
 * Same idiom as tests/ai-proxy-policy.mjs and the old tests/stripe-policy.mjs:
 * import the real module directly, no stub, no network.
 *
 *     node tests/cardcom-policy.mjs
 */
import {
  CHECKOUT_PLANS,
  priceMapFromEnv,
  addOneMonth,
  lowProfileCreateBody,
  activationPatchFromLpResult,
  chargeOutcomePatch,
} from "../supabase/functions/_shared/cardcom-policy.mjs";

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "\n       " + JSON.stringify(extra) : "")); }
}

console.log("== priceMapFromEnv ==");
{
  const env = { CARDCOM_PRICE_BASIC: "29.9", CARDCOM_PRICE_PRO: "0", CARDCOM_PRICE_MAX: "not-a-number" };
  const prices = priceMapFromEnv((k) => env[k]);
  ok("a valid price parses", prices.basic === 29.9, prices);
  ok("zero is not a configured price", prices.pro === null, prices);
  ok("a non-numeric value is not a configured price", prices.max === null, prices);
  ok("an unset key is null, not undefined or NaN", priceMapFromEnv(() => undefined).basic === null);
}

console.log("\n== addOneMonth ==");
{
  ok("a plain month advance",
     addOneMonth(new Date("2026-03-15T00:00:00Z")).toISOString().startsWith("2026-04-15"));
  ok("Jan 31 lands on Feb 28 in a non-leap year, not March 3",
     addOneMonth(new Date("2027-01-31T00:00:00Z")).toISOString().startsWith("2027-02-28"));
  ok("Jan 31 lands on Feb 29 in a leap year",
     addOneMonth(new Date("2028-01-31T00:00:00Z")).toISOString().startsWith("2028-02-29"));
  ok("December rolls the year over",
     addOneMonth(new Date("2026-12-10T00:00:00Z")).toISOString().startsWith("2027-01-10"));
}

console.log("\n== lowProfileCreateBody ==");
{
  const body = lowProfileCreateBody({
    plan: "pro", amount: 49.9, terminalId: "1000", apiName: "test-api",
    successUrl: "https://x.example/?checkout=success",
    failUrl: "https://x.example/?checkout=cancel",
    webhookUrl: "https://x.example/functions/v1/cardcom-webhook",
  });
  ok("always charges and saves a token in the same call", body.Operation === "ChargeAndCreateToken", body);
  ok("terminal id is sent as a number, not a string", body.TerminalNumber === 1000, body);
  ok("the plan travels in ReturnValue", body.ReturnValue === "pro", body);
  ok("CHECKOUT_PLANS never includes trial", !CHECKOUT_PLANS.includes("trial"));
}

console.log("\n== activationPatchFromLpResult ==");
{
  const success = {
    ResponseCode: 0,
    LowProfileId: "lp-123",
    TokenInfo: { Token: "tok-abc", CardMonth: 7, CardYear: 2029, TokenApprovalNumber: "1", CardOwnerIdentityNumber: "" },
  };
  const patch = activationPatchFromLpResult(success);
  ok("a successful result activates the plan", patch?.status === "active", patch);
  ok("the token is carried through untouched", patch?.cardcom_token === "tok-abc", patch);
  ok("card month/year become MMYY, zero-padded", patch?.cardcom_token_expiry === "0729", patch);
  ok("failures reset to zero on a fresh activation", patch?.cardcom_billing_failures === 0, patch);

  ok("a non-zero ResponseCode activates nothing",
     activationPatchFromLpResult({ ResponseCode: 1, Description: "declined" }) === null);
  ok("ResponseCode 0 with no TokenInfo activates nothing either",
     activationPatchFromLpResult({ ResponseCode: 0, LowProfileId: "lp-1" }) === null);
}

console.log("\n== chargeOutcomePatch ==");
{
  ok("a successful charge stays active", chargeOutcomePatch({ ok: true, consecutiveFailures: 2 }).status === "active");
  ok("first missed charge: past_due, not canceled",
     chargeOutcomePatch({ ok: false, consecutiveFailures: 0 }).status === "past_due");
  ok("second missed charge: still past_due",
     chargeOutcomePatch({ ok: false, consecutiveFailures: 1 }).status === "past_due");
  ok("third missed charge in a row: canceled",
     chargeOutcomePatch({ ok: false, consecutiveFailures: 2 }).status === "canceled");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
