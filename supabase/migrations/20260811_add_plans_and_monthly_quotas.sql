-- Three subscription tiers, sold per course.
--
-- `plan` and `interval` record what was bought; the counters record what is left
-- of it. Applied to project kgkdkkqoebnpahvetwzk via the Supabase MCP
-- `apply_migration` tool — this file is the version-controlled copy, since the
-- database is remote-only and nothing else in the repo describes its schema.

alter table public.subscriptions
  add column if not exists plan text not null default 'basic',
  add column if not exists "interval" text not null default 'month',
  -- The trial cap is a lifetime total for the whole trial, not a monthly
  -- allowance, so it cannot live on the monthly counters below.
  add column if not exists trial_courses_used int not null default 0,
  add column if not exists trial_lessons_used int not null default 0;

alter table public.subscriptions
  drop constraint if exists subscriptions_plan_check;
alter table public.subscriptions
  add constraint subscriptions_plan_check check (plan in ('basic', 'pro', 'max'));

alter table public.subscriptions
  drop constraint if exists subscriptions_interval_check;
alter table public.subscriptions
  add constraint subscriptions_interval_check check ("interval" in ('month', 'year'));

-- Mirrors the calls_today / day_reset_at pattern already on this table rather
-- than introducing a second, different windowing scheme: ai_usage is one row per
-- user, and ai-proxy zeroes both counters when month_reset_at falls in an
-- earlier month, exactly as it already does for calls_today.
alter table public.ai_usage
  add column if not exists courses_month int not null default 0,
  add column if not exists lessons_month int not null default 0,
  add column if not exists month_reset_at date not null default date_trunc('month', now())::date;

-- Both tables already have RLS enabled and scoped to auth.uid(); adding columns
-- does not change that, but run get_advisors(type => 'security') afterwards to
-- confirm rather than assume.
