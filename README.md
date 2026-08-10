# AI Learning Path

A single self-contained `learning-app.html` file — no backend, no build step, no dependencies except PDF.js from a CDN. Open it in a browser and it runs.

**Core loop:** upload a PDF (or paste text) → the app calls the Anthropic Claude API to extract 10-20 concepts and order them by prerequisite → it builds a Duolingo-style learning path → each node opens a multi-step interactive lesson grounded in the user's actual document.

See [`HANDOFF.pdf`](./HANDOFF.pdf) for a full project handoff: architecture, storage model, cost model, lesson structure, question types, build history, and what's left to build.

## Usage

Open `learning-app.html` directly in a browser and enter an Anthropic API key when prompted. The key is stored in `localStorage` and sent only to Anthropic.
