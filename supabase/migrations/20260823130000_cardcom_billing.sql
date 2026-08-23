-- Switching payments from Stripe to Cardcom: Stripe does not support
-- businesses registered in Israel, and no real Stripe customer or
-- subscription was ever created (checkout was never wired up to live keys),
-- so the columns are dropped rather than kept dormant -- there is nothing to
-- migrate.
alter table public.subscriptions
  drop column if exists stripe_customer_id,
  drop column if exists stripe_subscription_id;

-- Cardcom has no hosted subscription object the way Stripe does. LowProfile
-- gives back a reusable card Token, and this app is the one that has to
-- remember to charge it every month -- see cardcom-billing-cron.
-- CardExpirationMMYY is required on every charge call, so the expiry has to
-- travel with the token, not just the token itself. cardcom_billing_failures
-- counts consecutive missed charges so the cron can lapse a plan after a few
-- bad days instead of retrying forever or canceling on one hiccup.
alter table public.subscriptions
  add column if not exists cardcom_token text,
  add column if not exists cardcom_token_expiry text,
  add column if not exists cardcom_low_profile_id text,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists cardcom_billing_failures integer not null default 0;

-- cardcom-billing-cron's daily query: who is due to be charged today.
create index if not exists subscriptions_billing_due_idx
  on public.subscriptions (current_period_end)
  where status in ('active', 'past_due');

-- cardcom-checkout writes this row right before sending the browser to
-- Cardcom's LowProfile page; cardcom-webhook reads it back to know which
-- account and plan a LowProfileId belongs to. The incoming webhook call is
-- never trusted for this mapping -- see that function's own comment.
create table if not exists public.cardcom_pending_checkout (
  low_profile_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null,
  created_at timestamptz not null default now()
);
alter table public.cardcom_pending_checkout enable row level security;
revoke all on public.cardcom_pending_checkout from anon, authenticated;

-- One row per charge attempt, success or failure -- this app's own record of
-- what happened to real money, independent of Cardcom's dashboard. Account
-- -> "AI spend" already does the equivalent for model cost from ai_usage.
create table if not exists public.cardcom_charges (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  transaction_id bigint,
  amount numeric,
  status text not null,
  error_message text,
  created_at timestamptz not null default now()
);
alter table public.cardcom_charges enable row level security;
revoke all on public.cardcom_charges from anon, authenticated;
grant select on public.cardcom_charges to authenticated;
create policy cardcom_charges_read_own on public.cardcom_charges
  for select
  using ((select auth.uid()) = user_id);
create index if not exists cardcom_charges_user_id_idx on public.cardcom_charges (user_id);

-- delete_own_account() blocked deletion while a Stripe subscription was live
-- because Stripe would keep charging a card with no account left to cancel
-- it from. Cardcom doesn't have that failure mode: cardcom-billing-cron only
-- ever charges a token it finds on a live `subscriptions` row, so cascading
-- that row away when the account is deleted is itself what stops future
-- charges -- there's nothing left elsewhere to orphan. The block stays
-- anyway, narrower: it's about not losing a paid plan to a misclick, not
-- about an external charge with no account behind it.
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
  where user_id = auth.uid() and cardcom_token is not null;

  if billing_status is not null and billing_status not in ('canceled', 'incomplete_expired') then
    raise exception 'you have an active subscription — cancel it from Account -> Manage billing first, then delete your account';
  end if;

  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_own_account() from public;
grant execute on function public.delete_own_account() to authenticated;
