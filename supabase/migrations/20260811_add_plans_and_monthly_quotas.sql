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

-- Check-and-increment in one statement so two concurrent requests can't both
-- pass the check. Returns 'ok', 'course_quota' or 'lesson_quota'.
create or replace function public.consume_ai_quota(
  p_user_id uuid,
  p_kind text,
  p_course_limit int,
  p_lesson_limit int,
  p_trialing boolean
) returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_used int;
begin
  if p_kind not in ('course', 'lesson') then
    return 'ok';   -- tutor and feedback are never metered
  end if;

  if p_trialing then
    -- Lifetime counters. A missing subscriptions row leaves v_used null and
    -- therefore denies, which is the safe direction.
    if p_kind = 'course' then
      update public.subscriptions set trial_courses_used = trial_courses_used + 1
        where user_id = p_user_id and trial_courses_used < p_course_limit
        returning trial_courses_used into v_used;
      if v_used is null then return 'course_quota'; end if;
    else
      update public.subscriptions set trial_lessons_used = trial_lessons_used + 1
        where user_id = p_user_id and trial_lessons_used < p_lesson_limit
        returning trial_lessons_used into v_used;
      if v_used is null then return 'lesson_quota'; end if;
    end if;
    return 'ok';
  end if;

  -- The older consume_daily_ai_call only UPDATEs, so a user whose first ever
  -- call lands here has no row to update. Create it before counting.
  insert into public.ai_usage (user_id) values (p_user_id)
    on conflict (user_id) do nothing;

  update public.ai_usage
    set courses_month = 0, lessons_month = 0,
        month_reset_at = date_trunc('month', current_date)::date
    where user_id = p_user_id
      and month_reset_at < date_trunc('month', current_date)::date;

  if p_kind = 'course' then
    update public.ai_usage set courses_month = courses_month + 1
      where user_id = p_user_id and courses_month < p_course_limit
      returning courses_month into v_used;
    if v_used is null then return 'course_quota'; end if;
  else
    update public.ai_usage set lessons_month = lessons_month + 1
      where user_id = p_user_id and lessons_month < p_lesson_limit
      returning lessons_month into v_used;
    if v_used is null then return 'lesson_quota'; end if;
  end if;

  return 'ok';
end;
$function$;

-- Same missing-row problem: make the daily backstop create the row it counts on.
-- Before this, a user whose ai_usage row didn't exist yet was silently denied.
create or replace function public.consume_daily_ai_call(p_user_id uuid, p_limit integer)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ok boolean;
begin
  insert into public.ai_usage (user_id) values (p_user_id)
    on conflict (user_id) do nothing;

  update public.ai_usage
  set
    calls_today = case when day_reset_at < current_date then 1 else calls_today + 1 end,
    day_reset_at = current_date
  where user_id = p_user_id
    and (day_reset_at < current_date or calls_today < p_limit)
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$function$;

-- Only the service-role client inside ai-proxy may spend quota.
revoke all on function public.consume_ai_quota(uuid, text, int, int, boolean) from public, anon, authenticated;

-- Both tables already have RLS enabled and scoped to auth.uid(); adding columns
-- does not change that. get_advisors(type => 'security') after applying reports
-- no RLS findings (only a pre-existing, unrelated Auth warning about
-- leaked-password protection being disabled).
