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
  its own tier's answer. A reference copy of the deployed source is checked in at
  `supabase/functions/ai-proxy/index.ts` — the deployment is the source of truth, and
  the copy is there so the server's rules are readable next to the client that has to
  match them.
- New signups get a 14-day trial automatically via a trigger on `auth.users`.

## Tiers

Held in `PLANS` in the Edge Function; `subscriptions.plan` picks the row, and an
unrecognised value falls back to `basic` rather than the largest tier. `app.js` carries
a matching copy and has to be kept in step with it: the server clamps every request
*down* to the tier, so the client's copy can't take more than was paid for — it exists
so the client doesn't cut the document below the tier first, which would leave Max
buying a bigger model to read a Basic-sized document.

These numbers exist in three places, and changing one means changing the others:
`PLANS` in `supabase/functions/ai-proxy/index.ts` (and a redeploy), `PLANS` in `app.js`,
and `TIER_EXPECT` in `tests/tier-checks.js`. The third is deliberate duplication — it's
the assertion, so it must not read its expected values out of the code it checks.

| | courses/mo | lessons/course | doc read (course plan) | excerpt (per lesson) | model |
|---|---|---|---|---|---|
| trial | 1 (lifetime) | 10 | 5,000 | 2,400 | Haiku |
| basic | 3 | 10 | 5,000 | 2,400 | Haiku |
| pro | 5 | 12 | 40,000 | 8,000 | Sonnet |
| max | 8 | 15 | 120,000 | 16,000 | Opus plans, Sonnet writes |

## Cost model

One Haiku lesson ≈ $0.01; the higher tiers cost more per lesson because they run on
larger models and read more of the document. Lessons are cached after first
generation, so replaying or exiting and coming back is free. A usage badge in the
header shows the signed-in user's cumulative spend and call count, read from
`ai_usage`.

## What's not done yet

- **Payments.** `subscriptions.status` and the trial trigger exist and are enforced by
  `ai-proxy`, but there's no Stripe integration yet — `showUpgradePrompt()` in the
  frontend is a placeholder. Once a Stripe account and price exist, this needs a
  checkout Edge Function and a webhook that updates `subscriptions` on
  `checkout.session.completed` / `customer.subscription.updated`/`deleted`.
- **Tier verification against a live account.** `tests/tier-checks.js` covers the two
  things SQL can't: that a client sending 120,000 chars on Basic is clamped server-side,
  and that each tier really returns 10/12/15 concepts. Run it before enabling payments.
- **The usage badge is an estimate.** `ai_usage` keeps one running token total with no
  model attached, so spend is priced at whatever tier the account is on now — including
  usage from a month it spent on a different plan. Storing tokens per model would make
  it exact.
- **GitHub Pages.** Needs enabling once, in this repo's Settings → Pages, pointing at
  whichever branch should be live.
