/*
 * Node test for supabase/functions/_shared/grow-policy.mjs -- the pure
 * decision logic behind checkout, activation, and the monthly billing cron.
 * Same idiom as tests/ai-proxy-policy.mjs and the old tests/cardcom-policy.mjs:
 * import the real module directly, no stub, no network.
 *
 *     node tests/grow-policy.mjs
 */
import {
  CHECKOUT_PLANS,
  priceMapFromEnv,
  addOneMonth,
  createPaymentProcessBody,
  activationPatchFromTransactionInfo,
  chargeOutcomePatch,
} from "../supabase/functions/_shared/grow-policy.mjs";

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "\n       " + JSON.stringify(extra) : "")); }
}

console.log("== priceMapFromEnv ==");
{
  const env = { GROW_PRICE_BASIC: "29.9", GROW_PRICE_PRO: "0", GROW_PRICE_MAX: "not-a-number" };
  const prices = priceMapFromEnv((k) => env[k]);
  ok("a valid price parses", prices.basic === 29.9, prices);
  ok("zero is not a configured price", prices.pro === null, prices);
  ok("a non-numeric value is not a configured price", prices.max === null, prices);
}

console.log("\n== addOneMonth ==");
{
  ok("a plain month advance",
     addOneMonth(new Date("2026-03-15T00:00:00Z")).toISOString().startsWith("2026-04-15"));
  ok("Jan 31 lands on Feb 28 in a non-leap year, not March 3",
     addOneMonth(new Date("2027-01-31T00:00:00Z")).toISOString().startsWith("2027-02-28"));
}

console.log("\n== createPaymentProcessBody ==");
{
  const body = createPaymentProcessBody({
    plan: "pro", amount: 49.9, pageCode: "PC1", userId: "U1",
    successUrl: "https://x.example/?checkout=success",
    cancelUrl: "https://x.example/?checkout=cancel",
    webhookUrl: "https://x.example/functions/v1/grow-webhook",
  });
  ok("always saves a token in the same call", body.saveCardToken === "1", body);
  ok("sum is a string, since the request is form-urlencoded", body.sum === "49.9", body);
  ok("the plan travels in cField1", body.cField1 === "pro", body);
  ok("CHECKOUT_PLANS never includes trial", !CHECKOUT_PLANS.includes("trial"));
}

console.log("\n== activationPatchFromTransactionInfo ==");
{
  const success = { statusCode: 1, transactionId: 555, transactionToken: "tok-abc" };
  const patch = activationPatchFromTransactionInfo(success, "proc-123");
  ok("a successful (statusCode 1) result activates the plan", patch?.status === "active", patch);
  ok("the transaction token is stored as the reusable identifier", patch?.grow_token === "tok-abc", patch);
  ok("the process id is carried through as a string", patch?.grow_process_id === "proc-123", patch);
  ok("failures reset to zero on a fresh activation", patch?.grow_billing_failures === 0, patch);

  ok("a non-1 statusCode activates nothing",
     activationPatchFromTransactionInfo({ statusCode: 0 }, "proc-1") === null);
  ok("statusCode 1 with no transactionToken activates nothing either",
     activationPatchFromTransactionInfo({ statusCode: 1 }, "proc-1") === null);
}

console.log("\n== chargeOutcomePatch ==");
{
  ok("a successful charge stays active", chargeOutcomePatch({ ok: true, consecutiveFailures: 2 }).status === "active");
  ok("first missed charge: past_due, not canceled",
     chargeOutcomePatch({ ok: false, consecutiveFailures: 0 }).status === "past_due");
  ok("third missed charge in a row: canceled",
     chargeOutcomePatch({ ok: false, consecutiveFailures: 2 }).status === "canceled");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
