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
  checks the caller has an active subscription or trial, enforces a per-user daily call
  cap (50 trialing / 200 active — a cost backstop, since one dev-held key now pays for
  every user's calls), then forwards the request to a fixed server-side model. The
  client can never pick a pricier model or bypass the cap.
- New signups get a 14-day trial automatically via a trigger on `auth.users`.

## Cost model

Model: `claude-haiku-4-5`, fixed server-side. One lesson ≈ $0.01. Lessons are cached
after first generation, so replaying or exiting and coming back is free. A usage badge
in the header shows the signed-in user's cumulative spend and call count, read from
`ai_usage`.

## Sending the code out for review

There is no public URL to hand over: GitHub Pages has never been enabled for this repo
(see below), so a link to the site fetches nothing. Two files are the whole frontend —
`index.html` and `app.js`, about 215 KB together — so attaching or pasting both is the
reliable way to get a second opinion from another tool. Once Pages is on, the live URL
still only shows the rendered page; a reviewer needs `app.js` to say anything useful.

## What's not done yet

- **Payments.** `subscriptions.status` and the trial trigger exist and are enforced by
  `ai-proxy`, but there's no Stripe integration yet — `showUpgradePrompt()` in the
  frontend is a placeholder. Once a Stripe account and price exist, this needs a
  checkout Edge Function and a webhook that updates `subscriptions` on
  `checkout.session.completed` / `customer.subscription.updated`/`deleted`.
- **GitHub Pages.** Needs enabling once, in this repo's Settings → Pages, pointing at
  whichever branch should be live.
