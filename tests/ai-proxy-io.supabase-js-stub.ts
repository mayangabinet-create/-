// Stand-in for `jsr:@supabase/supabase-js@2`, redirected via
// ai-proxy-io.import_map.json. Same idiom as the rest of this repo's test
// suites (see the `supabaseClient` stubs in tests/onboarding.js,
// tests/learning-state.js, etc.): a hand-shaped fake matching exactly the
// methods index.ts calls, not a reimplementation of PostgREST's wire
// protocol — that protocol belongs to a third-party library, not this app.
//
// index.ts constructs two clients per request — `userClient` (anon key, for
// `.auth.getUser()` only) and `admin` (service role key, for
// `.from("subscriptions")...` and `.rpc(...)`) — and both resolve through
// this one module, so `mock` below is shared state the test file drives.

export interface MockUser {
  id: string;
  email_confirmed_at?: string | null;
}

export const mock = {
  user: null as MockUser | null,
  userError: null as { message: string } | null,
  subscription: null as { status: string; plan?: string; current_period_end?: string | null } | null,
  // name -> (params) => { data, error }
  rpc: {} as Record<string, (params: unknown) => { data?: unknown; error?: { message: string } | null }>,
  calls: [] as Array<{ name: string; params: unknown }>,
};

export function resetMock() {
  mock.user = { id: "user-1", email_confirmed_at: "2026-01-01T00:00:00Z" };
  mock.userError = null;
  mock.subscription = { status: "active", plan: "basic", current_period_end: null };
  mock.rpc = {
    consume_daily_ai_call: () => ({ data: true, error: null }),
    consume_ai_quota: () => ({ data: "ok", error: null }),
    increment_ai_usage: () => ({ data: null, error: null }),
  };
  mock.calls = [];
}
resetMock();

export function createClient(_url: string, _key: string, _opts?: unknown) {
  return {
    auth: {
      getUser: async () => ({ data: { user: mock.user }, error: mock.userError }),
    },
    from: (_table: string) => ({
      select: (_cols?: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => ({ data: mock.subscription, error: null }),
        }),
      }),
    }),
    rpc: async (name: string, params: unknown) => {
      mock.calls.push({ name, params });
      const handler = mock.rpc[name];
      return handler ? handler(params) : { data: null, error: null };
    },
  };
}
