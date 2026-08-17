-- What the account remembers about its first run.
--
-- The intro — what the app does, what you are here for, what you are interested
-- in — is shown once and never again, so "never again" has to survive a second
-- device and a cleared browser. localStorage is kept as a cache in front of
-- this column (it is what stops the intro flashing up while the row loads), but
-- the row is the truth.
--
--   { "done": true,
--     "goal": "exam",
--     "interests": ["math", "money"],
--     "completedAt": 1755400000000,
--     "skipped": true }
--
-- Only `done` is read as a decision. The rest is the answers, shown back on the
-- Account screen and editable there — an answer nobody can see or change
-- afterwards is a question that should not have been asked.
--
-- Nullable, and the app runs without it: a failed read (including this column
-- not existing yet) leaves the local cache in charge rather than replaying the
-- intro at someone who has already been through it, so the client and this
-- migration can be deployed in either order.

alter table public.user_stats
    add column if not exists onboarding jsonb;

comment on column public.user_stats.onboarding is
    'First-run state: whether the intro has been shown, and the goal/interests answered during it.';
