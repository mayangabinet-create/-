-- A plan switcher for exactly one account, so the tiers can be tried without
-- Stripe existing yet (see README: "Payments — not done yet").
--
-- The email is checked here, inside the function, against auth.users — never
-- against anything the client sends. A client can ask this function to set
-- any plan it likes; what it cannot do is ask on behalf of a user it is not.
-- Restricting the *acting* user rather than trusting a client-supplied email
-- is what keeps this from being "anyone who edits app.js gets Max free".
--
-- Deliberately not a general "set my plan" RPC available to every account:
-- that would hand out paid tiers for nothing, which is exactly the hole
-- Stripe is meant to close later. This is a debug switch for one person
-- while checkout does not exist, not a feature.
create or replace function public.debug_set_plan(new_plan text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_email text;
begin
  select email into caller_email from auth.users where id = auth.uid();

  if caller_email is distinct from 'mayangabinet@gmail.com' then
    raise exception 'not permitted';
  end if;

  -- Belt and braces alongside subscriptions_plan_check: fail with a message
  -- this function's own caller can read, rather than a bare constraint error.
  if new_plan not in ('basic', 'pro', 'max') then
    raise exception 'invalid plan: %', new_plan;
  end if;

  insert into public.subscriptions (user_id, plan, status)
  values (auth.uid(), new_plan, 'active')
  on conflict (user_id) do update
    set plan = excluded.plan,
        status = 'active';
end;
$$;

comment on function public.debug_set_plan(text) is
    'Switches the calling account between basic/pro/max, restricted inside the function to one email. A stand-in for checkout, which does not exist yet.';

-- SECURITY DEFINER functions run as their owner by default, bypassing RLS —
-- REVOKE + a narrow GRANT is what keeps this callable only the intended way
-- (authenticated, via RPC) rather than by every role that can reach the
-- function name.
revoke all on function public.debug_set_plan(text) from public;
grant execute on function public.debug_set_plan(text) to authenticated;
