-- Trial shortened from 14 days to 3. Same trigger, same shape — only the
-- interval literal changes, so every account created from here on gets a
-- subscriptions row with current_period_end 3 days out instead of 14.
-- Accounts already trialing keep whatever current_period_end they were
-- given at signup; this does not retroactively shorten anyone already in
-- their trial.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.subscriptions (user_id, status, current_period_end)
  values (new.id, 'trialing', now() + interval '3 days');
  insert into public.ai_usage (user_id)
  values (new.id);
  return new;
end;
$$;
