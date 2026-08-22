-- Regression test for the RLS policies and function grants in
-- supabase/migrations/*.sql — the area that has already shipped one real
-- bug (20260818143500_delete_own_account_revoke_anon.sql exists because a
-- SECURITY DEFINER function kept an unintended `anon` EXECUTE grant after
-- its own migration's "revoke from public" ran) and had zero automated
-- coverage before this file.
--
--     supabase test db
--
-- (pgTAP; needs the Supabase CLI + Docker. Also runnable directly —
-- `psql -f` this file against any Postgres with pgTAP installed, which is
-- how it was developed and verified: `apt-get install postgresql-16-pgtap`.)
--
-- Scope. This repo's migrations/ only ever ALTERs existing tables — none of
-- them CREATEs `courses`, `progress`, `subscriptions`, `ai_usage`, or
-- `user_stats`, which means the base schema lives only on the live project
-- and `supabase db reset` cannot rebuild it from this repo alone (worth
-- fixing separately — see the accompanying coverage report). So this test
-- does not touch `public.*`: it builds fixture tables under `rls_fixture`
-- with just the columns RLS cares about (id, user_id) and applies the exact
-- policy predicates copied verbatim from the migrations, cited inline. That
-- tests the authored logic precisely — a future migration that weakens a
-- predicate (drops the `with check`, flips the comparison, forgets a
-- policy) fails this test — without guessing at columns this repo has never
-- defined. When the base-schema gap above is fixed, this can be pointed at
-- the real `public.*` tables directly.
--
-- auth.uid()/auth.users/the anon+authenticated+service_role roles are real
-- Supabase infrastructure already present on any Supabase Postgres — the
-- `if not exists` guards below only matter when running against a bare
-- Postgres instance that doesn't have them (as when developing this file).

begin;
select plan(20);

-- ---------------------------------------------------------------- fixtures
do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'auth') then
    create schema auth;
  end if;
end $$;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

-- Supabase's own definition (supabase/postgres init SQL): the caller's id,
-- read from the JWT claim PostgREST sets per-request.
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

create schema if not exists rls_fixture;
grant usage on schema rls_fixture to anon, authenticated, service_role;

-- courses_owner / progress_owner / ai_usage_owner / user_stats_owner: all
-- four are the identical predicate, from
-- supabase/migrations/20260818090000_rls_perf_and_debug_grant_fix.sql:
--   using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)
create table rls_fixture.courses (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id));
create table rls_fixture.progress (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id));
create table rls_fixture.ai_usage (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id));
create table rls_fixture.user_stats (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id));
grant select, insert, update, delete on
  rls_fixture.courses, rls_fixture.progress, rls_fixture.ai_usage, rls_fixture.user_stats
  to authenticated;

do $$
declare t text;
begin
  foreach t in array array['courses', 'progress', 'ai_usage', 'user_stats'] loop
    execute format('alter table rls_fixture.%I enable row level security', t);
    execute format(
      'create policy owner on rls_fixture.%I using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',
      t
    );
  end loop;
end $$;

-- subscriptions_read_own, from the same migration: select-only, no write
-- policy at all (the row is written by service_role / debug_set_plan).
create table rls_fixture.subscriptions (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id), plan text);
grant select, insert, update, delete on rls_fixture.subscriptions to authenticated, service_role;
alter table rls_fixture.subscriptions enable row level security;
create policy subscriptions_read_own on rls_fixture.subscriptions
  for select using ((select auth.uid()) = user_id);

-- material_reports, from supabase/migrations/20260813140000_material_reports.sql:
-- insert and select only, each restricted to `to authenticated`, using the
-- un-wrapped `auth.uid() = user_id` (this table predates the perf fix
-- migration and was never touched by it).
create table rls_fixture.material_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  code text
);
grant select, insert, update, delete on rls_fixture.material_reports to authenticated;
alter table rls_fixture.material_reports enable row level security;
create policy "own reports insert" on rls_fixture.material_reports
  for insert to authenticated with check (auth.uid() = user_id);
create policy "own reports select" on rls_fixture.material_reports
  for select to authenticated using (auth.uid() = user_id);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

create or replace function rls_fixture.act_as(uid uuid) returns void
language sql as $$
  select set_config('request.jwt.claim.sub', uid::text, true);
$$;

create or replace procedure rls_fixture.reset_role() language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- ------------------------------------------------------------------- tests
-- courses/progress/ai_usage/user_stats: one representative pair (courses)
-- for the cross-user read/write/delete story, then one assertion per
-- remaining table confirming the same predicate is actually wired up —
-- the four are meant to be identical, and that itself is worth pinning.

set role authenticated;
select rls_fixture.act_as('11111111-1111-1111-1111-111111111111');
insert into rls_fixture.courses (user_id) values ('11111111-1111-1111-1111-111111111111');
select rls_fixture.act_as('22222222-2222-2222-2222-222222222222');
insert into rls_fixture.courses (user_id) values ('22222222-2222-2222-2222-222222222222');

select rls_fixture.act_as('11111111-1111-1111-1111-111111111111');
select is(
  (select count(*)::int from rls_fixture.courses), 1,
  'a course row is visible only to the account that owns it'
);
select is(
  (select user_id from rls_fixture.courses limit 1), '11111111-1111-1111-1111-111111111111'::uuid,
  'and it is the caller''s own row, not the other account''s'
);

-- Cannot even attempt to write another account's row: an update naming a
-- user_id you don't own matches zero rows before it can violate WITH CHECK.
update rls_fixture.courses set user_id = user_id where user_id = '22222222-2222-2222-2222-222222222222';
select is(
  (select count(*)::int from rls_fixture.courses where user_id = '22222222-2222-2222-2222-222222222222'), 0,
  'the other account''s row is invisible to an update targeting it, not just to select'
);

delete from rls_fixture.courses where user_id = '22222222-2222-2222-2222-222222222222';
select rls_fixture.act_as('22222222-2222-2222-2222-222222222222');
select is(
  (select count(*)::int from rls_fixture.courses), 1,
  'a delete naming the other account''s row deletes nothing — it stays intact for its owner'
);

-- WITH CHECK, not just USING: an owned row cannot be reassigned to someone
-- else's account by updating user_id out from under the policy.
select throws_ok(
  $$ update rls_fixture.courses set user_id = '11111111-1111-1111-1111-111111111111' where user_id = '22222222-2222-2222-2222-222222222222' $$,
  '42501',
  null,
  'reassigning a row to another account is blocked by WITH CHECK, not silently allowed'
);

select rls_fixture.act_as('99999999-9999-9999-9999-999999999999');
select is(
  (select count(*)::int from rls_fixture.courses), 0,
  'a signed-in caller with no rows of their own sees none of anyone else''s'
);

call rls_fixture.reset_role();
set role anon;
select throws_like(
  $$ select * from rls_fixture.courses $$,
  '%permission denied%',
  'anon has no grant on courses at all — not even an empty result, a denial'
);
call rls_fixture.reset_role();
reset role;

-- progress / ai_usage / user_stats: same predicate, pinned independently so
-- a change to one table's policy that isn't mirrored to the others is caught.
do $$
declare t text;
begin
  foreach t in array array['progress', 'ai_usage', 'user_stats'] loop
    execute format($f$
      set role authenticated;
      select rls_fixture.act_as('11111111-1111-1111-1111-111111111111');
      insert into rls_fixture.%1$I (user_id) values ('11111111-1111-1111-1111-111111111111');
      select rls_fixture.act_as('22222222-2222-2222-2222-222222222222');
      insert into rls_fixture.%1$I (user_id) values ('22222222-2222-2222-2222-222222222222');
      select rls_fixture.act_as('11111111-1111-1111-1111-111111111111');
    $f$, t);
  end loop;
end $$;

select is((select count(*)::int from rls_fixture.progress), 1, 'progress_owner isolates rows the same way');
select is((select count(*)::int from rls_fixture.ai_usage), 1, 'ai_usage_owner isolates rows the same way');
select is((select count(*)::int from rls_fixture.user_stats), 1, 'user_stats_owner isolates rows the same way');
call rls_fixture.reset_role();
reset role;

-- subscriptions: read-only. The client's own key can never write a plan or
-- status for itself — only debug_set_plan (SECURITY DEFINER, checked
-- separately below) or the service role can. Seeded as service_role, since
-- (per the policy itself) `authenticated` has no insert grant to seed with —
-- that absence is exactly what this section is testing.
set role service_role;
insert into rls_fixture.subscriptions (user_id, plan) values ('11111111-1111-1111-1111-111111111111', 'basic');
insert into rls_fixture.subscriptions (user_id, plan) values ('22222222-2222-2222-2222-222222222222', 'max');
reset role;

set role authenticated;
select rls_fixture.act_as('11111111-1111-1111-1111-111111111111');
select is(
  (select count(*)::int from rls_fixture.subscriptions), 1,
  'subscriptions read is owner-only, same as the write-capable tables'
);
-- No policy for a command (here, UPDATE) means RLS filters it to zero rows
-- for that command, the same silent-no-op as an absent/mismatched USING
-- clause — it is not a thrown permission error (that's WITH CHECK's job,
-- exercised on courses above). So the honest assertion is "nothing changed".
update rls_fixture.subscriptions set plan = 'max' where user_id = '11111111-1111-1111-1111-111111111111';
select is(
  (select plan from rls_fixture.subscriptions where user_id = '11111111-1111-1111-1111-111111111111'),
  'basic',
  'a signed-in account cannot upgrade its own plan directly — there is no write policy at all, the update touches nothing'
);
call rls_fixture.reset_role();
reset role;

-- material_reports: insert + select only, explicitly `to authenticated`
-- (never anon), and every row belongs to the account that filed it.
set role authenticated;
select rls_fixture.act_as('11111111-1111-1111-1111-111111111111');
insert into rls_fixture.material_reports (user_id, code) values ('11111111-1111-1111-1111-111111111111', 'too_short');
select throws_ok(
  $$ insert into rls_fixture.material_reports (user_id, code) values ('22222222-2222-2222-2222-222222222222', 'too_short') $$,
  '42501',
  null,
  'a report cannot be filed in another account''s name — WITH CHECK on the insert policy'
);
select rls_fixture.act_as('22222222-2222-2222-2222-222222222222');
select is(
  (select count(*)::int from rls_fixture.material_reports), 0,
  'one account cannot read a report another account filed'
);

-- Same as subscriptions above: no UPDATE/DELETE policy means those commands
-- are filtered to zero rows, silently — even for the report's own author.
select rls_fixture.act_as('11111111-1111-1111-1111-111111111111');
update rls_fixture.material_reports set code = 'x' where user_id = '11111111-1111-1111-1111-111111111111';
select is(
  (select code from rls_fixture.material_reports limit 1), 'too_short',
  'there is no update policy on material_reports at all — even the owner cannot edit a filed report'
);
delete from rls_fixture.material_reports where user_id = '11111111-1111-1111-1111-111111111111';
select is(
  (select count(*)::int from rls_fixture.material_reports), 1,
  'nor is there a delete policy — even the owner cannot remove a filed report'
);
call rls_fixture.reset_role();
set role anon;
select throws_like(
  $$ select * from rls_fixture.material_reports $$,
  '%permission denied%',
  'anon cannot read material_reports — the select policy names `to authenticated` only'
);
select throws_like(
  $$ insert into rls_fixture.material_reports (user_id, code) values (null, 'x') $$,
  '%permission denied%',
  'nor can anon insert one'
);
call rls_fixture.reset_role();
reset role;

-- ------------------------------------------------- SECURITY DEFINER grants
-- The exact class of bug this file exists to catch: a function meant to be
-- authenticated-only that anon can still call because Supabase auto-grants
-- EXECUTE to every role on function creation
-- (supabase/migrations/20260818143500_delete_own_account_revoke_anon.sql).
create or replace function rls_fixture.debug_set_plan(new_plan text)
returns void language plpgsql security definer set search_path = rls_fixture as $$
declare caller_email text;
begin
  select email into caller_email from auth.users where id = auth.uid();
  if caller_email is distinct from 'mayangabinet@gmail.com' then
    raise exception 'not permitted';
  end if;
  if new_plan not in ('basic', 'pro', 'max') then
    raise exception 'invalid plan: %', new_plan;
  end if;
  insert into rls_fixture.subscriptions (user_id, plan) values (auth.uid(), new_plan)
  on conflict (user_id) do update set plan = excluded.plan;
end $$;
revoke all on function rls_fixture.debug_set_plan(text) from public;
grant execute on function rls_fixture.debug_set_plan(text) to authenticated;

set role anon;
select throws_like(
  $$ select rls_fixture.debug_set_plan('max') $$,
  '%permission denied%',
  'anon has no EXECUTE grant on debug_set_plan at all'
);
reset role;

set role authenticated;
select rls_fixture.act_as('22222222-2222-2222-2222-222222222222');
select throws_like(
  $$ select rls_fixture.debug_set_plan('max') $$,
  '%not permitted%',
  'a signed-in account that is not the hardcoded email is refused, not granted a plan'
);
call rls_fixture.reset_role();
reset role;

-- ------------------------------------------------------------------------
select * from finish();
rollback;
