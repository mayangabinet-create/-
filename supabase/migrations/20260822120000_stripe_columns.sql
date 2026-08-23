-- Columns checkout and the webhook need on `subscriptions`, which this repo's
-- migrations only ever ALTER (see tests.yml: the table itself predates
-- migrations here). Both are unique: one Stripe customer maps to one
-- account, and one Stripe subscription is never attached to two rows.
alter table public.subscriptions
  add column if not exists stripe_customer_id text unique,
  add column if not exists stripe_subscription_id text unique;
