import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { activationPatchFromTransactionInfo } from "../_shared/grow-policy.mjs";

const GROW_API_BASE_URL = Deno.env.get("GROW_API_BASE_URL") || "https://secure.meshulam.co.il/api/light/server/1.0";
const GROW_PAGE_CODE = Deno.env.get("GROW_PAGE_CODE")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/*
 * Deploy this one with --no-verify-jwt (verify_jwt: false): Grow calls it
 * directly, with no Supabase session to present. Nothing publicly available
 * while building this named a signature or checksum Grow attaches to the
 * call itself (see README — Payments), so nothing in the incoming request
 * is trusted, not even the transactionId/transactionToken it claims: those
 * values are read only as a lookup key to ask Grow about. Every actual fact
 * — did the checkout succeed, what identifier to save for next month's
 * charge, whose checkout was it — comes from calling getTransactionInfo
 * back with this app's own pageCode, and from grow_pending_checkout, the
 * one record only grow-checkout (running with our own service-role key)
 * ever wrote. If Grow's real docs turn out to name a signature after all,
 * it's fine to add that check on top of this — this function doesn't need
 * to stop re-verifying with Grow directly just because a signature becomes
 * available too.
 */
async function extractFields(req: Request): Promise<{ processId: string | null; transactionId: string | null; transactionToken: string | null }> {
  const url = new URL(req.url);
  const fromQuery = (name: string) => url.searchParams.get(name);

  let body: any = null;
  try { body = await req.clone().json(); } catch { /* try form below */ }
  if (!body) {
    try {
      const form = await req.clone().formData();
      body = Object.fromEntries(form.entries());
    } catch { /* neither shape matched */ }
  }

  return {
    processId: body?.processId != null ? String(body.processId) : fromQuery("processId"),
    transactionId: body?.transactionId != null ? String(body.transactionId) : fromQuery("transactionId"),
    transactionToken: body?.transactionToken ?? fromQuery("transactionToken"),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { processId, transactionId, transactionToken } = await extractFields(req);
  if (!processId || !transactionId || !transactionToken) {
    console.error("grow-webhook: missing processId/transactionId/transactionToken in request");
    // Acknowledged rather than rejected, so Grow doesn't retry forever on a
    // request shape this function doesn't recognise.
    return new Response("ok", { status: 200 });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: pending } = await admin
    .from("grow_pending_checkout")
    .select("user_id, plan")
    .eq("process_id", processId)
    .maybeSingle();

  if (!pending) {
    // Either already processed by an earlier call for the same id — safe,
    // this function is idempotent — or an id this server never issued.
    return new Response("ok", { status: 200 });
  }

  try {
    const res = await fetch(`${GROW_API_BASE_URL}/getTransactionInfo`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ pageCode: GROW_PAGE_CODE, transactionId, transactionToken }).toString(),
    });
    const infoResponse = await res.json();
    const patch = activationPatchFromTransactionInfo(infoResponse?.data, processId);

    if (!patch) {
      console.error("grow-webhook: transaction did not succeed:", processId, infoResponse?.data?.statusCode);
      await admin.from("grow_pending_checkout").delete().eq("process_id", processId);
      return new Response("ok", { status: 200 });
    }

    const { error: upsertErr } = await admin
      .from("subscriptions")
      .upsert({ user_id: pending.user_id, plan: pending.plan, ...patch }, { onConflict: "user_id" });
    if (upsertErr) console.error("grow-webhook: subscriptions upsert failed:", upsertErr.message);

    await admin.from("grow_pending_checkout").delete().eq("process_id", processId);
    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("grow-webhook failed:", err instanceof Error ? err.message : err);
    // Not acknowledged: grow_pending_checkout is only cleared on a handled
    // outcome above, so if Grow retries on a non-200 this gets another
    // chance to finish.
    return new Response("error", { status: 500 });
  }
});
