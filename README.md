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

A warm-up from an earlier lesson → hook → prediction → concept cards, with the first
questions of the quiz set among them → worked example → guided practice → the rest of
the quiz → a capstone challenge → summary → a memory check, where the learner writes
the idea in their own words and the model responds → and, if anything went wrong along
the way, a second look at it.

Every lesson is grounded in the source document: the relevant passage is retrieved via
TF-IDF and sent to the model with strict rules that facts and quiz questions must come
from that passage, not general knowledge.

**The lesson opens on something you already learned.** One question, drawn from the
quiz of an earlier lesson in the same course — the one furthest past its review date,
because the material closest to being forgotten is the material worth a question. It
costs nothing: that question was written, paid for and cached when that lesson was
built. It is not marked and it cannot lower a score. Getting it wrong pulls that lesson's review forward to tomorrow but leaves its SM-2 ease alone —
one question under no pressure is evidence that something is shaky, not a review
session, and it should not be able to undo weeks of correctly earned interval. The
course could always test what you learned last week; it kept it behind a banner and a
tab of its own, which is a place you go when you have decided to revise. Almost nobody
decides to revise.

**The cards are broken up by the questions about them.** Three or four explanation
cards in a row was the one place a lesson still read like a page rather than something
you do: Continue, Continue, Continue, and only then any question about whether it
landed. Half the quiz, rounded down, now comes up among the cards — one question after
each of the first cards, never after the last one — and the rest stays where it was.
The closing run has to remain long enough to be a quiz: the point is to break up the
cards, not to abolish the part that tests the lesson as a whole. `buildLessonSteps()`
is a pure function of the lesson for exactly this reason, and `tests/lesson-flow.js`
pins the order it produces.

**A wrong answer is answered, not scored.** Distractors are written as mistakes a real
learner makes, so the model is now asked to say what each one means: `whyWrong` carries
one line per option, and the learner is shown the line for the option they actually
picked. "You added the two legs — the theorem adds their squares" is a different thing
from "Not quite". That line is also the whole of the retry banner, because at that
moment naming the mistake is the only help that does not hand over the answer — and it
travels with its option when the list is reshuffled for a second look, since a reason
left behind explains whichever option landed in that slot.

The banner used to fall back to whatever the grader had written when a question had no
hint, which for a numeric or an ordering question is the answer itself, printed above a
*Try again* button. It doesn't any more.

**There are no hearts.** There were five in the topbar, and they were the wrong idea in
this app: a course built from your own document is not a game you can lose, and a row
of hearts draining on a first encounter with an idea teaches nothing except that
guessing is expensive. What a mistake costs is a second attempt at the question, an
explanation of what went wrong, and one more look at it before the lesson ends. The
score and the XP stay — they are earned at the end, not deducted along the way.

**A wrong answer comes back before the lesson ends.** The old ending was: get it wrong,
read why, walk on, finish, see 60%. The number was the only consequence, and a number is
not a second chance to understand. Now up to three missed questions are asked once more
before the complete screen, options reordered so the second try tests the idea rather
than the memory of which button turned green. They are explicitly unmarked — the score
was earned already. It is a chance to get it right, not a resit.

**The lesson knows how you have been doing.** Every lesson in a course used to be
pitched identically no matter what happened in the previous nine: someone averaging
100% got the same gentleness as someone averaging 45%. One line in the prompt now says
which of those is true, and asks for harder questions or smaller steps accordingly. It
speaks only above 90% or below 60% — in the middle "keep doing what you are doing" is
not an instruction — and only once two lessons are done, because one score is a mood
rather than a level. No extra call, no second model, one sentence in a prompt that was
being sent anyway.

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

Thirty-five templates, shelved by subject:

| | |
|---|---|
| 🧮 **math** | right triangle · any triangle from three sides · rectangle · circle · regular polygon angles · solving ax+b=c step by step · quadratic with roots and vertex · straight line · fractions and shares · set operations · two-dice outcomes · percentage change |
| ⚛️ **physics** | Ohm's law as a slider · resistors in series or parallel · motion under acceleration · projectile arc · waves · pendulum period · half-life decay |
| 💻 **cs** | binary place values · a binary search traced over a real list · growth rates compared · truth tables |
| 🧠 **logic** | truth tables from an expression (and/or/not/xor/implies/iff, parsed and evaluated) · set operations |
| 📊 **data** | mean, median, range and standard deviation · histograms binned from raw values · the normal curve with its 68/95 bands · dice distributions |
| 💰 **finance** | compound vs simple interest, plotted and draggable · loan payments and total interest · percentage change |
| 🌱 **science** | Punnett square (genotype and phenotype ratios from a cross) · pH from H⁺ concentration · exponential population growth · energy transfer up a food chain (the 10% rule) · density as a slider · half-life, shared with physics |
| 📚 **other** | events sorted into their true chronological order with the span and gaps computed · several figures ranked and scaled correctly · mean/median/range/spread, shared with data · percentage change, shared with finance and math |

A template may return several figures — the triangle *and* the working, the curve *and*
the bands — which arrive as one grouped exhibit.

**Science was one template deep until it wasn't.** Every other subject a real upload is
likely to be — a chapter of biology, a page of chemistry, an ecology unit — landed in the
`science` domain and got `half-life`, borrowed from physics, and nothing else: the
primitives were still there, but nothing computed for them the way `quadratic` computes
for algebra. `punnett-square` runs an actual cross (two parents in, the 2×2 grid and the
genotype/phenotype ratio out — not stated, tallied from the four cells) and refuses a
cross between two different genes rather than guess at one. `ph-scale` takes a hydrogen-ion
concentration and computes the pH itself, `-log10(c)`, and where it falls on the acid-base
line. `population-growth` and `energy-pyramid` are exponentials computed the same way
`half-life` and `compound-interest` already are, just growing instead of decaying, and
losing 90% a level instead of gaining a rate. `density` is a slider in the same family as
`ohms-law` — drag the volume, watch mass ÷ volume recompute live.

**`other` went from zero templates to four, on purpose and without a subject.**
It used to be offered nothing at all — the one deliberate exception to "every domain
gets a shelf" — and the reason given was that a finite set of templates cannot cover
an unbounded domain: there is no closed vocabulary for "history and law and literature
and medicine and business" the way there is for algebra. That reasoning was right about
narrow, subject-shaped templates and wrong about domain-general ones. A body count, a
vote share, a print run, a population, a box-office gross: `other` is full of concepts
that turn on a handful of numbers, and the arithmetic that describes them doesn't know
or care which subject they came from. `chronology` takes a list of dated events — in
whatever order the model happened to write them — and returns them in their true
chronological order, with the span and the smallest and largest gaps computed, not
estimated; a course would otherwise trust the model to both order and space events
correctly, which is exactly the kind of arithmetic this whole layer exists to take off
its hands. `ranked-comparison` takes a list of labelled figures and returns them sorted
largest to smallest, drawn to true relative scale — deadliest battles, longest-reigning
monarchs, best-selling novels, whatever the concept needs ranked. `summary-stats` and
`percent-change` were already exactly this general underneath their finance- and
data-flavoured wording, so they simply gained `other` as a third and fourth domain
rather than being rewritten.

Three properties make the layer safe to grow. Templates compose the primitives, so a new
one needs no new renderer. Every parameter is coerced, defaulted and clamped, so junk
from the model becomes a sensible figure rather than an exception — a template that
genuinely cannot build (three lengths that will not close into a triangle) returns
nothing at all, and the lesson goes on without it. And a lesson stores the *expanded*
spec rather than the template call, so a cached lesson keeps working after its template
changes or is withdrawn.

Only the concept's own subject reaches the prompt. That is what keeps a library this
size affordable to offer — and it is why the model picks well: a dozen candidates that
all fit, not thirty-five that mostly don't. A concept whose domain is `other` — history,
law, literature, medicine, business, philosophy — reaches only the four templates above
that assume no subject; the thirty-one that assume algebra, circuits or a genetic cross
stay off its shelf exactly as they always did.

`tests/lesson-visuals.js` covers all of it — the geometry, the evaluator's refusal to run
anything but arithmetic, the gematria tables, every template built from its defaults and
then from deliberate junk, the arithmetic each one computes, and the size of the prompt
itself. Like the pipeline tests it needs nothing but `node`.

One constraint worth knowing before adding to either catalogue: the lesson prompt and the
retrieved passage share one content block, and `ai-proxy` clamps that block to
`excerptChars + TEMPLATE_ALLOWANCE` — a prompt that overruns is truncated from the tail,
which is where its own JSON schema lives. The widest prompt (a maths concept, whose shelf
is the largest) is currently about 11,600 of the 13,000 characters allowed, and the test
fails if an addition leaves under 500 spare. Raising the ceiling means raising
`TEMPLATE_ALLOWANCE` in `policy.mjs` and redeploying the Edge Function — which is what
was done when the calibration line was added and the margin fell to 350. It is a ceiling,
not a payload: nothing is sent because the room exists.

The prompt-size test measures the widest prompt *with* that line in it, and with the
longer of its two wordings, because that is the prompt a real learner gets.

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
course built from them lists the chapters instead of teaching them.

The digest is built from the document's **outline**. A document prepared by
`tools/pdf_prep` arrives with one already settled, page numbers and all (see *Preparing a
PDF* below). Otherwise the headings are recovered from the stored text — by keyword
(`Chapter 4`, `פרק ב`, `Part One`), by decimal numbering (`3.2`), by Markdown marker
(`## …`), and by shape — and turned into a tree, each part carrying the share of the
document it occupies. That tree is printed whole, and the body budget is then spent *per part*: one
passage from every part before any part gets a second, then depth in proportion to size,
then whatever is left to the parts still unquoted. Every passage is labelled with the part
it came from, so the planner is choosing concepts against the shape of the book rather
than against whichever paragraphs happened to score well.

What that buys, measured on synthetic books at Basic's 5,000-character budget: on a
lopsided one — a sixty-passage chapter followed by nine short ones — the old position-based
sampler quoted 9 of 10 chapters and this quotes all 10; on an eighty-chapter book, where
no sampler can quote more than a fraction, it names all 80 rather than 50, because a
chapter the planner never hears of cannot be taught and a line of outline is the cheapest
way to hear of one. A document with no headings — pasted text, a paper that is one wall of
prose — falls back to the old sampling by position, which is all such a document supports.

The digest is also a prompt-cache prefix, so it must come out identical every time it is
rebuilt from the same stored text. That is why the outline is derived from the text rather
than from the font sizes the extractor saw: `source_text` is a string in the database, and
a structure that could not be rebuilt from it would cost every course full price on its
second lesson.

**Retrieval.** TF-IDF over the stored document, per lesson, with the budget from the
account's tier — and now narrowed by the plan. Each concept records the outline heading it
came from, and retrieval searches that section first, falling back to the whole document
when the heading does not match or the section is too thin. Told the chapter, retrieval no
longer has to distinguish the chapter that *teaches* a term from the four that mention it.

`tests/pdf-pipeline.js` covers all of this and needs nothing but `node`.

Courses are multi-language: the app writes in whatever language the source material is
in, and the UI adapts direction (RTL) for Hebrew/Arabic content while the chrome itself
stays English.

## Worksheet mode

The default course-planning prompt asks the model to synthesize 10-20 *topics* from the
material, in a logical teaching order — the right question for a chapter, the wrong one
for a worksheet. A page of homework has no topics to extract, it has exercises, and
asking a topic-synthesizer to plan it produces exactly what a topic-synthesizer should
produce: some exercises merged into one "concept", others dropped, the rest reordered by
what reads as pedagogically sensible rather than kept in the order they were assigned.

The upload screen's **"This is a worksheet"** toggle switches to a different prompt
instead of asking the same one to behave differently. `buildWorksheetPlanPrompt()`
tells the model to list every exercise, in the order it appears, none merged, none
skipped, none invented — and if the material numbers them, to keep that numbering in the
name. There is no "10-20" in it, on purpose: the count is whatever the worksheet actually
contains. The server does not overwrite that count to the tier's fixed number the way it
does for a normal course (`shouldFixCourseSize` in `policy.mjs` — the one place `task`
changes what a call is allowed to do rather than just what it is billed as). What still
bounds the cost is the same monthly lesson quota every course draws from: a 20-exercise
worksheet just spends more of that one shared budget, the way two smaller courses would.

Past that one prompt, nothing else changes. An exercise becomes a `concept` exactly like
a topic does — `description` holds the exercise itself rather than a summary of it, so
the lesson written from it teaches that literal problem — and flows through the same
lesson generation, grounding, spaced repetition and path rendering as any other course.

The suitability gate is the other thing that has to change, not just the prompt. A terse
worksheet ("1. Solve for x: 2x + 5 = 13") is nearly all digits and symbols with no real
sentence in it, and `assessMaterial()`'s prose-shape checks — mostly-numbers, not-prose —
exist precisely to catch text shaped like that. Refusing a worksheet for not reading like
a chapter would defeat the mode before it starts, so this toggle runs
`assessWorksheetMaterial()` instead: the same floor against an empty paste and the same
guard against a repeated line, without the checks that assume narrative prose.

`tests/onboarding.js` covers both — the prompt (no count, the no-skip/no-merge/no-invent
rules, the same JSON shape and language rule the topic prompt ends in) and the gate (a
worksheet that `assessMaterial` would refuse, refused by neither `assessWorksheetMaterial`
nor whatever floor keeps out an empty or repeated paste).

## The four tabs

Every tab is a full screen, routed through one `setScreen()` call so nothing is
ever left showing underneath something else.

- **Home** — the upload/paste screen, or the learning path once a course is open.
  Above the upload area sits a banner into a hand-written demo lesson — the real
  step engine, a real quiz, zero AI cost and nothing saved — so a first-time
  visitor sees what a lesson actually feels like before spending a minute on
  an upload.
- **Courses** — your library. The count shows both limits that exist: how many
  courses you may keep, and how many you may build this month.
- **Review** — what's due across *every* course, not just the open one, with the
  next review date when nothing is due and an early-practice run that deliberately
  leaves the schedule alone.
- **Account** — email, plan and trial status, this month's course/lesson quota as
  meters, learning stats, AI spend, the subjects picked during the first run,
  the theme, password reset, sign out, delete everything. Every settings row that
  acts on tap carries a trailing chevron; the one destructive row doesn't, so
  danger reads differently from routine at a glance.

Each screen's empty state carries the button that resolves it: no courses yet ends
in "Create a course", signed out ends in "Sign in".

On a phone the tabs are a bottom bar; from 900px up the same four buttons become a
left rail, so a wide window buys content width instead of stretching a phone layout
across it.

## The first run

What a new account used to get, one second after signing up, was the upload box: a
file picker, a paste tab, and no answer to the only question anyone actually has at
that moment — *what is this going to do with my document, and why should I hand one
over*. The answer costs six screens and is said once.

**What the app does**, one promise per screen rather than a feature list read top to
bottom in one glance: it teaches your material and not a syllabus, then its lessons
are done rather than read, then it brings things back before you forget them. Each
gets the same weight a lesson card gets and the same Continue button the questions
after it already use — `ONBOARDING_VALUES` is the list, `VALUE_STEPS` turns it into
one step per entry, and only the first carries the overall pitch as a kicker line
above it, since it is the promise that needs the least room. Then **what are you
learning for** — an exam, work, curiosity, teaching someone else — and **what are
you interested in**, a grid of seven subjects, as many as you like.

The last screen is the point of the other three. Instead of an empty upload box it
offers **a course to start on**: a short piece of real material in a subject just
picked, which becomes a course through exactly the same pipeline an upload goes
through — planned, written, cached, counted against the month's quota like any other,
and theirs to rename or delete. Six of them ship in `app.js`, one per interest, and
`tests/onboarding.js` runs every one through `assessMaterial()`, the same gate an
upload passes: a starter the app refuses would greet a new account with "this doesn't
read like study material" about a document the app wrote itself. "I'd rather upload my
own material" is on the same screen, and Skip is in the top bar throughout.

**Or any subject at all.** Six starters cannot cover what someone actually wants, so
the same screen takes a typed subject — *Roman roads*, *options trading*, *sourdough* —
and writes the material for it: 450-600 words of plain prose from one cheap call, which
then goes through the identical pipeline, suitability gate included. Six hundred words
rather than the nine hundred that would read better, because the Edge Function caps
anything below the course threshold at 1000 output tokens, and what does arrive is
trimmed back to its last full stop — material that stops mid-sentence is material the
lessons would then be built from. A typed subject and a chosen card are alternatives:
typing clears the card, and the card clears the box.

**The example lesson is offered from inside it.** The first screen claims lessons are
something you do rather than read; the demo lesson (see *The four tabs*) is that claim,
checkable in two minutes at no cost. Taking it up closes the intro without finishing it,
runs the demo through the real step engine, and reopens the intro on the step it left —
so the proof does not cost the setup.

Both answers are stored, shown back on the Account screen under *What you're interested
in*, and editable there — the same four screens reopen, and a replay changes the answers
without rewriting the date the account finished its first run. An answer nobody can see
or change afterwards is a question that should not have been asked.

**Once** is the part with the failure modes, so it is where the tests are. The flag
lives in `user_stats.onboarding` — on the account, not the browser — with localStorage
in front of it as a cache, which is what stops the intro flashing up over a screen it
is about to hand back on a slow connection. An account that already has courses is not
a new account: it gets the flag written silently rather than a tour of an app it has
been using for a month. A read that fails, including the column not being deployed
yet, leaves the cache in charge rather than replaying the intro at someone who has
already been through it — so the client and its migration can be deployed in either
order.

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
- **Dark theme** is the same token names with a second set of values, switched by
  either `prefers-color-scheme` or an explicit choice in Account → Appearance
  (stored in `localStorage`, cycling system → light → dark). An inline script at
  the very top of `<head>` applies a stored override before the stylesheet ever
  paints, so a returning learner never sees a flash of the wrong theme. The five
  solid "fill" hues (`--brand`, `--info`, `--warn`, `--danger`, `--gold`,
  `--accent`) don't change between themes — they're paired with white button/toast
  text either way — only the neutrals and the `-strong`/`-text` foreground variants
  get dark-mode values.
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

The reasoning behind these choices, compared against sites held up as UI/UX best and
worst practice, is in [`docs/ui-ux-research.md`](docs/ui-ux-research.md) — including a
checklist to run before merging a new UI feature.

## Spaced repetition

Completed lessons are scheduled for review using a simplified SM-2 algorithm based on
how well you did (accuracy → a 0-5 quality score → the next-review interval and ease
factor). When a lesson comes due, a banner appears on the learning path; "Review now"
starts a short session built from the quiz questions already generated for those
lessons — no new AI calls, so reviewing is free. Doing well pushes the lesson further
out; doing poorly resets it to a daily review.

The schedule also reaches into the lessons themselves. Each lesson opens with one
question from the course's most overdue completed lesson (see *What a lesson contains*),
which is retrieval practice for the learner who never opens the Review tab. A miss there
pulls that lesson's `dueAt` forward to tomorrow and touches nothing else — no ease, no
rep count. A single question is not a review session and must not be scored like one.

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
- **The first run** lives in the same row, as `user_stats.onboarding` — whether the
  intro has been shown and the answers given during it (see *The first run* above),
  cached per account in `localStorage` for the same reason the streak is.
- **`ai-proxy` Edge Function** — holds the real Anthropic key as a project secret,
  checks the caller has an active subscription or trial, then applies that account's
  tier before forwarding to Anthropic. Every limit is a server-side clamp, not a
  request the client makes: the model, the number of concepts a course gets, how much
  of the document is read, and the monthly course/lesson quota are all rewritten from
  the `subscriptions` row. A modified client can send anything it likes and still gets
  its own tier's answer. Its source lives in `supabase/functions/ai-proxy` — the rules
  in `policy.mjs`, which the tests import directly, and the I/O in `index.ts`. It
  streams: the model's answer is forwarded to the browser as it is written rather than
  held until it is finished (see *Why the bigger plans felt slower* below).
- New signups get a 14-day trial automatically via a trigger on `auth.users`.

## Why the bigger plans felt slower, and what was done about it

Buying a larger plan used to make the app *feel* worse. Max reads 120,000 characters of
the document and plans the course on Opus; a lesson is up to 6,000 output tokens. Output
tokens are produced one at a time, so that is minutes of wall clock, and no amount of
clamping the input removes it — a bigger plan buys a bigger model reading more, which is
strictly more work. Basic finished sooner because it was doing less.

That much is the deal. What was wrong was everything around it.

**The call was held closed until it finished.** One request, one response, nothing on
screen but a spinner for the whole of it — and a spinner that runs for two minutes is
indistinguishable from a hung tab. Past a certain length it was also the request most
likely to hit a gateway's idle timeout and come back as nothing at all.

Now `ai-proxy` streams. It passes Anthropic's SSE straight through to the browser and
reads the meter on the way past — the usage is picked out of `message_start` and
`message_delta` as they go by, and written when the stream ends, so a stream that dies
halfway is still billed for the tokens it burned. The client shows what that buys:
which part of the lesson is being written right now, read off the JSON while it is still
half-written, and a bar whose fraction is a count of parts that have genuinely arrived
rather than a timer dressed up as progress. Building a course counts concepts as they
land — *Found 7 concepts* — against the number that tier returns.

The client asks for streaming rather than getting whichever way the function was last
deployed, and decides how to read the answer by what came back, not by what it asked
for. Old client with the new function, new client with the old one: both work, so the
two can be deployed in either order.

**Nothing was written until the learner asked for it.** This is the one that actually
removes the wait. A lesson takes five to ten minutes to work through and one to two to
generate, and those numbers had never been allowed to overlap: the learner finished,
pressed *Next lesson*, and only then did anything start. A third of the way through the
current lesson, the next one now starts being written in the background — by the time
the button is pressed it is already in `progress`, which is where a replayed lesson
comes from, and it opens instantly. If they get there first, the open waits on the
generation already in flight rather than starting a second one.

It also repairs the cache it rides on. The shared course context is cached with a
five-minute TTL, and a learner takes longer than that per lesson, so a lesson requested
*after* the previous one finished always missed and paid the write premium again.
Requested while the previous lesson is still on screen, it hits — which makes the next
lesson both faster and about a tenth of the input price. The TTL was the right one all
along; nothing was arriving inside it.

What a prefetch must never do is spend a lesson the learner would not have. It runs for
the very next concept only, once, never for one already in hand, never offline or signed
out, and never when fewer than two lessons remain in the month — the last one belongs to
whatever they choose to open, not to a guess about what that will be. It reports its
failures to the console rather than onto a screen showing something else, and a course
switched away from mid-flight discards what lands, because writing it into the new
course's `progress` would file one course's lesson 4 as another's.

**Lesson 1 is written while the course is still being planned.** Planning and lesson
writing used to run strictly one after the other, and both are slow for the same reason:
thousands of output tokens, generated one at a time. Caching does nothing for that — it
shortens the input side, which was never what anyone was waiting for. But the two calls
do not depend on each other end to end: writing lesson 1 needs *one* concept, not the
whole list. `firstPlannedConcept()` watches the plan stream and hands the first finished
concept to `prefetchLesson(0)`, so the wait becomes the longer of the two rather than
their sum.

It gates on `importance` rather than `name` because the plan writes a concept's fields in
a fixed order and `importance` is the last one the lesson prompt reads — seeing it means
`domain` and `kind` arrived too, so the lesson starts with its template shelf rather than
without it. It also needs the plan's `language`, reported before `concepts` in the same
schema: a lesson started without it would be written in whatever `courseLanguage()`
guessed from an empty concept list, which is English, for a course whose material is
Hebrew.

This is also why `prefetchLesson` identifies a course by its source text rather than its
id. The two agree everywhere except here — lesson 1 starts before the course has been
saved, so there is no id to capture, and comparing one would discard a lesson that had
been written perfectly well. The source text is pointed at the new document when the
build commits to it and put back if the build never produces a course, which is exactly
the question the guard is asking.

**The lesson opens before it is finished.** Prefetching only helps a lesson somebody
could see coming — the next one in a course. The first lesson of a new course has nothing
running ahead of it, so it was the one place a learner still watched a spinner for the
whole generation. Now the opening goes on screen as soon as it has streamed in: the
proxy already streams, and `extractJSON` already closes off a truncated object, so a
half-written lesson parses into whatever finished arriving. The learner reads the hook,
makes a prediction and touches the explore widget — a minute or so — while the rest is
still being written behind them.

What makes this safe rather than merely fast is that **the opening is an exact prefix of
the finished lesson**. `openingLesson()` keeps the hook, the prediction and the explore
step and drops everything after them — cards included, and especially cards. The lesson
interleaves part of the quiz between the cards, and `interleavedCount()` cannot know how
many until the whole quiz has arrived; a card rendered early would have questions spliced
in around it once it did. Holding the cards back means every step the learner has already
walked through is exactly the step the finished lesson would have given them, so
`applyFinishedLesson()` swaps the real lesson in underneath at whatever step they reached,
carrying their answers across and redrawing nothing. `tests/lesson-flow.js` checks that
prefix property across eighty lesson shapes rather than trusting the argument.

A learner who outruns the model lands on a `writing` step, which clears itself. It should
be rare: the opening takes about a minute to work through and the rest of a lesson takes
one to two to write. Nothing partial is ever saved to `progress` — a half-written lesson
filed as a lesson would come back from cache with everything after `explore` missing for
good — and the XP total and step count stay hidden until the quiz has landed, because
both are unknowable before then and a number that changes under the learner is worse than
no number.

`tests/lesson-flow.js` covers the guards, the SSE scanner on every chunk boundary, the
progress readers, and the prefix property above; `tests/ai-proxy-policy.mjs` covers the
server half of the stream.

## Tiers

Held in `PLANS` in the Edge Function; `subscriptions.plan` picks the row, and an
unrecognised value falls back to `basic` rather than the largest tier.

| | courses/mo | lessons/course | doc read (course plan) | excerpt (per lesson) | shared context (cached) | model |
|---|---|---|---|---|---|---|
| trial | 1 (lifetime) | 10 | 5,000 | 2,400 | — | Haiku |
| basic | 3 | 10 | 5,000 | 2,400 | — | Haiku |
| pro | 5 | 12 | 40,000 | 8,000 | 24,000 | Haiku plans, Sonnet writes |
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

On Pro and Max, the shared context is one of three cached blocks sent ahead of the
concept itself, least specific first. `lessonToolkitGlobal()` — Principles, every
VISUALS spec, every QUESTION_TYPES spec — is identical for every lesson this server
ever writes, for any concept, any course, any account, so it caches at the widest
scope the API allows: the first lesson generated after a deploy pays to write it,
every lesson after that reads it back. The shared context above is next. The
concept's own domain gets a third block — `lessonDomainToolkit()`, the template
shelf for that subject — which repeats across a course's concepts that share a
domain but not across courses, so it earns a breakpoint of its own rather than
forcing a rewrite of the shared-context cache every time a course's concepts change
subject. Only the concept-specific prompt (`buildLessonPrompt(concept, excerpt,
false)`) is never cached. Trial and Basic skip all of this and send the one flat
prompt they always did — none of these three pieces clears Haiku's cache minimum on
its own, so there is nothing to gain by splitting them there. `tests/lesson-visuals.js`
checks the split against the standalone prompt content-for-content (nothing dropped,
nothing duplicated) and against each block's own ceiling in `policy.mjs`
(`GLOBAL_TOOLKIT_ALLOWANCE`, `DOMAIN_TOOLKIT_ALLOWANCE`); `tests/ai-proxy-policy.mjs`
covers the server side of the same split.

**This is the one change here that is not safe to deploy in either order**, which is
why `LESSON_CACHE_SPLIT` in `app.js` exists and currently reads `false`. An `ai-proxy`
from before `prepareLessonBlocks` treats any lesson call with two or more blocks as
`[context, ...prompt]` — block 0 clamped to `contextChars`, everything after it sharing
one `excerptChars + TEMPLATE_ALLOWANCE` budget. Send that server four blocks and the
course digest alone exhausts the shared budget: the domain shelf and the lesson prompt
are both clamped to zero characters, and the model gets a toolkit and a truncated digest
with no instructions and no schema. The lesson does not degrade, it fails to build. With
the flag off the client sends the same two blocks every deployed version has always
handled, so the client can be merged whenever. Turn it on in the change that deploys the
function, or any change after it — never before.

The plan picker (`showUpgradePrompt`) renders these as cards, not a plain list: one
badge for "Your plan", one for "Most popular" (Pro — real model quality without
Max's price), a checkmark per feature. There's no price on them because checkout
isn't wired up yet; the redesign is about reading the difference between tiers at a
glance, not about selling one.

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

## Preparing a PDF for a model to read

`tools/pdf_prep` is the third answer to the same raw material. Not "what is
this book about" and not "what does page 43 say", but *turn this PDF into
something a model can work from at all*:

```sh
python3 -m tools.pdf_prep book.pdf -o out/
```

It reads the pages with PyMuPDF — OCR'ing any that turn out to be scans — puts
the lines in reading order (columns found, right-to-left runs fused back into
lines), lifts out the tables and figures, drops the running headers and page
numbers, joins the lines back into paragraphs, and writes two files:

- **`out/document.md`** — the text, and the only copy of it: headings,
  paragraphs, lists, GFM tables, formulas, figure references, and `<!-- page N
  -->` markers so a model can still cite a page.
- **`out/document.json`** — the map: outline with page ranges, chunks sized for
  one call with their TF-IDF terms, tables as data, figures, footnotes, and for
  each of them the character range of the Markdown it occupies.

Nothing is stored twice, so a consumer reads the JSON, decides what matters,
and slices those ranges out of the Markdown. No model is involved in any of it,
which is the point: it costs nothing, it is the same twice, and it cannot
invent a sentence the document does not contain.

**Feeding it to the app.** `--bundle` writes both outputs as one file, and the
upload box takes it:

```sh
python3 -m tools.pdf_prep book.pdf -o out/ --bundle   # → out/document.bundle.json
```

The course is then planned from that outline — real headings, real page numbers
— rather than from one the browser re-derived out of the text, and the outline
is stored on the course in `courses.structure`. It is also the only way a
**scanned** PDF gets in at all: the browser's reader has no OCR, so a scan
uploaded directly still gives it nothing.

The handoff is a file rather than a call on purpose. `ai-proxy` is a Deno Edge
Function and cannot run Python, so a live call would mean deploying a Python
service and a queue to reach it; the file needs neither, and is the same
artifact that service would produce if it is ever built. Run the migration in
`supabase/migrations/` to keep the outline — without it the app warns once in
the console and saves the course anyway, deriving structure from the text as
before. `tools/pdf_prep/README.md` has the details and the limits.

## What's not done yet

- **Payments.** `subscriptions.status` and the trial trigger exist and are enforced by
  `ai-proxy`, but there's no Stripe integration yet. `showUpgradePrompt()` lists the
  real tiers and what each one buys, and says plainly that checkout isn't live and
  what still works without it — it just can't take money. Once a Stripe account and
  price exist, this needs a checkout Edge Function and a webhook that updates `subscriptions` on
  `checkout.session.completed` / `customer.subscription.updated`/`deleted`.
  Until then, one account can try the tiers directly: the plan dialog offers debug
  buttons that call `debug_set_plan(new_plan)`, a Postgres function
  (`supabase/migrations/20260813150000_debug_set_plan.sql`) that writes `subscriptions`
  for real — quotas and models change — but checks the *caller's own* email against
  `auth.users` inside the function, hardcoded, before it will touch a row. A client
  can ask it for any plan; it cannot ask on someone else's behalf. `app.js`'s
  `canDebugPlan()` only decides whether the button is drawn, which is why the address
  is duplicated in both places — `tests/pdf-pipeline.js` pins that the two agree.
- **Tier verification against a live account.** `tests/tier-checks.js` covers the two
  things SQL can't: that a client sending 120,000 chars on Basic is clamped server-side,
  and that each tier really returns 10/12/15 concepts. Run it before enabling payments —
  it spends real API budget (~$0.75 for the Max run), so it isn't run automatically.
- **GitHub Pages.** Needs enabling once, in this repo's Settings → Pages, pointing at
  whichever branch should be live.
- **Leaked password protection is off.** Supabase Auth can reject a password found in
  a known breach (checked against HaveIBeenPwned) and it is not turned on for this
  project. It is a toggle in the dashboard — Authentication → Providers → Email — not
  something a migration can reach.
- **`delete_own_account()` is written but not applied.** Account deletion in Account
  settings calls it, and the migration
  (`supabase/migrations/20260818140000_delete_own_account.sql`) is checked in and
  mirrors `debug_set_plan`'s SECURITY DEFINER + REVOKE/GRANT shape — but applying a
  function with DELETE rights on `auth.users` to the live project needs a human to run
  it (via the SQL editor or `supabase db push`), not an agent. Until it's applied, the
  button fails with a clear error rather than doing nothing.
- **`privacy.html` and `terms.html` are drafts, not legal documents.** Written from what
  the app's code actually does (the two external services it talks to, what each
  stores, that there's no tracking or ads), plus the account holder's own answers on
  contact address, age cutoff, and jurisdiction (Israel). The one thing still marked
  `[open]` is the payments section in `terms.html`, which has nothing real to say
  until Stripe exists. Neither document has been reviewed by a lawyer — that still
  needs to happen before either is relied on for anything.

Fixed while checking for exactly this kind of gap: every owner-scoped RLS policy
(`courses`, `progress`, `subscriptions`, `ai_usage`, `user_stats`, `material_reports`)
called `auth.uid()` directly, which Postgres re-evaluates per row scanned rather than
once per query — the standard fix, `(select auth.uid())`, changes nothing about who can
read what. `material_reports` had a foreign key with no covering index. And
`debug_set_plan` — already guarded by its own internal email check, so never actually
exploitable — still had a stray `EXECUTE` grant to `anon`, left over from Supabase's
default grant on newly created functions, which the original migration's
`revoke ... from public` didn't reach. All three in
`supabase/migrations/20260818090000_rls_perf_and_debug_grant_fix.sql`, applied to the
live project and confirmed clean against Supabase's own advisors.

A second pass, on the client this time, found something that actually mattered: four
places built an HTML attribute as `attr="${esc(value)}"` — the library grid's course
cards (aria-label, twice more on the rename/delete buttons) and the lesson breadcrumb.
`esc()` escapes by round-tripping a string through a text node, which is exactly right
inside an element's *text* — but a browser's HTML serializer never escapes a bare `"`
in text position, because a quote means nothing there. Used inside an attribute's own
quotes instead, that gap is the whole bug: a course titled `Biology" onmouseover="…`
closes the attribute early and opens a new one of its own. `escAttr()` — `esc()` plus
both quote characters — already existed for exactly this and was already used correctly
everywhere else; these four just used the wrong one. Fixed by swapping the call, proven
against a live page with Playwright (a course card carrying that exact payload renders
with five ordinary attributes and no `onmouseover`, confirmed via `getAttribute` rather
than trusted from a debug print), and guarded going forward: `tests/lesson-visuals.js`
now scans `app.js`'s own source for any double-quoted attribute interpolating a bare
`esc(...)` and fails if one exists, so the same mistake on a fifth call site fails a
test rather than shipping. Course titles turned out to be the one piece of this app
both stored and attacker-shaped — typed by the account that owns them, or landing
there from whatever a model made of an uploaded document — everything else
interpolated into an attribute anywhere in `app.js` turned out to be a number, a
boolean, an index, or one of the app's own fixed constant ids, none of which can
carry a quote character at all.
