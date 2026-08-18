-- Performance: every owner-scoped RLS policy called auth.uid() directly in
-- its USING/WITH CHECK clause, which Postgres re-evaluates once per row
-- scanned rather than once per query. Wrapping it in a scalar subselect is
-- the fix Supabase's own advisor recommends; the access rule itself (row's
-- user_id must equal the caller) is unchanged.
alter policy "courses_owner" on public.courses
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);

alter policy "progress_owner" on public.progress
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);

alter policy "subscriptions_read_own" on public.subscriptions
    using ((select auth.uid()) = user_id);

alter policy "ai_usage_owner" on public.ai_usage
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);

alter policy "user_stats_owner" on public.user_stats
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);

alter policy "own reports insert" on public.material_reports
    with check ((select auth.uid()) = user_id);

alter policy "own reports select" on public.material_reports
    using ((select auth.uid()) = user_id);

-- Every read of material_reports is filtered by user_id (see the policy
-- above); a foreign key with no covering index becomes a sequential scan
-- once the table has real volume rather than the one row it has today.
create index if not exists material_reports_user_id_idx on public.material_reports (user_id);

-- debug_set_plan already checks the caller's own email against auth.users
-- before doing anything — auth.uid() is null for a signed-out caller, and
-- `is distinct from` treats null as distinct from the one allowed email, so
-- an anonymous call always raised 'not permitted'. It was never exploitable.
-- But Supabase grants EXECUTE on newly created functions to anon and
-- authenticated by default, and this function's original migration only
-- revoked the PUBLIC-derived fallback, not that direct grant — so anon
-- still had EXECUTE it never needed. Closing that explicitly rather than
-- relying on the function's own internal check as the only line of defence.
revoke execute on function public.debug_set_plan(text) from anon;
