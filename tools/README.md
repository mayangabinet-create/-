# `pdf_index` — a 300-page PDF, reduced to what Claude needs to read

> There are two PDF tools here. This one answers *which chapter, which page*
> over a book too large to read at once. Its neighbour,
> [`pdf_prep`](pdf_prep/README.md), answers the other question — *give me the
> whole document, clean* — and writes `document.md` + `document.json` for a
> model to work from. They share their reading-direction, running-header and
> Hebrew-heading rules; those live here and are imported there.

The app's browser path (see *Reading the PDF* in the root README) reads every
page of an upload and hands the planning call a digest: an outline of the
document's headings plus passages sampled across it, sized to the account's
tier. That is the right shape for planning one course from one upload.

This is the offline counterpart, for when a document needs to be addressed
rather than summarised — a chapter index with real page ranges, and
retrieval that answers one question and cites the pages it came from:

```
PDF (300 pages)
     ↓  extract.py     text off each page, whichever reader is installed
     ↓  clean.py       running headers, page numbers, contents pages, RTL repair
     ↓  structure.py   headings — פרק / Chapter / 2.4 / bare titles
     ↓  index.py       headings become chapters with page ranges
     ↓  retrieve.py    the passages one question actually needs
   Claude
```

## Install

Any one PDF reader is enough. The pipeline tries PyMuPDF, then pdfplumber,
then pypdf, and uses the first that imports.

```sh
pip install -r tools/requirements.txt
```

PyMuPDF is worth preferring: it handles right-to-left text better than the
others, which matters for Hebrew (see *Reading direction* below).

## Use

```sh
# What is in this book, and on which pages?
python3 -m tools.pdf_index index book.pdf

# The index, plus only the passages that bear on a question.
python3 -m tools.pdf_index context book.pdf --query "מס רכישה על דירה שנייה"

# Everything in one chapter — by number, by page, or by title.
python3 -m tools.pdf_index context book.pdf --chapter 2
python3 -m tools.pdf_index context book.pdf --chapter p31
python3 -m tools.pdf_index context book.pdf --chapter מיסוי

# The cleaned text, or a page range of it.
python3 -m tools.pdf_index text book.pdf --pages 25-67

# What the cleaner dropped and what the detector found — run this first
# when an index comes out wrong.
python3 -m tools.pdf_index inspect book.pdf
```

`index` and `context` both take `--json` for feeding a program instead of a
terminal. `--budget` is a hard limit: the last passage is trimmed to fit,
falling back to the last sentence end.

One thing to know about `--pages`: the cleaner learns what a running header
is by seeing it repeat, so it can only learn from the pages you asked it to
read. Over a range of two pages there is nothing to compare, and the headers
stay in.

## What comes out

```
אינדקס

  פרק 1 — חוזים ............................... עמודים 3-26
  פרק 2 — מיסוי ............................... עמודים 27-69
  פרק 3 — תכנון ובנייה ........................ עמודים 70-122
  ...

תוכן רלוונטי

[פרק 2 — מיסוי › סעיף 5 — הרחבה | עמודים 56-67]
דירה שנייה מחויבת בשיעור מס רכישה גבוה יותר...
```

On a 302-page test book that is 2,300 characters — 0.6% of the document —
and it is the 0.6% that answers the question. The index goes in the prompt
whole: it is small, and it lets the model say *which* chapter it is
answering from, and notice when the answer is somewhere it was not given.

Every passage is labelled with its full path and page range. A model told
only "section 5" does not know what it is reading; a reader checking the
answer cannot find the page.

## Reading direction

Hebrew and Arabic PDFs are frequently extracted in *visual* order — the
reader walks the page left to right and hands back each line reversed, so
`פרק 1 — חוזים` arrives as `םיזוח — 1 קרפ`. Nothing downstream survives
that: the heading keyword is no longer a word, and the index comes out as
300 lines of noise.

`clean.py` detects it by counting common Hebrew function words in the text
as it stands and in the text reversed, then flips every line if the reversed
count wins — digits and Latin runs are flipped back so `2024` does not
become `4202`. A document with no Hebrew scores zero both ways and is left
alone. `--raw` turns off cleaning altogether, including this.

## How it decides what is a heading

In falling order of trust:

1. **A keyword and a numeral** — `פרק 2`, `פרק ב׳`, `פרק שלישי`, `Chapter
   Two`, `נספח א`, `Part IV`. Hebrew numerals are read as gematria, but only
   when marked with a geresh or when a single letter: every short Hebrew word
   is also a valid number, and `דין` is not chapter 74.
2. **A decimal outline** — `2.4 Something`. Rejected if it ends in a full
   stop or runs long, because numbered contract clauses look identical.
3. **Bare title lines**, used only when the first two found almost nothing.
   A candidate must be short *relative to the body text on its own page*,
   and if this rule fires on a third of the pages the whole set is thrown
   away — a coarse index beats a wrong one.

Two things are actively suppressed: contents pages (dot leaders, or a page
that is four headings and nothing else), and a heading repeated on the next
page, which is a running header that survived cleaning.

A chapter's **text** stops at the next heading of any level. Its **page
range** runs to the next heading at the same level or higher, so a
sub-section on page 30 does not end chapter 2 — that is what a reader looks
up.

## Retrieval

The scoring is deliberately the same as `retrieveExcerpt` in `app.js`:
tokens over two characters, TF-IDF with `log(1 + N/df)`, and a floor at 55%
of the best chunk's score so a budget is never padded with the merely
adjacent. Both sides score the whole stored document, so they agree on what
"relevant" means.

What differs is where the chunk boundaries fall. In the browser they follow
the paragraphs the extractor found; here they stop at chapter boundaries, so
a chunk never straddles two chapters and every passage arrives knowing which
chapter and pages it came from — which is what makes a citation possible.

## Testing

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
```

Every stage after extraction is a pure function over a list of pages, so
most of the suite runs on the standard library alone. The end-to-end class
builds a real PDF with reportlab, reads it back, and skips itself when
reportlab or a PDF reader is missing.

## What this does not do

- **No OCR.** A scanned PDF has no text layer; extraction says so and stops
  rather than returning 300 blank pages. Run `ocrmypdf in.pdf out.pdf`
  first.
- **No API calls.** It prints the context block; sending it is the app's
  job, and the Anthropic key lives in the `ai-proxy` Edge Function, not
  here.
- **Not wired into the app.** `app.js` has its own extraction and digest in
  JavaScript; this is a separate Python path and nothing in the app calls it.
  Using it from the app means running it server-side — the natural home is
  next to `ai-proxy`, which already holds the tier limits that decide how
  much of a document an account may read.
- **Some of this exists twice.** Reading direction, running-header removal and
  hyphen rejoining are solved on both sides now, in two languages, by two
  different methods — `app.js` has glyph geometry and font sizes to work
  from, this has only the text. Worth collapsing if the pipeline ever moves
  server-side; not worth collapsing before then.
