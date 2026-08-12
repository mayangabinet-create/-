-- Record what prompt caching actually did.
--
-- `ai_usage.cached` already counted calls flagged as cache hits, but nothing
-- ever set the flag: ai-proxy passed `p_cache_hit: false` literally, on every
-- call. So the column has always read zero, and there is no record anywhere of
-- how many tokens were written to cache or read back from it.
--
-- Cost needs the token counts, not a boolean. A cache read bills at ~10% of
-- normal input and a write at 1.25x, so a month of usage cannot be priced from
-- `input_tokens` alone — and `input_tokens` reports only the uncached
-- remainder, which makes a cache hit look like a request that read almost
-- nothing.
--
-- Apply before deploying ai-proxy v5. Either order works — the function falls
-- back to the four-argument call if this has not run yet — but this way the
-- first cached call is recorded properly.

alter table public.ai_usage
  add column if not exists cache_write_tokens bigint not null default 0,
  add column if not exists cache_read_tokens  bigint not null default 0;

comment on column public.ai_usage.cache_write_tokens is
  'Tokens written to the prompt cache, billed at ~1.25x input.';
comment on column public.ai_usage.cache_read_tokens is
  'Tokens served from the prompt cache, billed at ~0.1x input.';

-- Postgres cannot add defaulted parameters to an existing function without the
-- old four-argument call becoming ambiguous, so the old signature goes first.
drop function if exists public.increment_ai_usage(uuid, bigint, bigint, boolean);

-- Same shape and same language as the function it replaces; the only changes
-- are the two new counters and the two new arguments that feed them.
create or replace function public.increment_ai_usage(
  p_user_id       uuid,
  p_input_tokens  bigint,
  p_output_tokens bigint,
  p_cache_hit     boolean default false,
  p_cache_write   bigint default 0,
  p_cache_read    bigint default 0
) returns void
language sql
security definer
set search_path to 'public'
as $function$
  insert into public.ai_usage (
    user_id, calls, input_tokens, output_tokens, cached,
    cache_write_tokens, cache_read_tokens, updated_at
  )
  values (
    p_user_id, 1, p_input_tokens, p_output_tokens,
    case when p_cache_hit then 1 else 0 end,
    coalesce(p_cache_write, 0), coalesce(p_cache_read, 0), now()
  )
  on conflict (user_id) do update set
    calls              = ai_usage.calls + 1,
    input_tokens       = ai_usage.input_tokens + excluded.input_tokens,
    output_tokens      = ai_usage.output_tokens + excluded.output_tokens,
    cached             = ai_usage.cached + excluded.cached,
    cache_write_tokens = ai_usage.cache_write_tokens + excluded.cache_write_tokens,
    cache_read_tokens  = ai_usage.cache_read_tokens + excluded.cache_read_tokens,
    updated_at         = now();
$function$;

-- Separately from the cache work: this is `security definer` and takes the
-- user id as an argument, so whoever may execute it may inflate anyone's
-- usage counters. Only ai-proxy calls it, and it calls with the service role.
revoke all on function public.increment_ai_usage(uuid, bigint, bigint, boolean, bigint, bigint) from public, anon, authenticated;
grant execute on function public.increment_ai_usage(uuid, bigint, bigint, boolean, bigint, bigint) to service_role;
