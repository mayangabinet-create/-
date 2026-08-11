# AI Learning Path

Two files — `index.html` (markup + styles) and `app.js` — in Duolingo's visual
language, with no build step and no framework. Sign in, name your course, upload a
PDF (or paste text), and the app turns it into a Duolingo-style learning path: 10-20
concepts extracted and ordered by prerequisite, each opening a multi-step interactive
lesson grounded in your own document. Courses can be renamed any time, from the card
in your library or by tapping the title above the path.

## Quick start

- **Live:** open this repo's GitHub Pages URL (Settings → Pages, once enabled) and
  sign up with an email + password.
- **Locally:** open `index.html` directly in a browser (double-click, or `file://`
  works fine) — it talks to the same hosted backend either way.

There's no API key to paste in. Every account gets a 14-day free trial automatically;
subscribing after that isn't wired up yet (see below).

## What a lesson contains

Hook → prediction → concept cards → worked example → guided practice → a mixed-format
quiz (choice, true/false, ordering, categorizing, fill-the-blank, matching, find-the-mistake)
→ a capstone challenge → summary → a memory check, plus an AI tutor dock available
throughout. Diagrams (flow, compare, hierarchy, timeline, table, bar) are generated
from structured specs the model returns — no image generation, no extra API calls.

Every lesson is grounded in the source document: the relevant passage is retrieved via
TF-IDF and sent to the model with strict rules that facts and quiz questions must come
from that passage, not general knowledge.

## Reading the PDF

A PDF page is not text — it is a bag of positioned glyph runs — so how the file is read
decides everything the model can know about it. Three steps:

**Extraction.** Every page is read (the reader used to stop at page 20). Runs are grouped
into lines by baseline, ordered by position, and joined using the gap between them so
words are neither glued together nor split apart. Hebrew and Arabic lines are read
right-to-left: PDF.js emits runs in *visual* order, which for RTL is backwards, and a
line only splits into multiple runs when a digit or a Latin word interrupts it — so it is
exactly the numbered headings (`פרק 2: המיטוכונדריה`) that come out inside out if this is
ignored. Lines then become paragraphs, using vertical gaps, line width and type size —
a heading is set larger than body text, which separates it far more reliably than spacing
does. Words hyphenated across a line-wrap are rejoined. Running heads and page-number
footers are detected by repetition across pages and dropped, with headings exempt from
the digit-insensitive form of that match, since "Chapter 1", "Chapter 2" and "Chapter 3"
otherwise look like one line repeating and the whole outline gets deleted.

**Condensing.** The planning call cannot hold a textbook, so it gets a digest rather than
the first N characters. Taking the first N is the worst available choice: the opening
pages of a book are the title page, the copyright notice and the table of contents, and a
course built from them lists the chapters instead of teaching them. The digest is an
outline of the document's own headings, its opening and closing, and body passages sampled
across the whole document — segments chosen by position first and quality second, so the
last chapter is represented as surely as the first. On a 27-page test book at Basic's
budget this quotes 8 of 12 chapters and names all 12, where the old head-slice reached 1.

**Retrieval.** Unchanged in shape — TF-IDF over the whole stored document, per lesson —
but chunking now breaks on paragraph boundaries where the extractor found them, and the
budget comes from the account's tier instead of a constant.

`tests/pdf-pipeline.js` covers all of this and needs nothing but `node`.

Courses are multi-language: the app writes in whatever language the source material is
in, and the UI adapts direction (RTL) for Hebrew/Arabic content while the chrome itself
stays English.

## The four tabs

Every tab is a full screen, routed through one `setScreen()` call so nothing is
ever left showing underneath something else.

- **Home** — the upload/paste screen, or the learning path once a course is open.
- **Courses** — your library. The count shows both limits that exist: how many
  courses you may keep, and how many you may build this month.
- **Review** — what's due across *every* course, not just the open one, with the
  next review date when nothing is due and an early-practice run that deliberately
  leaves the schedule alone.
- **Account** — email, plan and trial status, this month's course/lesson quota as
  meters, learning stats, AI spend, password reset, sign out, delete everything.

Each screen's empty state carries the button that resolves it: no courses yet ends
in "Create a course", signed out ends in "Sign in".

## Spaced repetition

Completed lessons are scheduled for review using a simplified SM-2 algorithm based on
how well you did (accuracy → a 0-5 quality score → the next-review interval and ease
factor). When a lesson comes due, a banner appears on the learning path; "Review now"
starts a short session built from the quiz questions already generated for those
lessons — no new AI calls, so reviewing is free. Doing well pushes the lesson further
out; doing poorly resets it to a daily review.

## Architecture

The frontend is `index.html` (`<style>` + markup) plus `app.js` (vanilla JS, no
framework or build step), backed by a real Supabase project ("Mayan ai app",
`kgkdkkqoebnpahvetwzk`):

- **Auth** — Supabase Auth (email + password). No API key ever reaches the browser.
- **Database** — `courses`, `progress`, `subscriptions`, `ai_usage`, all RLS-enabled
  and scoped to `auth.uid()`, so one user can never see or touch another's rows. Courses
  and progress used to live in `localStorage`; the in-memory shapes the lesson engine,
  spaced repetition, and path rendering all read/write are unchanged — only the
  persistence layer underneath them moved.
- **`ai-proxy` Edge Function** — holds the real Anthropic key as a project secret,
  checks the caller has an active subscription or trial, then applies that account's
  tier before forwarding to Anthropic. Every limit is a server-side clamp, not a
  request the client makes: the model, the number of concepts a course gets, how much
  of the document is read, and the monthly course/lesson quota are all rewritten from
  the `subscriptions` row. A modified client can send anything it likes and still gets
  its own tier's answer.
- New signups get a 14-day trial automatically via a trigger on `auth.users`.

## Tiers

Held in `PLANS` in the Edge Function; `subscriptions.plan` picks the row, and an
unrecognised value falls back to `basic` rather than the largest tier.

| | courses/mo | lessons/course | doc read (course plan) | excerpt (per lesson) | model |
|---|---|---|---|---|---|
| trial | 1 (lifetime) | 10 | 5,000 | 2,400 | Haiku |
| basic | 3 | 10 | 5,000 | 2,400 | Haiku |
| pro | 5 | 12 | 40,000 | 8,000 | Sonnet |
| max | 8 | 15 | 120,000 | 16,000 | Opus plans, Sonnet writes |

## Cost model

One Haiku lesson ≈ $0.01; the higher tiers cost more per lesson because they run on
larger models and read more of the document. Lessons are cached after first
generation, so replaying or exiting and coming back is free. The Account tab shows
cumulative spend, call count, and this month's course/lesson quota, read from
`ai_usage` and `subscriptions` — the same rows `ai-proxy` meters against, so running
out is visible before it happens rather than only when a build is refused.

## What's not done yet

- **Payments.** `subscriptions.status` and the trial trigger exist and are enforced by
  `ai-proxy`, but there's no Stripe integration yet. `showUpgradePrompt()` lists the
  real tiers and what each one buys, and says plainly that checkout isn't live and
  what still works without it — it just can't take money. Once a Stripe account and
  price exist, this needs a checkout Edge Function and a webhook that updates `subscriptions` on
  `checkout.session.completed` / `customer.subscription.updated`/`deleted`.
- **`MAX_COURSES` is still a constant.** `PLAN_LIMITS` now carries `readChars` and
  `excerptChars`, and the planning digest and per-lesson excerpt are sized from the
  signed-in account's tier (`planReadChars()` / `excerptBudget()`), so Pro and Max
  genuinely read more of the document rather than buying a bigger model to read a
  Basic-sized slice. The library cap did not move: `MAX_COURSES = 8` is still hardcoded
  and is the largest tier's figure, so every plan is allowed to *keep* eight courses.
  The monthly build quota is enforced server-side and is unaffected, but this should
  read `PLAN_LIMITS[planKey].courses` before anyone is charged.
- **Tier verification against a live account.** `tests/tier-checks.js` covers the two
  things SQL can't: that a client sending 120,000 chars on Basic is clamped server-side,
  and that each tier really returns 10/12/15 concepts. Run it before enabling payments.
- **GitHub Pages.** Needs enabling once, in this repo's Settings → Pages, pointing at
  whichever branch should be live.
