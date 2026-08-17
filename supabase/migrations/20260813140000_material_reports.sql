-- Documents the app refused, and the learner said it was wrong about.
--
-- The gate in app.js decides from arithmetic whether a document can carry a
-- course: how much of it is digits, whether it has sentences, whether it says
-- the same thing on every line. Arithmetic guessing at intent is wrong
-- sometimes, and when it is, the learner is the only one who knows.
--
-- So the override is also a report. Every time someone presses "you've got this
-- wrong", a row lands here saying which rule fired and what the numbers were —
-- which is exactly what is needed to move a threshold that is set too tight.
--
-- What is NOT stored is the document. Not the text, not its title, not a
-- fragment: only the shape of it, which is all the check itself ever looked at.
-- A person reporting a bad refusal should not have to donate their bank
-- statement to do it.

create table if not exists public.material_reports (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid references auth.users(id) on delete set null,
    code        text not null,            -- which rule refused it
    stats       jsonb not null default '{}'::jsonb,
    source      text,                     -- 'pdf' | 'bundle' | 'text'
    created_at  timestamptz not null default now()
);

comment on table public.material_reports is
    'One row per "you got this wrong" on the material gate. Holds the refusal reason and the document''s measurements, never the document.';

alter table public.material_reports enable row level security;

-- A signed-in learner may file a report, and only in their own name. Nobody
-- reads these through the API: they are for whoever is tuning the thresholds,
-- through the service role.
drop policy if exists "own reports insert" on public.material_reports;
create policy "own reports insert" on public.material_reports
    for insert to authenticated
    with check (auth.uid() = user_id);

drop policy if exists "own reports select" on public.material_reports;
create policy "own reports select" on public.material_reports
    for select to authenticated
    using (auth.uid() = user_id);

create index if not exists material_reports_code_idx
    on public.material_reports (code, created_at desc);
