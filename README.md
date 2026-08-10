# AI Learning Path

A single self-contained `learning-app.html` file — no backend, no build step, no
dependencies beyond PDF.js from a CDN. Open it in a browser and it runs.

**Core loop:** upload a PDF (or paste text) → the app calls the Claude API to extract
10-20 key concepts and order them by prerequisite → it builds a Duolingo-style learning
path → each node opens a multi-step interactive lesson grounded in your own document.

## Quick start

1. Open `learning-app.html` in a browser (double-click, or `file://` works fine).
2. Paste an Anthropic API key ([platform.claude.com](https://platform.claude.com)) when prompted.
   The key is stored only in your browser's `localStorage` and sent only to Anthropic.
3. Upload a PDF or paste some study material, and the learning path is generated.

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

Everything lives in one HTML file:

- `<style>` — all CSS: the 3D learning path, lesson screen, question types, visuals, library.
- `<body>` — API-key modal, course library, source picker (upload/paste), learning-path
  screen, lesson screen (a separate full-screen overlay), preview dialog, loading overlay.
- `<script>` — vanilla JS, no framework or build step.

State lives in `localStorage`, keyed per course (`course_library`, `course:<id>`,
`progress:<id>`, `source:<id>`), so the app supports up to 8 courses at once with
independent progress, review schedules, and cost tracking (`ai_usage`).

## Cost model

Model: `claude-haiku-4-5` (constant `AI_MODEL`). One lesson ≈ $0.01. Lessons are cached
after first generation, so replaying or exiting and coming back is free — only the first
generation and reviews with a stale cache cost anything. A usage badge in the header
shows cumulative spend, call count, and cache hits.

## Notes on this being a browser-only prototype

The API key is stored and used client-side, which is fine for personal/local use but
not for sharing the file with others. Turning this into a shareable product means moving
the API key behind a small backend (Node/Vercel/Railway) that holds one key server-side
and meters usage per user — not yet built.
