# `pdf_prep` — a PDF, prepared for a model to read

A PDF is a description of ink on paper. It has no paragraphs, no headings, no
reading order — only glyphs at coordinates, plus 300 copies of a running header
that a person's eye skips and a model's does not. Handed to a model raw, it
costs tokens to carry noise and loses the structure that would have told the
model what it was reading.

This turns one into two files:

```
PDF
 ↓  read.py      pages, with font sizes, boxes and images; OCR where needed
 ↓  order.py     columns found, bidi runs fused, lines put in reading order
 ↓  objects.py   tables and figures lifted out, keeping their place
 ↓  tidy.py      running headers, page numbers, hyphens, reading direction
 ↓  blocks.py    headings, lists, formulas, footnotes; lines joined into prose
 ↓  chunk.py     an outline with page ranges, chunks sized for one call
 ↓  emit.py      document.md  +  document.json
```

No model is called anywhere in it. Everything above is rules over geometry and
text, which means it costs nothing to run, gives the same answer twice, and
cannot invent a sentence the document does not contain.

## Install and use

```sh
pip install -r tools/requirements.txt         # PyMuPDF is the one that matters
python3 -m tools.pdf_prep book.pdf -o out/
```

```
out/document.md      the text — headings, paragraphs, lists, tables, formulas
out/document.json    the map — outline, chunks, tables, figures, page ranges
out/assets/f001.png  every figure, extracted
```

## Handing it to the app

`--bundle` writes a fourth file, `document.bundle.json`, holding the Markdown
and the manifest together:

```sh
python3 -m tools.pdf_prep book.pdf -o out/ --bundle
```

Upload that one file to the app's upload box and the course is planned from
this outline — real headings, real page numbers — instead of one the browser
re-derived from the text. It is also how a **scanned** PDF gets into the app at
all: the browser's reader has no OCR, so today a scan gives it nothing.

Two files are right on disk, where a person reads one and a program reads the
other. One file is right at an upload box, which takes one file — and a user
who picks only one of the two ends up with text that has no structure, or
structure pointing at text that is not there. Nothing is duplicated by joining
them: the Markdown appears once, and the manifest's character ranges index into
it exactly as they do on disk.

```json
{ "schema": "pdf-prep/1", "kind": "bundle",
  "markdown": "---\ntitle: …",
  "manifest": { "outline": […], "chunks": […], … } }
```

The app stores the outline it reads from there in `courses.structure`
(`supabase/migrations/20260813120000_courses_structure.sql`), and keeps
working without it: an unmigrated database, a plain PDF or a wall of pasted
text all fall back to deriving what structure they can from the text.

For a scanned document, install tesseract and its language packs first:

```sh
apt install tesseract-ocr tesseract-ocr-heb        # or: brew install tesseract
```

Useful flags — `--bundle` (see below), `--pages 3-40`, `--ocr never|always`,
`--ocr-lang heb+eng`, `--chunk-chars 6000`, `--no-assets`, `--stdout md` to
pipe it somewhere.

From Python:

```python
from tools.pdf_prep import prepare

document = prepare("book.pdf", output_dir="out/")
print(document.title, len(document.chunks), document.warnings)
```

## The two files, and why they are two

`document.md` holds the text. `document.json` holds everything *about* the
text — and no copy of it. Every section, chunk, table and figure records the
character range of `document.md` it occupies:

```json
{ "id": "c007", "heading_path": ["פרק 2 — מיסוי", "2.1 מדרגות המס"],
  "page_start": 31, "page_end": 34, "chars": 3980,
  "terms": ["רכישה", "מדרגה", "דירה", "שיעור"],
  "md_start": 48210, "md_end": 52190 }
```

So a consumer seeks rather than parses: read the JSON, decide which chunks
matter, and slice those ranges out of the Markdown. Nothing is stored twice,
which means the two files cannot drift apart, and the JSON stays small enough
to put in a prompt whole even when the Markdown is a megabyte — on a 120-page
report, 62 KB of map against 309 KB of text.

Part of keeping it that size is what `blocks` holds: the structural blocks —
headings, tables, figures, formulas, footnotes — and not every paragraph, which
the chunk ranges already address and which would double the file. `--block-index`
asks for all of them, and `document.block_index` in the JSON says which of the
two you are holding, so a missing id is never ambiguous.

The `terms` are TF-IDF over the document's own chunks, scored exactly the way
`pdf_index/retrieve.py` and `retrieveExcerpt` in `app.js` score theirs. They
are there so a model handed the JSON can choose what to read instead of being
handed 300 pages and asked to guess.

**Provenance survives into the Markdown too.** Page boundaries are written as
`<!-- page 31 -->` comments: invisible when rendered, and enough for a model
that has read only the Markdown to say which page an answer came from.

## What it does to a page

**Reading order before anything else.** A two-column page read top to bottom
interleaves into nonsense that no later stage can repair. Columns are found
from a coverage histogram of the page's own geometry — deliberately tolerant of
lines that cross the gutter, because a title, a running header and a centred
page number all do, and a gutter defined as space *nothing* crosses is a gutter
that is never found. Lines that do cross split the page into bands, so a
spanning heading stays above the columns it introduces instead of being
teleported to the top.

**Right-to-left is not an afterthought.** PyMuPDF returns a Hebrew line as one
piece per direction run: `פרק 1 — חוזים` arrives as four. Left alone, each
becomes a heading of its own and a five-chapter book grows fifty. They are
fused back into one line in reading order, and whether a space belongs between
two pieces is decided by the space actually on the page — recorded in the run's
own text, or visible as a gap the width of one — so `ש"ח` does not come back as
`ש " ח`, and a word split by a bold first letter comes back as one word.

Separately, some producers hand back RTL text *reversed*, `םיזוח` for `חוזים`.
That is detected by counting common Hebrew function words in the text as it
stands and in the text reversed, and flipping if the reversed count wins.

**Headings from two kinds of evidence.** Font size and weight when the document
has them — sizes clustered, so 16.2 and 17.1 are one level and not two, which
is what an OCR'd page produces. Wording when it does not: `פרק ב׳`, `Chapter
Four`, `3.1 מבוא`, read by the keyword and gematria rules in
`pdf_index/structure.py`, imported rather than written twice.

**Paragraphs, rebuilt.** The joiner uses the gap above a line, its indent, and
how full the line before it was — not punctuation, which in Hebrew has neither
capitals nor a full stop a regex can trust. A sentence broken across a page
break is rejoined, and the block then belongs to both pages.

**Tables as data.** PyMuPDF finds the grid; each cell is then re-read from our
own spans, because the finder reads straight off the page and on an RTL
document that means backwards. They come out as GFM tables in the Markdown and
as `data: [[…]]` in the JSON, so a consumer never has to parse a pipe table.

**Furniture removed, and recorded.** A line repeated in the margins of a third
of the pages is a running header whatever it says; repetition is matched on a
fingerprint with the digits blanked, so `עמוד 41` and `עמוד 42` are seen to be
the same line. Page numbers, contents pages, divider rules and hyphens broken
across lines go the same way. Everything dropped is kept on `page.dropped` and
counted in the manifest's `cleaning` block, so a cleaner that ate a paragraph
can be caught rather than guessed at. A contents page is *emptied*, not
removed: page 5 stays page 5 with a hole in it, so every page number quoted
downstream is still the printed one.

**OCR per page, not per document.** A page with no text worth the name is
recognised with tesseract; the rest of the file is read normally. Real
documents are mixed — a scanned appendix bolted onto a typed report — and
OCR'ing the typed pages would replace good text with a guess. Pages that were
OCR'd are listed in the manifest and warned about, because a recognition is
not a copy.

## What comes out

```markdown
---
title: "מדריך המשפט המעשי"
source: "book.pdf"
pages: "302"
language: "he"
---

# מדריך המשפט המעשי

<!-- page 31 -->

## פרק 2 — מיסוי

מס רכישה מוטל על רוכש זכות במקרקעין. שיעור המס נקבע לפי שווי העסקה...

### 2.1 מדרגות המס

**טבלה 1: מדרגות מס רכישה**

| מדרגה | שיעור |
| --- | --- |
| עד מיליון ש"ח | 0% |
```

The manifest carries `source`, `document`, `extraction`, `cleaning`, `counts`,
`outline`, `chunks`, `tables`, `figures`, `formulas`, `footnotes`, `pages`,
`blocks` and `warnings`. `extraction` and `cleaning` are there to be read when
something comes out wrong: which backend ran, which pages were OCR'd, what the
body font size was judged to be, how many headers were dropped.

## Testing

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
```

`tests/test_pdf_prep.py` runs most of its cases on pages written out by hand —
every stage after reading is a pure function over lines with boxes. The
end-to-end classes build real PDFs, including a Hebrew one with genuine
right-to-left layout and a rasterised copy of it for the OCR path, and skip
themselves when PyMuPDF, the test font or tesseract is missing.

## Limits worth knowing

- **A table in a scan is usually lost.** Table finding needs ruling lines or
  aligned text on the page; a rasterised page has neither until OCR has run,
  and OCR output is not fed back to the finder. The cells' text survives as
  paragraphs — the grid does not.
- **Column order in a table is geometric.** Columns come out left to right, as
  the file lays them out. A Hebrew table laid out right to left therefore
  arrives with its columns in the mirror of its reading order. Each column
  still carries its own header, so no row is ever read against the wrong
  heading, and nothing in the file says which of the two a given table is —
  guessing was worse than being consistent.
- **Formulas are recovered as text, not as LaTeX.** A line judged to be
  mathematics is wrapped in `$$`. What is inside is the characters the PDF
  stored; a fraction built out of two stacked boxes does not become `\frac`.
- **Multi-line footnotes.** Each footnote line becomes its own note. A note
  that wraps onto a second line arrives as two.
- **Without PyMuPDF** the pipeline falls back to `pdf_index`'s text-only
  readers: no font sizes, no tables, no figures, headings from wording alone.
  It says so in `warnings` rather than pretending otherwise.

## Next to `pdf_index`

`tools/pdf_index` answers "which chapter is this, and on what page" over a book
too large to read at once. This one answers "give me the whole document,
clean". They share what is the same problem in both: reading direction, running
headers, and what a Hebrew chapter heading looks like. Those live in
`pdf_index` and are imported here — `clean.flip_line`,
`clean.looks_like_page_number`, `clean.looks_like_contents`,
`structure.match_heading_line`, `retrieve.tokenize`.

`pdf_index` is not wired into the app. This one is, by file rather than by
call: `--bundle`, then upload. That is a deliberate shape, not a stopgap for a
missing API — `ai-proxy` is a Deno Edge Function and cannot run Python, so a
live call would need a Python service deployed somewhere and a queue to reach
it. The file contract needs neither, works offline, and is the same artifact
either way if that service is ever built: it would write exactly this bundle.
