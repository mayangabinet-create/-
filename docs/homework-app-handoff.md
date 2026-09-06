# Handoff: building the homework app

**Audience: the next agent session, not a human reader.** You are being asked to build a
*second, separate* app — a homework/study tool for students — reusing what this
repository (AI Learning Path) already proved out. This file tells you what to take, what
to leave, what will bite you, and what you must not decide on your own.

Everything below marked **[verified]** was checked against this repo's source at the
commit that added this file. Line numbers drift; the symbol names are the durable part —
grep for those, don't trust the numbers.

---

## 0. Read this before writing any code

### 0.1 Three decisions are NOT yours to make

Do not guess these. Ask the user, and wait. Each one changes the schema or the first
screen, and getting one wrong means rewriting rather than extending.

1. **Photo or PDF?** A high-school student photographs a worksheet with a phone —
   skewed, shadowed, one page. That is a different problem from a clean PDF. If photos
   are the real case, OCR quality and a correction UI *shape* the first milestone rather
   than getting bolted on later.
2. **One student, or a class?** If assignments are ever shared between students or set
   by a teacher, that belongs in the tables from day one, not in a later migration.
3. **Free or paid?** If paid: the user must open an account with the payment provider
   and you must read that provider's own documentation *before* writing the
   integration. See §6.1 — this is the most expensive mistake this project already made.

### 0.2 Where this app ends and the existing one begins

One question separates them cleanly:

> **Does this thing come from a document, or from a date someone typed?**

Everything in AI Learning Path comes from a document. Everything in the homework app
comes from a date someone typed. Keep that seam. Do not merge the calendar/deadline
model into the existing app, and do not rebuild course generation in the new one.

---

## 1. The single biggest reuse: worksheet mode already works

This is the most valuable finding in this file. The hard half of "photograph a homework
page, get a structured exercise list" is **already written and tested in this repo**.

| What you need | Where it already exists |
|---|---|
| Prompt: list every exercise, in order, none merged/skipped/invented, keep the numbering | `buildWorksheetPlanPrompt()` in `app.js` **[verified]** |
| Suitability gate that does *not* reject terse exercise text | `assessWorksheetMaterial()` in `app.js` **[verified]** |
| The gate it replaces, and why it rejects worksheets | `assessMaterial()` in `app.js` **[verified]** |
| Tests for both | `tests/onboarding.js` |

`assessMaterial()` rejects text that is mostly digits and symbols with no real sentences —
which is exactly what a page of exercises looks like. That is why the worksheet path
needs its own gate. Read the "Worksheet mode" section of `README.md` before touching
any of it.

**Port the prompt and the gate. Change only what the output becomes:** in this repo an
exercise becomes a `concept` that gets a generated lesson. In the homework app it should
become a plain checklist item with a done/not-done state. Do not generate a lesson per
exercise — that is the other app, and it costs real money per item.

---

## 2. The PDF pipeline

Two independent paths. Both are worth taking.

### 2.1 In the browser
- `pdf.js` is **lazy-loaded on first use**, not at page load. Keep that.
- Scanned pages go through Tesseract OCR, Hebrew and English, capped at 40 pages.
- Both are loaded from a CDN that is named explicitly in the CSP in `index.html`. If you
  change the loader, change the CSP in the same commit or the app silently fails to boot.

### 2.2 Offline, for heavy material — `tools/pdf_prep/`
Python, no model involved, therefore free, deterministic, and incapable of inventing a
sentence. Copy the directory as-is; it has no dependency on the rest of the app.

It reads with PyMuPDF (OCR'ing scans), puts lines in reading order (columns detected,
right-to-left runs fused back into lines), lifts out tables and figures, drops running
headers and page numbers, and writes two files:

- `document.md` — the text, and the **only** copy of it, with `<!-- page N -->` markers.
- `document.json` — the map: outline with page ranges, chunks, tables as data, and for
  each the character range of the Markdown it occupies.

Nothing is stored twice: a consumer reads the JSON, decides what matters, and slices
those ranges out of the Markdown. `--bundle` writes both as one file the upload box
accepts.

**The handoff is a file, not a service call, on purpose.** The Edge Function runtime is
Deno and cannot run Python. A live call would mean deploying a Python service and a queue
to reach it. Do not "fix" this by building that service unless something actually
requires it.

### 2.3 Retrieval
`retrieveExcerpt()` in `app.js` **[verified]** does TF-IDF retrieval scoped to the right
chapter via the outline. This is what keeps generated content grounded in the real
passage instead of the model's general knowledge. If the homework app ever explains an
exercise, reuse this rather than sending the whole document.

---

## 3. Architectural invariants — do not break these

These are the patterns that made this codebase survivable. They are cheap to keep and
expensive to retrofit.

### 3.1 The model chooses, the app computes
The model never draws and never does arithmetic. It returns a structured spec — *"this is
a right triangle, the legs are 6 and 8"* — and the app computes the hypotenuse and
renders it. **The model knows what the thing is about; the app knows what is true.**

In the homework app: the model identifies which exercises are on the page. The app
computes the pace, the days remaining, the percentage complete. Never let the model do
the scheduling arithmetic — it will be confidently wrong and nothing will catch it.

### 3.2 One registry as the single source of truth
See `VISUALS` and `QUESTION_TYPES` in `app.js`. Each entry holds what the model is shown
(`use`, `spec`), what a spec must survive (`check`), and how it renders (`draw`). The
catalogue in the prompt is **generated** from the registry — `visualCatalogue()`
**[verified]** — so the model can never be offered something the app cannot handle, and
adding a type is one entry.

### 3.3 Pure rules in a file with no I/O, imported by the tests
`supabase/functions/ai-proxy/policy.mjs` holds every decision — what a tier buys, what
counts as a lesson, how much of the document survives, which block gets cached. No Deno,
no network. `index.ts` is I/O only. `tests/ai-proxy-policy.mjs` imports **the same file
that ships**, not a copy. `_shared/grow-policy.mjs` follows the same split.

**Copy this pattern first.** It is the reason the rules could be changed without fear.

### 3.4 The server is the authority
`app.js` carries a copy of the plan table, but only to shape the UI. The server decides,
because a modified client can send any prompt it likes. Quota is enforced in the
`consume_ai_quota` RPC called from `index.ts` **[verified]**, never in the browser.

### 3.5 Fail closed, never break the screen
A spec the app cannot render is dropped rather than shown broken. A widget that throws
while wiring stays a static picture. A description that throws still returns a generic
label. No single failure takes down the whole view.

In the homework app this matters more, not less: **if exercise detection fails or returns
nonsense, the user must land on a manual-entry list, never an empty screen.**

### 3.6 Never `eval` model output
Slider formulas come from the model, so `app.js` parses a fixed closed grammar instead:
numbers, variables, `+ - * / % ^`, parentheses, and a closed list of functions. Anything
else throws and the widget degrades. This was the only code-execution hole in the app and
it was closed by design, not by patch.

### 3.7 Design tokens defined exactly once
Every colour, radius, spacing value and duration is defined once at the top of
`index.html`'s `<style>`. Nothing below that block hard-codes a value. This is what made
dark mode a second set of values rather than a rewrite.

---

## 4. Cost and quota — a hard requirement, not a nicety

### 4.1 The hole that exists in this repo right now
`policy.mjs` **[verified]**:

```js
export const FREE_CALL_CHARS = 20_000;
export const FREE_CALLS_PER_DAY = 200;
```

and in `index.ts` **[verified]**:

```js
const model = kind === "course" ? plan.modelCourse : plan.modelLesson;
```

"Free work" (tutor/feedback/primer calls, capped at 1000 output tokens) is bounded only
by a **daily** counter. There is no monthly quota on it, unlike courses and lessons. On
Pro and Max it runs on Sonnet.

| Tier | ≈ per call | × 200/day | ≈ per month |
|---|---|---|---|
| Basic (Haiku) | $0.01 | $2 | **~$60** |
| Pro / Max (Sonnet) | $0.03 | $6 | **~$180** |

Max's intended worst case is roughly $17/month. A conversational feature on that backstop
multiplies the ceiling by about ten.

### 4.2 The rule for the new app
**Every AI-calling feature gets its own monthly quota, written before the first call is
made.** A daily backstop is a safety net against runaway loops, not a business limit.
Meter every call the way `ai_usage` does here, so cost per user is observable before it
is a surprise.

---

## 5. Proposed data model

Not verified — this is a starting point, not a decision. §0.1 may change it.

```
assignment      id, user_id, subject, title, source_kind(pdf|photo|manual),
                due_at, created_at, archived_at
assignment_item id, assignment_id, position, label, done_at
                -- one row per exercise; `position` preserves the page order
                -- that buildWorksheetPlanPrompt() is written to protect
subject         id, user_id, name, colour
timetable_slot  id, user_id, weekday, starts_at, ends_at, subject_id
exam            id, user_id, subject_id, at, topics[]
user_stats      user_id, xp, streak_count, last_active_on
```

Pace is **derived, never stored**: `remaining_items / days_left`. Storing it guarantees it
goes stale the moment an item is ticked. Keep the calculation a pure function with its own
tests — it is the one piece of logic the whole product rests on.

RLS: every owner-scoped policy uses `(select auth.uid())`, **not** bare `auth.uid()`. See
§6.8.

---

## 6. Known traps — each of these actually happened here

### 6.1 Payments: verify jurisdiction and read the real docs first
This project went through **three** processors. Stripe does not support businesses
registered in Israel. Cardcom does. Grow (Meshulam) onboarded fastest, so the integration
moved again — and **no card has ever been charged through any of them.**

Worse: Grow's request and response shapes were pieced together from a third-party npm
package and public search results, because the real documentation was not reachable while
building. It is still unconfirmed whether `grow-billing-cron` should run at all — if Grow
already re-charges saved tokens on its own schedule, that function **double-charges every
subscriber**. See the "Payments" and "What's not done yet" sections of `README.md`.

**Rule: open the account, read the provider's own docs, and run one sandbox transaction
end to end before writing the integration.**

### 6.2 Never duplicate a user-facing number
The trial was shortened from 14 days to 3 in a migration. The landing page was updated.
The signup modal kept promising "Fourteen days free" — in the sentence someone reads at
the exact moment they create an account. Give every such number one source.

### 6.3 `esc()` is not `escAttr()`
Escaping by round-tripping through a text node is correct inside an element's *text*, but
a browser's serializer never escapes a bare `"` there — because a quote means nothing in
text position. Inside an attribute's own quotes, that gap is the whole bug: a title like
`Biology" onmouseover="…` closes the attribute and opens a new one. Four call sites had
it. The fix that sticks is the test in `tests/lesson-visuals.js` that scans the source for
the pattern.

### 6.4 `role="img"` deletes everything inside the element
Five SVG figure types carried `aria-label="…"` falling back to the literal string
`'diagram'`. Because `role="img"` makes the element a leaf, every `<text>` inside — every
side length, tick value and axis bound — was dropped, and an uncaptioned figure announced
itself as "diagram" and stopped. Accessibility that *looks* done. See
`visualDescription()` in `app.js`.

### 6.5 A font fallback with no `unicode-range` covers scripts it was never measured on
`Nunito Fallback` declared no `unicode-range`, so it covered everything real Nunito does
not — including Hebrew. Hebrew text rendered through local Arial wearing overrides
measured on Latin: **1.0085× too wide**, silently, on the script the app is most likely to
be read in. If you ship a metric-matched fallback, scope it to the ranges the real font
actually has.

### 6.6 Ship abuse protection and analytics *before* publicising
Neither exists here. There is no CAPTCHA and no email confirmation, so nothing stops a
script stacking free trials. And there is no analytics at all, so there is no conversion
rate, no drop-off, and no way to check the assumption that most users never approach their
quota — which is exactly the assumption the pricing rests on.

### 6.7 Do not put implementation details in the price list
Naming the models in the plan picker turned a row that should be free to tune for speed
and cost into a promise to the user, meant nothing to anyone who does not follow model
releases, and went stale on every rename. Describe what the tier *gives*, not how.

### 6.8 `auth.uid()` in an RLS policy is re-evaluated per row
Postgres re-runs it for every row scanned. `(select auth.uid())` evaluates once per query
and changes nothing about who can read what. Every owner-scoped policy here was written
the slow way and needed a fixing migration.

### 6.9 Do not punish in gamification
Five hearts sat in the top bar and were removed. A row of hearts draining on a first
encounter with an idea teaches nothing except that guessing is expensive. The same applies
to streaks: missing one day must not feel like losing everything. Build streak protection
in from the start.

### 6.10 Watch the deploy order
`LESSON_CACHE_SPLIT` in `app.js` exists because one change was **not safe to deploy in
either order** — a new client against an old server produced a request the server clamped
to zero useful characters, and lessons failed to build rather than degrading. When client
and server must change together, gate it behind a flag that defaults to the old behaviour
and flip it in the change that deploys the server, or later. Never before.

---

## 7. Build order

The spec the user was given starts with the calendar and full CRUD. **That order is
wrong.** The differentiating feature is "photograph a homework page, get a list", and it
is also the riskiest part technically. Build it first, while there is still room to
discover it does not work.

| Phase | What | Why here |
|---|---|---|
| **0** | Schema; pure-rules module + its tests; monthly AI quotas; design tokens and dark mode | All four are painful to retrofit and cheap now |
| **1** | Upload/photo → OCR → exercise list → **a correction screen** → tick items off | The differentiator and the main risk. Detection is never perfect; the correction step is not optional |
| **2** | Due dates; the pace calculator as a pure tested function; a "what today" home screen; silent recalculation when behind | This is where it becomes useful rather than a novelty |
| **3** | XP, levels, protected streaks, progress rings, completion animations | Formulas and the `user_stats` sync already exist in this repo — port them |
| **4** | Calendar, weekly timetable, exam countdowns, AI planning | Most visible, easiest to build wrong without real users. Last on purpose |

---

## 8. Technology

This repo is deliberately framework-free with no build step, and that worked well — but
here is the honest limit: `app.js` is now **586 KB across 10,550 lines**, and `index.html`
is **202 KB** with all CSS inline. It still loads fast. It is also the ceiling, and the
homework app is far more stateful — a calendar, a timetable, recurring entities, offline
use.

**Take a framework this time, and keep the discipline.** What made this project reliable
was not the absence of a build step; it was §3. Every one of those invariants transfers.

| Layer | Choice | Note |
|---|---|---|
| Frontend | Next.js + React | Complex state, routing, SSR for public pages |
| DB + Auth | Supabase | Already known; the RLS lessons transfer directly |
| AI | Edge Function proxy | Same shape as `ai-proxy`: JWT, quota, metering, streaming |
| PDF (offline) | `tools/pdf_prep` | Copy as-is. Do not try to run Python in an Edge Function |
| PDF (browser) | pdf.js + Tesseract | Lazy-loaded, CSP updated in the same commit |
| Charts | Recharts | Enough for the statistics screen |
| Icons | Lucide | One set, consistently |
| Hosting | Vercel | Note this is no longer a static site |
| Fonts | Assistant or Heebo | Real Hebrew coverage. Re-read §6.5 |

One more thing worth copying: a streaming watchdog. `callAI` in `app.js` arms an
`AbortController` for 30s, re-armed on response headers and on **every chunk**, because a
mobile network that stops delivering packets does not reject `fetch` — the promise just
hangs, and the user sees a screen stuck on loading forever with nothing to retry.

---

## 9. How to verify your work

This repo's conventions, worth carrying over:

- No build step means tests can lift functions out of the shipping source by name and
  compile them alone — so the tests run the real code, not a copy that drifts. See the
  header of `tests/lesson-visuals.js`.
- CI is exactly the commands a contributor runs by hand: `node tests/<file>` per suite,
  plus pytest for the Python tools. See `.github/workflows/`.
- Current state: **775 tests passing across 8 JS suites**, plus the Python suites.

Two traps in that test harness, if you copy it: it lifts a `const` declaration by matching
brackets and treats `'` and `` ` `` as string delimiters — so an apostrophe or a backtick
in a comment *inside* a lifted object silently swallows the rest of it. And a backtick in
an HTML comment inside a template literal terminates the string. Both cost a debugging
round here.

---

## 10. Things this file is not sure about

State these to the user rather than acting on them:

- The data model in §5 is a proposal, not a decision.
- Whether the homework app should generate explanations at all (that is the other app's
  job, and it costs money per item) is unresolved.
- Whether photo capture or PDF upload is the primary path — §0.1, question 1 — changes
  phase 1 substantially and has not been answered.
