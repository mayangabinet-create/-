-- Real billing changes what account deletion must check. Before Stripe,
-- deleting auth.users could never leave anything running outside this
-- database, because nothing did. Now it can: cascading away the
-- subscriptions row (see 20260818140000_delete_own_account.sql) throws away
-- the only link this app keeps to a live Stripe subscription, while Stripe
-- itself keeps renewing and charging the card with no account left to
-- cancel it from. This blocks that — an account with a Stripe subscription
-- Stripe doesn't already consider over must cancel it (Account -> Manage
-- billing) before its own deletion succeeds.
create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  billing_status text;
begin
  select status into billing_status
  from public.subscriptions
  where user_id = auth.uid() and stripe_subscription_id is not null;

  if billing_status is not null and billing_status not in ('canceled', 'incomplete_expired') then
    raise exception 'you have an active subscription — cancel it from Account -> Manage billing first, then delete your account';
  end if;

  delete from auth.users where id = auth.uid();
end;
$$;

comment on function public.delete_own_account() is
    'Deletes the calling account. Cascades to courses/progress/subscriptions/ai_usage/user_stats; sets material_reports.user_id null. Refuses to run while a Stripe subscription is still active/trialing/past_due, so deletion can never orphan a live external charge.';

-- Same REVOKE + narrow GRANT as the original migration — replacing the
-- function body does not change who may call it, but Postgres does not
-- carry grants across a bare CREATE, only CREATE OR REPLACE on the same
-- signature, so this stays explicit rather than relying on that.
revoke all on function public.delete_own_account() from public;
grant execute on function public.delete_own_account() to authenticated;
