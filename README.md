# AI Learning Path

Two files — `index.html` (markup + styles) and `app.js` — plus a `fonts/` folder,
with no build step and no framework. Sign in, name your course, upload a
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
quiz → a capstone challenge → summary → a memory check, where the learner writes the
idea in their own words and the model responds.

Every lesson is grounded in the source document: the relevant passage is retrieved via
TF-IDF and sent to the model with strict rules that facts and quiz questions must come
from that passage, not general knowledge.

## The lesson toolkit

The model never draws and never computes. It returns a structured spec — *this is a
right triangle with these side lengths*, *this quantity depends on that one*, *this word
breaks into these letters* — and the app renders it. That split is the whole design:
drawing is deterministic, costs no tokens and no second API call, and the arithmetic on
screen is the app's, so a lesson cannot teach a sum the model got wrong. A spec the app
cannot draw is dropped rather than shown broken.

**Eighteen figure types.** `flow` and `cycle` for sequences, one-way and repeating.
`compare` and `venn` for two things set against each other. `hierarchy` for a whole and
its parts. `timeline` for events. `table` and `grid` for structured facts, the grid able
to highlight cells. `bar`, `pie` and `plot` for magnitudes, proportions and one quantity
against another. `numberline` for thresholds and ranges. `shape` for geometry —
triangles, right triangles, squares, rectangles, circles and regular polygons, with
named sides, angles and vertices. `formula` for a rule with every symbol explained, and
`equation` for a derivation worked line by line. `gematria` for Hebrew letters as
numbers. And three the learner touches: `reveal` (cards uncovered by tapping), `slider`
(drag a value and watch what depends on it recompute), and any `shape` used as the
target of a hotspot question.

**Geometry is drawn from its own measurements.** Give `shape` the lengths 3, 4 and 5 and
it draws a 3-4-5 triangle: the right angle is a right angle on screen, marked with the
square that says so, and the longest side really is the longest. Lengths that cannot
close into a triangle are refused and the figure falls back to a generic one of the
right family, because a bent picture teaches worse than an unscaled one.

**Gematria is computed, not quoted.** The letter values are a fixed table, so the app
adds them up — in any of the four reckonings (הכרחי, גדול, סידורי, קטן) — and the
learner can type their own word into the same widget. The model supplies the words and
what the source says about them; it never supplies a total.

**The slider evaluates real formulas, safely.** `eval` on model output is a
code-execution hole, so the app parses a fixed grammar instead: numbers, variables,
`+ - * / % ^`, parentheses and a closed list of functions. Anything outside it fails,
and a slider whose formulas do not evaluate is not shown as a slider at all.

**Nine question types.** choice, true/false, ordering, categorizing, fill-the-blank,
matching, find-the-mistake — plus two new ones. `numeric` is a typed answer graded
against a tolerance, for anything the learner is meant to *work out*: four options give a
calculation away. `hotspot` is answered by tapping a part of a figure — *tap the
hypotenuse* — and any question type may carry a figure it asks about.

**The prompt writes itself.** `VISUALS` and `QUESTION_TYPES` in `app.js` are the single
source of truth: each entry holds what the model is shown (`use` and `spec`), what a spec
must survive to be drawn (`check`), and the renderer (`draw`). The catalogue in the
lesson prompt is generated from those entries, so the model can never be offered a type
the app cannot draw, and adding a type is one entry. The course plan also labels every
concept with a `kind` — geometry, quantity, process, timeline, comparison,
classification, definition, text — and the lesson prompt turns that label into a
concrete instruction about what tends to teach that kind well, instead of leaving the
model to choose from eighteen types unguided.

## Templates: the model chooses, the app builds

Above the eighteen primitives sits a library of ready-made figures. Rather than
specifying a diagram, the model names one and fills in the blanks:

```json
{ "template": "right-triangle", "params": { "a": 6, "b": 8, "unit": "cm" } }
```

and the app computes the hypotenuse, draws the triangle at those measurements, marks the
right angle and writes out `6² + 8² = 100, c = 10`. The division of labour is the point:
**the model knows what the lesson is about, the app knows what is true.** Every number
inside a template — the hypotenuse, the roots of a quadratic, the interest after ten
years, the rows of a truth table, the trace of a binary search — is computed here, in
JavaScript, from the parameters. The model is asked for the figures the source material
uses and explicitly not for the results.

Twenty-eight templates, shelved by subject:

| | |
|---|---|
| 🧮 **math** | right triangle · any triangle from three sides · rectangle · circle · regular polygon angles · solving ax+b=c step by step · quadratic with roots and vertex · straight line · fractions and shares · set operations · two-dice outcomes · percentage change |
| ⚛️ **physics** | Ohm's law as a slider · resistors in series or parallel · motion under acceleration · projectile arc · waves · pendulum period · half-life decay |
| 💻 **cs** | binary place values · a binary search traced over a real list · growth rates compared · truth tables |
| 🧠 **logic** | truth tables from an expression (and/or/not/xor/implies/iff, parsed and evaluated) · set operations |
| 📊 **data** | mean, median, range and standard deviation · histograms binned from raw values · the normal curve with its 68/95 bands · dice distributions |
| 💰 **finance** | compound vs simple interest, plotted and draggable · loan payments and total interest · percentage change |
| 🌌 **science** | half-life, shared with physics |

A template may return several figures — the triangle *and* the working, the curve *and*
the bands — which arrive as one grouped exhibit.

Three properties make the layer safe to grow. Templates compose the primitives, so a new
one needs no new renderer. Every parameter is coerced, defaulted and clamped, so junk
from the model becomes a sensible figure rather than an exception — a template that
genuinely cannot build (three lengths that will not close into a triangle) returns
nothing at all, and the lesson goes on without it. And a lesson stores the *expanded*
spec rather than the template call, so a cached lesson keeps working after its template
changes or is withdrawn.

Only the concept's own subject reaches the prompt. That is what keeps a library this
size affordable to offer — and it is why the model picks well: eight candidates that all
fit, not thirty that mostly don't. A concept whose domain is `other` — history, law,
literature, medicine — is offered no templates and gets exactly the format described
above.

`tests/lesson-visuals.js` covers all of it — the geometry, the evaluator's refusal to run
anything but arithmetic, the gematria tables, every template built from its defaults and
then from deliberate junk, the arithmetic each one computes, and the size of the prompt
itself. Like the pipeline tests it needs nothing but `node`.

One constraint worth knowing before adding to either catalogue: the lesson prompt and the
retrieved passage share one content block, and `ai-proxy` clamps that block to
`excerptChars + TEMPLATE_ALLOWANCE` — a prompt that overruns is truncated from the tail,
which is where its own JSON schema lives. The widest prompt (a maths concept, whose shelf
is the largest) is currently about 11,000 of the 12,000 characters allowed, and the test
fails if an addition leaves under 500 spare. Raising the ceiling means raising
`TEMPLATE_ALLOWANCE` in `policy.mjs` and redeploying the Edge Function.

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

On a phone the tabs are a bottom bar; from 900px up the same four buttons become a
left rail, so a wide window buys content width instead of stretching a phone layout
across it.

## Design system

Everything visual is defined once, in the token block at the top of `index.html`'s
`<style>`. Below that block nothing hard-codes a colour, a radius, a spacing value
or a duration — if a literal would appear twice, it becomes a token instead.

- **Colour.** Six hues, each with a job, and nothing decorative. Green is the
  product: progress, and the primary action. Blue explains — diagrams, links, the
  focus ring. Gold marks the one node on the path you are meant to tap next. Amber
  warns and marks a review as due. Red destroys or fails. Violet marks an analogy — a
  deliberate aside from the main explanation, not new fact. Every
  `--*-text` value clears 4.5:1 on the surface it is paired with, and every fill
  clears 4.5:1 under white label text.
- **Type.** One family, Nunito, at four weights. A second display face only put two
  rounded fonts in competition; size and weight carry the hierarchy instead. Sizes
  are a fixed rem scale — 12 / 14 / 16 / 17 / 18 / 22 / 28 / 32 — not the four dozen
  ad-hoc `em` values that came before, and the scale shifts down one step below 768px.
- **The font is self-hosted** from `fonts/`, not fetched from Google: the typography
  is part of the design, so it can't depend on a third party being reachable, and
  relative paths keep it working from `file://` too. One variable file per script,
  so an English course pulls 39KB and nothing else — the `unicode-range` on each
  face is what stops the browser fetching Cyrillic for a Latin page. A metric-matched
  `Nunito Fallback` (measured, not guessed: same width to within 1%, and Nunito's
  line box rather than Arial's shallower one) holds the layout still for the moment
  before it paints — with the font blocked outright, every measured box on the path
  screen still comes out to the same pixel. Nunito has no Hebrew or Arabic glyphs,
  so RTL course content falls to a system face; pairing a Hebrew companion with it
  is an open decision.
- **Space** is a 4-based scale with no values in between. **Radius** is five steps:
  6 for bars, 10 for inner boxes, 12 for buttons and inputs, 16 for cards, 20 for
  modals.
- **Depth means interactive.** The pressed-button bottom edge is the app's signature,
  so only things you can actually press get one. Static cards use a hairline border
  and the smallest shadow, which is what tells them apart from a button at a glance.
- **Motion** is 120ms for a press, 180ms for hover and colour, 240ms for enter and
  exit, and every one of them is switched off under `prefers-reduced-motion`.

Components exist once: one button (four emphasis levels, two sizes, a loading state),
one input, one chip, one card, one callout, one stat tile, one empty state, one
overlay. Where the same thing used to be styled three times — three stat tiles, five
chips, six callouts, three overlays — it is now one rule plus a modifier.

## Spaced repetition

Completed lessons are scheduled for review using a simplified SM-2 algorithm based on
how well you did (accuracy → a 0-5 quality score → the next-review interval and ease
factor). When a lesson comes due, a banner appears on the learning path; "Review now"
starts a short session built from the quiz questions already generated for those
lessons — no new AI calls, so reviewing is free. Doing well pushes the lesson further
out; doing poorly resets it to a daily review.

## Architecture

The frontend is `index.html` (`<style>` + markup) plus `app.js` (vanilla JS, no
framework or build step) and `fonts/`, backed by a real Supabase project ("Mayan ai app",
`kgkdkkqoebnpahvetwzk`):

- **Auth** — Supabase Auth (email + password). No API key ever reaches the browser.
- **Database** — `courses`, `progress`, `subscriptions`, `ai_usage`, `user_stats`, all
  RLS-enabled and scoped to `auth.uid()`, so one user can never see or touch another's
  rows. Courses and progress used to live in `localStorage`; the in-memory shapes the
  lesson engine, spaced repetition, and path rendering all read/write are unchanged —
  only the persistence layer underneath them moved.
- **The day streak** lives in `user_stats`, so it follows the account rather than the
  browser. `localStorage` is kept as a per-account cache (`streak_data:<user-id>`): it
  paints the HUD before the row arrives and keeps a streak earned offline. On sign-in
  the two are merged by whichever saw you more recently, higher count breaking a tie —
  which is also how an existing local streak survives the move to the server.
- **`ai-proxy` Edge Function** — holds the real Anthropic key as a project secret,
  checks the caller has an active subscription or trial, then applies that account's
  tier before forwarding to Anthropic. Every limit is a server-side clamp, not a
  request the client makes: the model, the number of concepts a course gets, how much
  of the document is read, and the monthly course/lesson quota are all rewritten from
  the `subscriptions` row. A modified client can send anything it likes and still gets
  its own tier's answer. Its source lives in `supabase/functions/ai-proxy` — the rules
  in `policy.mjs`, which the tests import directly, and the I/O in `index.ts`.
- New signups get a 14-day trial automatically via a trigger on `auth.users`.

## Tiers

Held in `PLANS` in the Edge Function; `subscriptions.plan` picks the row, and an
unrecognised value falls back to `basic` rather than the largest tier.

| | courses/mo | lessons/course | doc read (course plan) | excerpt (per lesson) | shared context (cached) | model |
|---|---|---|---|---|---|---|
| trial | 1 (lifetime) | 10 | 5,000 | 2,400 | — | Haiku |
| basic | 3 | 10 | 5,000 | 2,400 | — | Haiku |
| pro | 5 | 12 | 40,000 | 8,000 | 24,000 | Sonnet |
| max | 8 | 15 | 120,000 | 16,000 | 48,000 | Opus plans, Sonnet writes |

**Shared context** is a digest of the whole document sent ahead of every lesson in a
course, byte-identical each time so the API caches it: the first lesson pays a write
premium of 1.25x, the rest read it back at about a tenth of input price. It is what
lets a lesson see the document it came from rather than only its own retrieved
passage.

It is blank on the Haiku tiers on purpose. Haiku will not cache a prefix under 4,096
tokens, and below that the API accepts the request, caches nothing, and charges the
premium anyway. Turning it on there means first raising the budget past ~16,000
characters, which costs real money per course — a decision worth making against the
hit rate the paid tiers are about to start reporting rather than against a guess.

## Cost model

One Haiku lesson ≈ $0.01; the higher tiers cost more per lesson because they run on
larger models and read more of the document. Lessons are cached after first
generation, so replaying or exiting and coming back is free. The Account tab shows
cumulative spend, call count, and this month's course/lesson quota, read from
`ai_usage` and `subscriptions` — the same rows `ai-proxy` meters against, so running
out is visible before it happens rather than only when a build is refused.

## Addressing a long PDF by page

*Reading the PDF* above is what the app does with an upload: read every page,
condense it into a digest, plan a course from that. `tools/pdf_index` is an
offline Python tool for the other question — not "what is this book about"
but "what does page 43 say, and which chapter is it in".

It strips the running headers, page numbers and contents pages, detects the
chapters (Hebrew and English), and prints an index with real page ranges,
plus only the passages a given question needs.

```sh
pip install -r tools/requirements.txt
python3 -m tools.pdf_index index book.pdf
python3 -m tools.pdf_index context book.pdf --query "מס רכישה על דירה שנייה"
```

The digest samples a whole document for one planning call; this answers one
question at a time and cites the chapter and pages it answered from. It is a
command line, separate from the app: `tools/README.md` covers how it decides
what a heading is, and what wiring it into `ai-proxy` would take.

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
