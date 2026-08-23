import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { addOneMonth, chargeOutcomePatch } from "../_shared/cardcom-policy.mjs";

const CARDCOM_API_URL = "https://secure.cardcom.solutions/api/v11";
const CARDCOM_TERMINAL_ID = Deno.env.get("CARDCOM_TERMINAL_ID")!;
const CARDCOM_API_NAME = Deno.env.get("CARDCOM_API_NAME")!;
const CARDCOM_API_PASSWORD = Deno.env.get("CARDCOM_API_PASSWORD")!;
const CARDCOM_CRON_SECRET = Deno.env.get("CARDCOM_CRON_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PRICE_MAP: Record<string, number | null> = {
  basic: Number(Deno.env.get("CARDCOM_PRICE_BASIC")) || null,
  pro: Number(Deno.env.get("CARDCOM_PRICE_PRO")) || null,
  max: Number(Deno.env.get("CARDCOM_PRICE_MAX")) || null,
};

/*
 * The thing Stripe did for free and Cardcom doesn't: remember to charge
 * everyone again next month. Triggered daily by the pg_cron job in
 * supabase/migrations/20260823130100_cardcom_billing_cron_schedule.sql,
 * which sends x-cardcom-cron-secret -- not a payment credential, see that
 * migration's own comment, only a guard against a stray extra POST.
 *
 * Every row this claims is claimed atomically: current_period_end is pushed
 * a month forward *before* the card is charged, so a second concurrent
 * trigger's identical query finds nothing due for that row any more. If the
 * charge itself then fails, current_period_end is reset back to "now" so
 * tomorrow's run retries the same card -- the optimistic claim, undone.
 */
Deno.serve(async (req: Request) => {
  if (req.headers.get("x-cardcom-cron-secret") !== CARDCOM_CRON_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const nowIso = new Date().toISOString();

  const { data: due, error: dueErr } = await admin
    .from("subscriptions")
    .select("id, user_id, plan, cardcom_token, cardcom_token_expiry, current_period_end, cancel_at_period_end, cardcom_billing_failures")
    .in("status", ["active", "past_due"])
    .lte("current_period_end", nowIso);

  if (dueErr) {
    console.error("cardcom-billing-cron: could not list due subscriptions:", dueErr.message);
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
    if (!amount || !sub.cardcom_token || !sub.cardcom_token_expiry) {
      console.error(`cardcom-billing-cron: subscription ${sub.id} missing price or token, skipping`);
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
      const res = await fetch(`${CARDCOM_API_URL}/Transactions/Transaction`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          TerminalNumber: Number(CARDCOM_TERMINAL_ID),
          ApiName: CARDCOM_API_NAME,
          Amount: amount,
          Token: sub.cardcom_token,
          CardExpirationMMYY: sub.cardcom_token_expiry,
          Advanced: { ApiPassword: CARDCOM_API_PASSWORD, IsAutoRecurringPayment: true },
        }),
      });
      const result = await res.json();
      const ok = result?.ResponseCode === 0;

      await admin.from("cardcom_charges").insert({
        user_id: sub.user_id,
        transaction_id: result?.TranzactionId ?? null,
        amount,
        status: ok ? "success" : "failed",
        error_message: ok ? null : (result?.Description ?? "unknown error"),
      });

      if (ok) {
        charged++;
        await admin.from("subscriptions").update({ cardcom_billing_failures: 0 }).eq("id", sub.id);
      } else {
        failed++;
        const patch = chargeOutcomePatch({ ok: false, consecutiveFailures: sub.cardcom_billing_failures });
        await admin.from("subscriptions").update({
          status: patch.status,
          current_period_end: nowIso, // reverts the optimistic claim above
          cardcom_billing_failures: (sub.cardcom_billing_failures || 0) + 1,
        }).eq("id", sub.id);
      }
    } catch (err) {
      failed++;
      console.error(`cardcom-billing-cron: charge failed for subscription ${sub.id}:`, err instanceof Error ? err.message : err);
      await admin.from("subscriptions").update({
        current_period_end: nowIso,
        cardcom_billing_failures: (sub.cardcom_billing_failures || 0) + 1,
      }).eq("id", sub.id);
    }
  }

  return new Response(JSON.stringify({ charged, canceled, failed, skipped, total: (due ?? []).length }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
