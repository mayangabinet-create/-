import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { activationPatchFromLpResult } from "../_shared/cardcom-policy.mjs";

const CARDCOM_API_URL = "https://secure.cardcom.solutions/api/v11";
const CARDCOM_TERMINAL_ID = Deno.env.get("CARDCOM_TERMINAL_ID")!;
const CARDCOM_API_NAME = Deno.env.get("CARDCOM_API_NAME")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/*
 * Deploy this one with --no-verify-jwt (verify_jwt: false): Cardcom calls it
 * directly, with no Supabase session to present. Nothing publicly available
 * while building this named a signature or checksum Cardcom attaches to the
 * call itself (see README -- Payments), so nothing in the incoming request
 * is trusted, not even which LowProfileId it claims: that value is read
 * only as a hint of which id to ask Cardcom about. Every actual fact --
 * did the checkout succeed, what token, whose checkout was it -- comes from
 * calling LowProfile/GetLpResult back with our own ApiName/TerminalNumber,
 * and from cardcom_pending_checkout, the one record only cardcom-checkout
 * (running with our own service-role key) ever wrote. If Cardcom's real
 * docs turn out to name a signature after all, it's fine to add that check
 * on top of this -- this function doesn't need to stop re-verifying with
 * Cardcom directly just because a signature becomes available too.
 */
async function extractLowProfileId(req: Request): Promise<string | null> {
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("LowProfileId") || url.searchParams.get("lowprofileid");
  if (fromQuery) return fromQuery;

  try {
    const body = await req.clone().json();
    if (typeof body?.LowProfileId === "string") return body.LowProfileId;
    if (typeof body?.ResponseData?.LowProfileId === "string") return body.ResponseData.LowProfileId;
  } catch {
    try {
      const form = await req.clone().formData();
      const v = form.get("LowProfileId") || form.get("lowprofileid");
      if (typeof v === "string") return v;
    } catch {
      // Neither a JSON body nor form-encoded -- nothing more to try.
    }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const lowProfileId = await extractLowProfileId(req);
  if (!lowProfileId) {
    console.error("cardcom-webhook: no LowProfileId found in request");
    // Acknowledged rather than rejected, so Cardcom doesn't retry forever on
    // a request shape this function doesn't recognise.
    return new Response("ok", { status: 200 });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: pending } = await admin
    .from("cardcom_pending_checkout")
    .select("user_id, plan")
    .eq("low_profile_id", lowProfileId)
    .maybeSingle();

  if (!pending) {
    // Either already processed by an earlier call for the same id -- safe,
    // this function is idempotent -- or an id this server never issued.
    return new Response("ok", { status: 200 });
  }

  try {
    const res = await fetch(`${CARDCOM_API_URL}/LowProfile/GetLpResult`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        TerminalNumber: Number(CARDCOM_TERMINAL_ID),
        ApiName: CARDCOM_API_NAME,
        LowProfileId: lowProfileId,
      }),
    });
    const lpResult = await res.json();
    const patch = activationPatchFromLpResult(lpResult);

    if (!patch) {
      console.error("cardcom-webhook: LowProfile did not succeed:", lowProfileId, lpResult?.ResponseCode, lpResult?.Description);
      await admin.from("cardcom_pending_checkout").delete().eq("low_profile_id", lowProfileId);
      return new Response("ok", { status: 200 });
    }

    const { error: upsertErr } = await admin
      .from("subscriptions")
      .upsert({ user_id: pending.user_id, plan: pending.plan, ...patch }, { onConflict: "user_id" });
    if (upsertErr) console.error("cardcom-webhook: subscriptions upsert failed:", upsertErr.message);

    await admin.from("cardcom_pending_checkout").delete().eq("low_profile_id", lowProfileId);
    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("cardcom-webhook failed:", err instanceof Error ? err.message : err);
    // Not acknowledged: cardcom_pending_checkout is only cleared on a
    // handled outcome above, so if Cardcom retries on a non-200 this gets
    // another chance to finish.
    return new Response("error", { status: 500 });
  }
});
