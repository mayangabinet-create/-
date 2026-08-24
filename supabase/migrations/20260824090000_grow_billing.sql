-- Switching from Cardcom to Grow (Meshulam) -- easier account onboarding, and
-- Grow's own "Premium Recurring Payment" feature may charge the saved card
-- again on its own schedule, unlike Cardcom's plain saved token. No real
-- Cardcom transaction was ever processed (checkout was never wired to live
-- credentials), so those columns and tables are dropped rather than kept
-- dormant -- there is nothing to migrate.
alter table public.subscriptions
  drop column if exists cardcom_token,
  drop column if exists cardcom_token_expiry,
  drop column if exists cardcom_low_profile_id,
  drop column if exists cardcom_billing_failures;

-- grow_token is deliberately the best candidate identifier found while
-- building this (transactionToken from the first payment), not a confirmed
-- field name -- see grow-webhook's own comment and README -- Payments. It's
-- what grow-billing-cron passes to CreateTransactionWithToken; if Grow's
-- real docs name a different field for a reusable saved-card token, only
-- this column's contents need to change, not its shape.
alter table public.subscriptions
  add column if not exists grow_token text,
  add column if not exists grow_process_id text,
  add column if not exists grow_billing_failures integer not null default 0;
-- cancel_at_period_end and the subscriptions_billing_due_idx index are
-- provider-agnostic and carry over unchanged from the Cardcom migration.

drop table if exists public.cardcom_pending_checkout;
create table if not exists public.grow_pending_checkout (
  process_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null,
  created_at timestamptz not null default now()
);
alter table public.grow_pending_checkout enable row level security;
revoke all on public.grow_pending_checkout from anon, authenticated;

drop table if exists public.cardcom_charges;
create table if not exists public.grow_charges (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  transaction_id text,
  amount numeric,
  status text not null,
  error_message text,
  created_at timestamptz not null default now()
);
alter table public.grow_charges enable row level security;
revoke all on public.grow_charges from anon, authenticated;
grant select on public.grow_charges to authenticated;
create policy grow_charges_read_own on public.grow_charges
  for select
  using ((select auth.uid()) = user_id);
create index if not exists grow_charges_user_id_idx on public.grow_charges (user_id);

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
  where user_id = auth.uid() and grow_token is not null;

  if billing_status is not null and billing_status not in ('canceled', 'incomplete_expired') then
    raise exception 'you have an active subscription — cancel it from Account -> Manage billing first, then delete your account';
  end if;

  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_own_account() from public;
grant execute on function public.delete_own_account() to authenticated;
