-- Let an account be put on the unlimited plan.
--
-- `subscriptions.plan` is checked against a fixed list, and that list predates
-- the plan. Without this the row simply cannot be written: the UPDATE fails
-- with 23514 and the account stays on whatever it was.
--
-- The check is what makes the column trustworthy — ai-proxy's `planFor` falls
-- back to `basic` for anything it does not recognise, so a typo here would
-- silently downgrade an account rather than break loudly. Widen it by exactly
-- one value, and no more.
--
-- This plan is granted, never sold. There is no INSERT or UPDATE policy on
-- `subscriptions`, so a signed-in browser cannot write its own plan at all —
-- only the service role can, which is the whole reason a value meaning "no
-- monthly ceiling" is safe to have in the column.
--
-- Apply before deploying an ai-proxy that knows the plan; the order does not
-- matter for correctness (an unknown plan name reads as `basic`, so the
-- account keeps working either way) but this way the row is writable first.

alter table public.subscriptions
  drop constraint if exists subscriptions_plan_check;

alter table public.subscriptions
  add constraint subscriptions_plan_check
  check (plan = any (array['basic'::text, 'pro'::text, 'max'::text, 'unlimited'::text]));

comment on column public.subscriptions.plan is
  'Which row of PLANS in ai-proxy applies. NULL or unrecognised reads as basic. '
  '"unlimited" has no monthly course or lesson ceiling and is granted server-side only.';
