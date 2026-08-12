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
  warns and marks a review as due. Red destroys or fails. Violet is the AI tutor and
  *only* the AI tutor, so "this came from the model" is legible at a glance. Every
  `--*-text` value clears 4.5:1 on the surface it is paired with, and every fill
  clears 4.5:1 under white label text.
- **Type.** One family (Nunito) at four weights. A second display face only put two
  rounded fonts in competition; size and weight carry the hierarchy instead. Sizes
  are a fixed rem scale — 12 / 14 / 16 / 17 / 18 / 22 / 28 / 32 — not the four dozen
  ad-hoc `em` values that came before, and the scale shifts down one step below 768px.
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
- **The client sizes every request as if it were Basic.** `app.js` now reads
  `subscriptions` at sign-in and mirrors the tier table in `PLAN_LIMITS`, but that copy
  is display only — it drives the Account page's quota meters and the warning before an
  upload, nothing about the request itself. A course call still sends a fixed 5,000
  chars of the document and a lesson a fixed 2,400-char excerpt. The server clamps
  *down* to the tier, so nobody can take more than they paid for — but nobody can take
  more than Basic either, because the client already cut the document to Basic's size
  before the request left the browser. Pro and Max currently buy a bigger model reading
  a Basic-sized document. This has to be fixed before anyone is charged for those tiers:
  size `readChars`/`EXCERPT_BUDGET`/`MAX_COURSES` from `PLAN_LIMITS` instead of hardcoding them.
- **Tier verification against a live account.** `tests/tier-checks.js` covers the two
  things SQL can't: that a client sending 120,000 chars on Basic is clamped server-side,
  and that each tier really returns 10/12/15 concepts. Run it before enabling payments.
- **GitHub Pages.** Needs enabling once, in this repo's Settings → Pages, pointing at
  whichever branch should be live.
