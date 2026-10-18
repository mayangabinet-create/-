-- Who a course is for, and how they will be tested on it.
--
-- The same document is a different course for a high-school student before a
-- school exam, a university student, and an adult before a licensing exam:
-- different vocabulary, different depth, and above all a different kind of
-- question. Asked once on the upload screen and read by every lesson prompt.
--
--   { "level": "school" | "university" | "professional" | "self",
--     "exam":  "choice" | "open" | "problems" | "none" }
--
-- Either key may be missing ("not sure"). Nullable, and the app runs without
-- it: a course saved before this column existed is pitched as it always was.

alter table public.courses
    add column if not exists learner jsonb;

comment on column public.courses.learner is
    'Who the course is for and how they will be tested: {level, exam}. Null when not given.';
