import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

// No Grow call either way: cancelling here only ever means "stop letting
// grow-billing-cron charge the saved token again," a fact this app's own
// subscriptions row decides. { resume: true } undoes it, same endpoint.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing Authorization header" }, 401);
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) {
    return json({ error: "Invalid session" }, 401);
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // A body is optional — absent means "cancel," the common case.
  }
  const resume = body?.resume === true;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await admin
    .from("subscriptions")
    .update({ cancel_at_period_end: !resume })
    .eq("user_id", user.id)
    .not("grow_token", "is", null)
    .select()
    .maybeSingle();

  if (error) {
    console.error("grow-cancel failed:", error.message);
    return json({ error: "cancel_failed", message: "Could not update your subscription. Try again in a moment." }, 502);
  }
  if (!data) {
    return json({ error: "no_subscription", message: "No paid subscription found on this account." }, 404);
  }
  return json({ ok: true, cancelAtPeriodEnd: !resume }, 200);
});
