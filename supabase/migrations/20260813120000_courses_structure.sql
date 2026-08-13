-- The outline of a course's document, when the document arrived with one.
--
-- `source_text` holds the words; everything the app knows about their shape it
-- has to re-derive from them on every read, which is why that derivation is
-- deterministic. A document prepared by tools/pdf_prep does not need deriving:
-- it comes with an outline read from font sizes, table grids and OCR, carrying
-- page numbers that no amount of reading the text can recover.
--
-- Kept deliberately small — titles, depths and page ranges, not the manifest's
-- tables, figures or per-chunk terms — because it is read on every planning
-- call and nothing here looks at the rest.
--
--   { "source": "pdf-prep",
--     "pages": 302,
--     "sections": [ { "title": "פרק 2 — מיסוי", "level": 1,
--                     "pageStart": 31, "pageEnd": 56 }, ... ] }
--
-- Nullable, and the app runs without it: a course saved before this column
-- existed, or one built from a pasted wall of text, derives its outline from
-- the text as it always did.

alter table public.courses
    add column if not exists structure jsonb;

comment on column public.courses.structure is
    'Document outline from tools/pdf_prep (titles, depths, page ranges). Null when the outline is derived from source_text instead.';
