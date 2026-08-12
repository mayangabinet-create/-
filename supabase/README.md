# Supabase — what lives here and how it ships

The `ai-proxy` Edge Function ran only in the Supabase project until now; this
directory is the source of truth for it, so a change can be read and reviewed
before it reaches production instead of after.

```
supabase/
  functions/ai-proxy/
    index.ts     the handler — auth, subscription, quota, the call, usage
    policy.mjs   the rules — tiers, classification, clamping, caching
  migrations/    schema changes, applied in filename order
```

## Why the split

`policy.mjs` holds everything that decides, and nothing that does I/O. That is
the half worth testing — what a tier may buy, what counts as a lesson, how much
of the document survives, which block gets cached — and it is the half that
costs money when it is wrong. `tests/ai-proxy-policy.mjs` imports the same file
the function imports, so the tests exercise the shipping rules rather than a
copy that can drift.

```sh
node tests/ai-proxy-policy.mjs
```

Plain ESM, no Deno, no network, no account.

## Deploying

**Apply the migration first, then deploy the function.** Either order works —
the handler falls back to the old four-argument `increment_ai_usage` if the
migration has not run — but this way the first cached call is recorded
properly.

```sh
supabase db push                      # or apply the migration from the dashboard
supabase functions deploy ai-proxy
```

The function reads `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` from project secrets. None of them are in this
repository and none of them reach the browser.

## Checking it worked

Prompt caching fails silently: send a prefix below the model's minimum and the
API accepts the request, caches nothing, and bills the write premium anyway.
The only way to know is to look at what came back.

```sql
select calls, cached, input_tokens, cache_write_tokens, cache_read_tokens
from ai_usage where user_id = '<uuid>';
```

On a Pro or Max account, build a course and open two lessons within five
minutes of each other. Expect the first lesson to move `cache_write_tokens` and
the second to move `cache_read_tokens`. If `cache_read_tokens` stays at zero
across lessons, the prefix is not matching — the usual causes are the context
block differing by a character between calls, or more than five minutes passing
between them.

`cached` counts calls that read from cache; the two token columns are what
cost is actually computed from. A read bills at about 10% of input and a write
at 1.25x, and `input_tokens` reports only the uncached remainder — so the three
columns have to be added to get what a request really read.
