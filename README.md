# AI Learning Path

Two files — `index.html` (markup + styles) and `app.js` — in Duolingo's visual
language, with no build step and no framework. Drop in a PDF (or paste text), name it,
and the app turns it into a Duolingo-style learning path: 10-20 concepts extracted and
ordered by prerequisite, each opening a multi-step interactive lesson grounded in your
own document. Courses can be renamed any time, from the card in your library or by
tapping the title above the path.

## Quick start

- **Live:** open this repo's GitHub Pages URL (Settings → Pages, once enabled) and
  sign up with an email + password.
- **Locally:** open `index.html` directly in a browser (double-click, or `file://`
  works fine) — it talks to the same hosted backend either way.

There's no API key to paste in. Every account gets a free trial automatically; subscribing
after that isn't wired up yet (see below).

## Signing in happens last

Nothing asks for an account until there is something to save. A visitor picks a PDF
(read in the browser by pdf.js — no server involved), lands on a staging screen showing
the source, its word count and a name field, and only then does "Create free account &
build" appear, explaining what the account is for. The Courses tab shows an invitation
rather than a login form, and the Review tab explains itself instead of interrupting.
The staged material survives signing in from anywhere, so nothing is retyped.

## What a lesson contains

Hook → prediction → concept cards → worked example → guided practice → a mixed-format
quiz (choice, true/false, ordering, categorizing, fill-the-blank, matching, find-the-mistake)
→ a capstone challenge → summary → a memory check, plus an AI tutor dock available
throughout. Diagrams (flow, compare, hierarchy, timeline, table, bar) are generated
from structured specs the model returns — no image generation, no extra API calls.

Every lesson is grounded in the source document: the relevant passage is retrieved via
TF-IDF and sent to the model with strict rules that facts and quiz questions must come
from that passage, not general knowledge.

Courses are multi-language: the app writes in whatever language the source material is
in, and the UI adapts direction (RTL) for Hebrew/Arabic content while the chrome itself
stays English.

## Spaced repetition

Completed lessons are scheduled for review using a simplified SM-2 algorithm based on
how well you did (accuracy → a 0-5 quality score → the next-review interval and ease
factor). When a lesson comes due, a banner appears on the learning path; "Review now"
starts a short session built from the quiz questions already generated for those
lessons — no new AI calls, so reviewing is free. Doing well pushes the lesson further
out; doing poorly resets it to a daily review.

## Design rules

`index.html` opens with a token block that is the design system: an 8px spacing scale,
a fixed px type scale (stacked `em` sizing meant the same class rendered at different
sizes depending on nesting), four radius steps, two line-heights, a 68ch reading
measure, a 44px tap-target floor and a 52px height for a screen's one main action.

Green is the only primary — every primary action is green and nothing else is. Blue is
secondary/links, red destructive, purple the tutor, and the five unit colours identify
units. Every value that carries text was solved for WCAG AA against the surface it
actually sits on rather than picked by eye; the vivid `--duo-*` tokens are fills only,
the `--duo-*-strong` variants are the ones white text is allowed on, and the
`--duo-*-on-sunk` pair is for text on the `#E5E5E5` sunken surface, where the ordinary
tokens fall below AA. Twelve app states are audited at zero failures.

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
  checks the caller has an active subscription or trial, enforces a per-user cap (a cost
  backstop, since one dev-held key pays for every user's calls), then forwards the
  request to a fixed server-side model. The client can never pick a pricier model or
  bypass the cap.
- New signups get a trial automatically via a trigger on `auth.users`.

`supabase/migrations/` holds the version-controlled copy of schema changes. The database
is remote-only, so without it nothing in the repo describes its shape.

## Plans

Sold **per course**, because that's the unit someone actually wants — "turn my three
textbooks into courses", not "give me 60 lessons".

| | Basic | Pro | Max |
|---|---|---|---|
| Price | $6.99/mo · $69.90/yr | $19.99 · $199.90 | $39.99 · $399.90 |
| Courses per month | 3 | 5 | 8 |
| Lessons per course | 10 | 12 | 15 |
| Reads of your document | 5,000 chars | 40,000 | 120,000 |
| Model — lessons | Haiku 4.5 | Sonnet 5 | Sonnet 5 |
| Model — course plan | Haiku 4.5 | Sonnet 5 | Opus 5 |

Annual is twelve months at ten months' price. Max spends Opus only on planning the
course — deciding which concepts exist and in what order is the one hard reasoning step,
and it's a single call; writing a lesson from a chosen concept and a retrieved passage is
routine work Sonnet does well.

A course is only a priceable unit because the lesson count is fixed. `generateLessonPath`
used to ask for "10-20 core concepts", so the same course cost anywhere from 10 to 20
lessons; it now asks for exactly the tier's number and truncates the result.

The `PLANS` table at the top of `app.js` is a **hint** — it shapes the excerpt the
client's TF-IDF actually builds, and drives the UI. `ai-proxy` holds the same table and
clamps against it, because a modified client can send whatever it likes.

## Cost model

Worked from the prompt sizes and token ceilings in `app.js`, one English lesson costs
**≈ $0.029** on Haiku 4.5 ($1/$5 per MTok), **$0.095** on Sonnet 5 ($3/$15), and
**$0.112** on the Max split — all-in, including each lesson's share of the course-plan
call and roughly 20 tutor questions. Hebrew runs about twice that. A completed course is
$0.29 / $1.14 / $1.68.

Worst case is the entire monthly quota spent, every lesson opened, all in Hebrew: $1.74 /
$11.40 / $26.88, leaving **$4.75 / $7.71 / $11.65** after Stripe. Every tier is profitable
even then. Two things keep the typical case far below that — lessons are generated only
when opened (`app.js` checks the cache first) and cached afterwards, so replaying is free
and an abandoned course costs only what was read.

These are calculations, not measurements. `ai_usage` stores real `input_tokens` /
`output_tokens` per user; divide actual spend by actual courses before trusting any of it.

> Sonnet 5's introductory $2/$10 pricing ends **2026-08-31**. The figures above already
> use the standard $3/$15, so none of them depend on a rate that is about to expire.

The header badge shows **"1 of 3 courses this month"**. It used to show a running dollar
total of this app's own cost of goods, itemised for the person paying — a money meter that
re-prices every tap and makes the product feel expensive to touch.

## Sending the code out for review

There is no public URL to hand over: GitHub Pages has never been enabled for this repo
(see below), so a link to the site fetches nothing. Two files are the whole frontend —
`index.html` and `app.js`, about 215 KB together — so attaching or pasting both is the
reliable way to get a second opinion from another tool. Once Pages is on, the live URL
still only shows the rendered page; a reviewer needs `app.js` to say anything useful.

## What's not done yet

- **The tiers are displayed, not enforced.** The account and pricing screens, the plan
  table, the quota badge and the tier-driven read/excerpt budgets are all built and in
  `app.js`. The server side is not: `supabase/migrations/` has the schema change but it
  has not been applied, and `ai-proxy` still runs one fixed model with a daily call cap.
  Until both land, a modified client is not actually clamped — the server has to hold the
  plan table too.
- **The free trial has no total ceiling.** It's 50 calls/day for 14 days, so one signup
  can consume ~700 lessons and pay nothing. Capping it at one course (10 lessons), and
  requiring a confirmed email before the counter opens, is the single highest-value change
  left — it's the difference between the margins above and a loss.
- **Payments.** `subscriptions.status` and the trial trigger exist and are enforced by
  `ai-proxy`, but there's no Stripe integration yet — `startCheckout()` in the frontend
  shows the chosen plan and price and then explains that nothing was charged. Once a
  Stripe account and prices exist, this needs a checkout Edge Function and a webhook that
  updates `subscriptions` on `checkout.session.completed` /
  `customer.subscription.updated`/`deleted`.
- **GitHub Pages.** Needs enabling once, in this repo's Settings → Pages, pointing at
  whichever branch should be live.
