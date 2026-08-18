-- Self-service account deletion. Every app table's user_id foreign key
-- already cascades from auth.users (material_reports sets it null instead,
-- since that table never carries anything personal to begin with — see
-- 20260813140000_material_reports.sql) — deleting the auth row *is*
-- deleting the account, nothing else needs to be listed here by hand and
-- nothing added later needs this function to be revisited as long as its
-- own user_id foreign key targets auth.users the same way.
--
-- SECURITY DEFINER for the same reason as debug_set_plan: only a role with
-- rights on auth.users can delete from it, and the account calling this is
-- never that role. auth.uid() — not anything client-supplied — is what's
-- deleted, so this can only ever remove the caller's own account.
create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from auth.users where id = auth.uid();
end;
$$;

comment on function public.delete_own_account() is
    'Deletes the calling account. Cascades to courses/progress/subscriptions/ai_usage/user_stats; sets material_reports.user_id null.';

-- Same REVOKE + narrow GRANT as debug_set_plan: callable via RPC by any
-- signed-in account (on itself only), by no one else.
revoke all on function public.delete_own_account() from public;
grant execute on function public.delete_own_account() to authenticated;
