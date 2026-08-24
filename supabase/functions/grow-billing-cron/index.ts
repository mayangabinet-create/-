import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { addOneMonth, chargeOutcomePatch } from "../_shared/grow-policy.mjs";

const GROW_API_BASE_URL = Deno.env.get("GROW_API_BASE_URL") || "https://secure.meshulam.co.il/api/light/server/1.0";
const GROW_PAGE_CODE = Deno.env.get("GROW_PAGE_CODE")!;
const GROW_USER_ID = Deno.env.get("GROW_USER_ID")!;
const GROW_CRON_SECRET = Deno.env.get("GROW_CRON_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PRICE_MAP: Record<string, number | null> = {
  basic: Number(Deno.env.get("GROW_PRICE_BASIC")) || null,
  pro: Number(Deno.env.get("GROW_PRICE_PRO")) || null,
  max: Number(Deno.env.get("GROW_PRICE_MAX")) || null,
};

/*
 * The thing Stripe did for free, that Cardcom also didn't do, and that Grow
 * *might* already do on its own: remember to charge everyone again next
 * month. Grow's own "Premium Recurring Payment" feature was the one part of
 * this whole integration that could not be pinned down while building it —
 * see README — Payments. This function assumes the self-managed model (the
 * same one built for Cardcom): grow-checkout only takes the first payment
 * and saves a token, and this cron charges that token again every month via
 * CreateTransactionWithToken, whose exact request shape is a best guess
 * from the one endpoint name found, not a confirmed schema.
 *
 * BEFORE THIS GOES LIVE: confirm with Grow directly whether saveCardToken
 * on checkout already enrolls the account in automatic recurring billing on
 * their side. If it does, this cron must be disabled (unschedule
 * grow-daily-billing in cron.job) or every subscriber gets charged twice a
 * month — once by Grow automatically, once by this function.
 *
 * Triggered daily by the pg_cron job in
 * supabase/migrations/20260824090100_grow_billing_cron_schedule.sql, which
 * sends x-grow-cron-secret — not a payment credential, see that migration's
 * own comment, only a guard against a stray extra POST.
 *
 * Every row this claims is claimed atomically: current_period_end is pushed
 * a month forward *before* the card is charged, so a second concurrent
 * trigger's identical query finds nothing due for that row any more. If the
 * charge itself then fails, current_period_end is reset back to "now" so
 * tomorrow's run retries the same card — the optimistic claim, undone.
 */
Deno.serve(async (req: Request) => {
  if (req.headers.get("x-grow-cron-secret") !== GROW_CRON_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const nowIso = new Date().toISOString();

  const { data: due, error: dueErr } = await admin
    .from("subscriptions")
    .select("id, user_id, plan, grow_token, current_period_end, cancel_at_period_end, grow_billing_failures")
    .in("status", ["active", "past_due"])
    .lte("current_period_end", nowIso);

  if (dueErr) {
    console.error("grow-billing-cron: could not list due subscriptions:", dueErr.message);
    return new Response("error", { status: 500 });
  }

  let charged = 0, canceled = 0, failed = 0, skipped = 0;

  for (const sub of due ?? []) {
    if (sub.cancel_at_period_end) {
      await admin.from("subscriptions").update({ status: "canceled" }).eq("id", sub.id);
      canceled++;
      continue;
    }

    const amount = PRICE_MAP[sub.plan];
    if (!amount || !sub.grow_token) {
      console.error(`grow-billing-cron: subscription ${sub.id} missing price or token, skipping`);
      skipped++;
      continue;
    }

    const optimisticNextEnd = addOneMonth(new Date(sub.current_period_end)).toISOString();
    const { data: claimed } = await admin
      .from("subscriptions")
      .update({ current_period_end: optimisticNextEnd, status: "active" })
      .eq("id", sub.id)
      .lte("current_period_end", nowIso)
      .select()
      .maybeSingle();
    if (!claimed) { skipped++; continue; } // another run already claimed this row

    try {
      const res = await fetch(`${GROW_API_BASE_URL}/CreateTransactionWithToken`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          pageCode: GROW_PAGE_CODE,
          userId: GROW_USER_ID,
          sum: String(amount),
          token: sub.grow_token,
          description: `AI Learning Path — ${sub.plan} plan renewal`,
        }).toString(),
      });
      const result = await res.json();
      const ok = result?.status === 1;

      await admin.from("grow_charges").insert({
        user_id: sub.user_id,
        transaction_id: result?.data?.transactionId != null ? String(result.data.transactionId) : null,
        amount,
        status: ok ? "success" : "failed",
        error_message: ok ? null : (result?.message ?? "unknown error"),
      });

      if (ok) {
        charged++;
        await admin.from("subscriptions").update({ grow_billing_failures: 0 }).eq("id", sub.id);
      } else {
        failed++;
        const patch = chargeOutcomePatch({ ok: false, consecutiveFailures: sub.grow_billing_failures });
        await admin.from("subscriptions").update({
          status: patch.status,
          current_period_end: nowIso, // reverts the optimistic claim above
          grow_billing_failures: (sub.grow_billing_failures || 0) + 1,
        }).eq("id", sub.id);
      }
    } catch (err) {
      failed++;
      console.error(`grow-billing-cron: charge failed for subscription ${sub.id}:`, err instanceof Error ? err.message : err);
      await admin.from("subscriptions").update({
        current_period_end: nowIso,
        grow_billing_failures: (sub.grow_billing_failures || 0) + 1,
      }).eq("id", sub.id);
    }
  }

  return new Response(JSON.stringify({ charged, canceled, failed, skipped, total: (due ?? []).length }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
