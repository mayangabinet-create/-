        // Configuration
        // Courses now live in Supabase, one row per user — not localStorage.
        // These are public by design (like a Firebase config): they identify
        // the project and let a signed-in browser talk to it under RLS. The
        // real secret (the Anthropic key) never leaves the ai-proxy Edge Function.
        const SUPABASE_URL = 'https://kgkdkkqoebnpahvetwzk.supabase.co';
        const SUPABASE_ANON_KEY = 'sb_publishable_qE7c9BFhruGYYi_QgP4i4w_1T86fift';

        // If the supabase-js CDN script failed to load (blocked, offline, ad-blocker),
        // window.supabase is undefined. Everything below this line — icons, every
        // button's event listener — depends on this script finishing, so an
        // unguarded call here would throw and silently take the whole app down
        // instead of just the parts that need a network call.
        if (!window.supabase) {
            document.body.innerHTML = `
                <div style="max-width:420px;margin:15vh auto;text-align:center;padding:24px;font-family:'Nunito',sans-serif;color:#3C3C3C;">
                    <h2 style="font-family:'Baloo 2',sans-serif;margin-bottom:12px;">Couldn't load the app</h2>
                    <p style="color:#777;margin-bottom:20px;">A required script didn't load. Check your internet connection, or try disabling an ad-blocker/VPN for this site, then try again.</p>
                    <button onclick="location.reload()" style="padding:12px 28px;border-radius:12px;border:none;background:#1CB0F6;color:#fff;font-weight:800;font-size:1em;cursor:pointer;">Try again</button>
                </div>`;
            throw new Error('supabase-js failed to load from CDN');
        }
        const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

        const ACTIVE_STORAGE = 'active_course_id';  // just "last opened", fine to keep per-device
        const MAX_COURSES = 8;   // how many courses a library holds, not how many you may build

        // Mirrors PLANS in the ai-proxy Edge Function, and has to be kept in step
        // with it. The server is the authority and clamps every request down to
        // the account's tier, so nothing here can buy more than was paid for.
        // This copy exists for the opposite failure: without it the client cuts
        // the document to 5,000 chars before sending, and a Max account gets
        // Basic's reading no matter how generous the server was willing to be.
        const PLANS = {
            trial: { lessonsPerCourse: 10, readChars: 5000,   excerptChars: 2400,  label: 'Trial' },
            basic: { lessonsPerCourse: 10, readChars: 5000,   excerptChars: 2400,  label: 'Basic' },
            pro:   { lessonsPerCourse: 12, readChars: 40000,  excerptChars: 8000,  label: 'Pro' },
            max:   { lessonsPerCourse: 15, readChars: 120000, excerptChars: 16000, label: 'Max' },
        };

        // Smallest tier until the real one is known. Erring low only costs a
        // shorter document on the first call; erring high would send 120,000
        // chars over the wire for the server to throw away.
        let planKey = 'basic';
        let currentPlan = PLANS.basic;
        let planLoaded = false;

        let currentUser = null;
        let courseData = null;
        let currentLessonIndex = 0;
        let progress = {};
        let activeCourseId = null;
        let activeSourceText = '';
        let library = [];

        // ============= Icons =============
        // Plain line/fill SVGs, matching the close button's existing style
        // (viewBox 0 0 24 24, currentColor) — no emoji anywhere in the UI.
        function svgIcon(inner, { fill } = {}) {
            return fill
                ? `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor">${inner}</svg>`
                : `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
        }
        const ICONS = {
            flame: svgIcon('<path d="M12 2c1 3-3 4.5-3 8.5a3 3 0 006 0c0-1-.6-1.8-.6-1.8 2 1.2 3.6 3.4 3.6 6a6 6 0 01-12 0C6 10 9.5 7 12 2z"/>', { fill: true }),
            gem: svgIcon('<path d="M3 8.5L7 3h10l4 5.5L12 21z"/><path d="M3 8.5h18M8.5 3L12 8.5 15.5 3M7 3l5 5.5M17 3l-5 5.5"/>'),
            star: svgIcon('<path d="M12 2.5l3 6.4 6.9.7-5.2 4.8 1.5 6.8L12 17.7 5.8 21.2l1.5-6.8-5.2-4.8 6.9-.7z"/>', { fill: true }),
            home: svgIcon('<path d="M3 11.5L12 4l9 7.5"/><path d="M5.5 10v9a1 1 0 001 1H10v-6h4v6h3.5a1 1 0 001-1v-9"/>'),
            book: svgIcon('<path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2V5z"/><path d="M4 19a2 2 0 012-2h13"/>'),
            refresh: svgIcon('<path d="M20 12a8 8 0 01-14.6 4.6M4 12a8 8 0 0114.6-4.6"/><path d="M3.5 17v-4h4M20.5 7v4h-4"/>'),
            account: svgIcon('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.5 4-7 8-7s8 2.5 8 7"/>'),
            chat: svgIcon('<path d="M4 4.5h16v12H8.5L4 20.5z"/>'),
            eye: svgIcon('<path d="M2 12s4-7.5 10-7.5 10 7.5 10 7.5-4 7.5-10 7.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
            eyeOff: svgIcon('<path d="M3 3l18 18"/><path d="M10.6 10.6a3 3 0 004.2 4.2"/><path d="M6.5 6.6C4 8.4 2 12 2 12s4 7.5 10 7.5a9.7 9.7 0 004.1-.9M9.9 5.1A10.6 10.6 0 0112 4.5c6 0 10 7.5 10 7.5a17 17 0 01-3.2 4.1"/>'),
            lock: svgIcon('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>'),
            check: svgIcon('<path d="M4 12.5l5.5 5.5L20 7"/>'),
            heart: svgIcon('<path d="M12 21s-7.4-4.6-9.9-9.2C.7 8.2 2 4 6 4c2.2 0 4 1.6 6 4 2-2.4 3.8-4 6-4 4 0 5.3 4.2 3.9 7.8C19.4 16.4 12 21 12 21z"/>', { fill: true }),
            file: svgIcon('<path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/>'),
            info: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 8v.01"/>'),
            x: svgIcon('<path d="M6 6l12 12M18 6L6 18"/>'),
            pencil: svgIcon('<path d="M4 20h4L19 9a2.1 2.1 0 00-3-3L5 17z"/><path d="M14.5 6.5l3 3"/>'),
        };

        // PDF.js setup — guarded because PDF upload is optional (pasting text still
        // works without it); a blocked/slow CDN load should only disable that one
        // feature, not throw here and take the rest of this script down with it.
        if (window.pdfjsLib) {
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        }

        // ============= API & AI Functions =============
        // Token ceilings per task. Nothing here needs 3000 tokens except lesson JSON.
        // Hebrew runs ~2x the tokens of English, and this JSON is verbose.
        // Too low a ceiling truncates the response mid-object and JSON.parse dies.
        const MAX_TOKENS = { path: 4000, lesson: 5000, tutor: 400, feedback: 250 };

        let lastCallTruncated = false;

        // Every generation call goes through the ai-proxy Edge Function instead of
        // Anthropic directly: it holds the real API key server-side, checks the
        // caller has an active subscription/trial, and enforces the daily cap.
        async function callAI(userMessage, systemPrompt = '', opts = {}) {
            lastCallTruncated = false;
            if (!currentUser) {
                showAuthModal('signin');
                return null;
            }

            const { retries = 2, maxTokens = 1000 } = opts;
            const body = { messages: [{ role: 'user', content: userMessage }], max_tokens: maxTokens };
            if (systemPrompt) body.system = systemPrompt;

            for (let attempt = 0; attempt <= retries; attempt++) {
                try {
                    const { data, error } = await supabaseClient.functions.invoke('ai-proxy', { body });

                    if (!error) {
                        refreshUsage();
                        if (data.stop_reason === 'max_tokens') {
                            console.warn('Response truncated at max_tokens');
                        }
                        lastCallTruncated = data.stop_reason === 'max_tokens';
                        const parts = data.content || [];
                        return parts.filter(p => p.type === 'text').map(p => p.text).join('') || '';
                    }

                    const status = error.context?.status;
                    let payload = {};
                    try { payload = await error.context.json(); } catch (_) {}
                    console.error('ai-proxy error:', status, payload);

                    // Rate limited or overloaded — back off and retry
                    if ((status === 429 || status >= 500) && attempt < retries) {
                        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
                        continue;
                    }

                    if (status === 401) {
                        showError("Your session expired. Please sign in again.");
                        await supabaseClient.auth.signOut();
                        showAuthModal('signin');
                        return null;
                    }
                    if (status === 402) {
                        showError(payload.message || "Your trial has ended. Subscribe to keep generating lessons.");
                        showUpgradePrompt();
                        return null;
                    }
                    if (status === 429) {
                        showError(payload.message || "Daily limit reached. Try again tomorrow.");
                        return null;
                    }

                    showError(payload.message || payload.error || `HTTP ${status || 'error'}`);
                    return null;

                } catch (error) {
                    console.error('Network error:', error);
                    if (attempt < retries) {
                        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
                        continue;
                    }
                    showError("Connection problem. Check your internet and try again.");
                    return null;
                }
            }
            return null;
        }

        async function extractConceptsFromPDF(file) {
            if (!window.pdfjsLib) throw new Error('PDF_READER_UNAVAILABLE');
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            let text = '';

            for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                text += textContent.items.map(item => item.str).join(' ') + '\n';
            }

            return text;
        }

        async function generateLessonPath(text) {
            showMessage("Analyzing your material...");

            // How much of the document is read, and how many concepts come back,
            // are both tier decisions. The server rewrites the count to the tier's
            // number anyway — asking for it here just means the prompt says what
            // is actually about to happen.
            const plan = await ensurePlan();

            const extractPrompt = `Analyse the study material below and extract its key concepts.

MATERIAL:
${text.substring(0, plan.readChars)}

TASK:
1. Identify exactly ${plan.lessonsPerCourse} core concepts a learner must understand from this material.
2. Order them by logical progression — prerequisites first.
3. For each concept give:
   - name (1-4 words)
   - description (one sentence)
   - difficulty (1-5)
   - why it matters

Return valid JSON only (no markdown, no surrounding prose), in exactly this shape:
{
  "courseName": "Course title",
  "language": "The language of the MATERIAL above, as an English name (e.g. English, Hebrew, Spanish)",
  "concepts": [
    {
      "id": 1,
      "name": "Concept name",
      "description": "One-sentence description",
      "difficulty": 2,
      "importance": "Why this matters",
      "examples": ["Example 1", "Example 2"]
    }
  ]
}

LANGUAGE: write every string above in the same language as the MATERIAL.
If the material is in Hebrew, write in Hebrew. If Spanish, Spanish. Do not translate.`;

            const result = await callAI(extractPrompt, '', { maxTokens: MAX_TOKENS.path, task: 'path' });
            if (!result) return null;

            const data = extractJSON(result);
            if (!data || !Array.isArray(data.concepts) || !data.concepts.length) {
                console.error('Could not parse course structure. Truncated:', lastCallTruncated, result);
                showError(lastCallTruncated ? "The response was cut off. Try a shorter piece of text." : "The model returned an invalid course structure. Try again.");
                return null;
            }
            // A truncated response still yields usable concepts — keep the valid ones.
            // A truncated tail can leave a name-only husk. Require real content.
            data.concepts = data.concepts.filter(c => c && c.name && c.description);
            return data;
        }

        // The course is written in whatever language the source material used.
        // Everything downstream — lessons, tutor, feedback — must follow suit.
        function courseLanguage() {
            if (courseData?.language) return courseData.language;
            // The model didn't report one. Guess from the concept names.
            const sample = (courseData?.concepts || []).map(c => c.name).join(' ');
            if (/[\u0590-\u05FF]/.test(sample)) return 'Hebrew';
            if (/[\u0600-\u06FF]/.test(sample)) return 'Arabic';
            if (/[\u0400-\u04FF]/.test(sample)) return 'Russian';
            // Kana first: Japanese also uses kanji, which sit in the CJK block.
            if (/[\u3040-\u30FF]/.test(sample)) return 'Japanese';
            if (/[\uAC00-\uD7AF]/.test(sample)) return 'Korean';
            if (/[\u4E00-\u9FFF]/.test(sample)) return 'Chinese';
            return 'English';
        }

        function languageRule() {
            return `Write everything in ${courseLanguage()}. Do not switch languages or translate.`;
        }

        const RTL_LANGUAGES = ['Hebrew', 'Arabic', 'Persian', 'Farsi', 'Urdu'];

        function isRTL() {
            return RTL_LANGUAGES.includes(courseLanguage());
        }

        // The UI chrome stays LTR; only the generated content flips.
        function applyContentDirection() {
            const dir = isRTL() ? 'rtl' : 'ltr';
            ['lessonExplanation', 'lessonScroll', 'lessonPath', 'tutorResponse'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.setAttribute('dir', dir);
            });
            const preview = document.getElementById('previewCard');
            if (preview) preview.setAttribute('dir', dir);
        }

        async function generateLesson(concept) {
            // Ground the lesson in the actual document, not the model's priors.
            // How long a passage that may be is the tier's call, so the plan has
            // to be known before the excerpt is built, not after.
            await ensurePlan();
            const excerpt = retrieveExcerpt(concept, getSourceText());

            const prompt = `You are an excellent teacher building an interactive lesson in the style of Duolingo and Brilliant, about: "${concept.name}"

Description: ${concept.description}
Why it matters: ${concept.importance}
${excerpt ? `
SOURCE MATERIAL — this is the passage from the learner's own document where this concept appears:
"""
${excerpt}
"""

GROUNDING RULES (these override everything else):
- Every fact, number, date, name, definition and example must come from the SOURCE MATERIAL above.
- Quiz questions must be answerable from the SOURCE MATERIAL alone. Never test outside knowledge.
- If the source states a specific figure or rule, use that exact figure or rule.
- Do not add facts the source does not contain. If the source is thin on something, teach less rather than invent.
- Wrong answer options should be plausible misreadings of the source, not facts from elsewhere.
` : ''}
${languageRule()}

Principles:
- Never a wall of text. Each card = ONE idea, 2-3 sentences.
- Assume no prior knowledge.
- Open with curiosity, not a definition.
- Questions test real understanding. Distractors must be mistakes a real learner would make.
- Vary the position of the correct answer. Never always first.

VISUALS: wherever a diagram would genuinely aid understanding, attach one to that card.
Choose the type that fits the content. Omit the "visual" field entirely if a diagram adds nothing.

Visual types:
  "flow"    — a process or sequence.        { "type":"flow", "steps":["Step one","Step two","Step three"] }
  "compare" — two things side by side.      { "type":"compare", "left":{"title":"A","points":["..."]}, "right":{"title":"B","points":["..."]} }
  "hierarchy" — a concept and its parts.    { "type":"hierarchy", "root":"Main idea", "children":["Part one","Part two"] }
  "timeline" — events in order.             { "type":"timeline", "events":[{"label":"1990","text":"What happened"}] }
  "table"   — structured facts.             { "type":"table", "headers":["Col A","Col B"], "rows":[["a1","b1"],["a2","b2"]] }
  "bar"     — comparing quantities.         { "type":"bar", "unit":"%", "bars":[{"label":"X","value":40},{"label":"Y","value":75}] }

Keep visual labels short — under 6 words each. 2-5 items per visual.

Return valid JSON only (no markdown, no surrounding prose):

{
  "title": "${concept.name}",
  "estimatedMinutes": 6,
  "hook": { "text": "A surprising question or fact that creates curiosity. 1-2 sentences. Not a definition." },
  "prediction": {
    "question": "A guess-before-we-explain question. Not graded, just provokes thought.",
    "options": ["Guess A", "Guess B", "Guess C"]
  },
  "cards": [
    { "idea": "Short heading", "text": "2-3 sentences explaining ONE idea", "analogy": "An everyday analogy, or null", "visual": null }
  ],
  "workedExample": {
    "problem": "A concrete problem with numbers or a real situation",
    "steps": [ { "action": "What you do at this step", "why": "Why it is correct" } ],
    "answer": "The final answer",
    "visual": null
  },
  "practice": {
    "problem": "A similar problem the learner solves alone",
    "hint": "A hint, revealed only on request",
    "options": ["A","B","C","D"],
    "correct": 0,
    "feedback": { "correct": "Why this is right", "incorrect": "The common mistake here, and why it is wrong" }
  },
  "quiz": [
    // Choose the BEST interaction type for each concept. Mix at least 3 different
    // types across the 4-5 questions. Never repeat the same type twice in a row.
    // Every type needs an "explanation". Pick from:
    //
    // choice   — one right answer among options.
    //   { "type":"choice", "text":"Question", "options":["A","B","C","D"], "correct":0, "explanation":"..." }
    //
    // boolean  — a statement that is true or false.
    //   { "type":"boolean", "text":"A claim to judge", "answer":true, "explanation":"..." }
    //
    // order    — arrange items into the correct sequence (steps, chronology, size).
    //   { "type":"order", "text":"Put these in order", "items":["first","second","third"], "explanation":"..." }
    //   (list items in the CORRECT order; the app shuffles them for the learner)
    //
    // categorize — sort items into buckets.
    //   { "type":"categorize", "text":"Sort these", "buckets":["Group A","Group B"],
    //     "items":[{"text":"thing","bucket":"Group A"}], "explanation":"..." }
    //
    // blank    — fill the gap by choosing the right word. Use ___ in the sentence.
    //   { "type":"blank", "text":"Water boils at ___ degrees.", "options":["50","100","200"], "correct":1, "explanation":"..." }
    //
    // match    — pair items from two columns.
    //   { "type":"match", "text":"Match each to its partner",
    //     "pairs":[{"left":"Heart","right":"Pumps blood"}], "explanation":"..." }
    //
    // mistake  — find the one wrong statement among several correct ones.
    //   { "type":"mistake", "text":"Which statement is WRONG?", "options":["true1","FALSE one","true2"], "correct":1, "explanation":"..." }
    //
    // Every fact must come from the SOURCE MATERIAL. Distractors must be plausible
    // misreadings of the source, not facts from elsewhere.
    { "type":"choice", "text":"Question", "options":["A","B","C","D"], "correct":0, "explanation":"..." }
  ],
  "challenge": {
    // The capstone. Combine several ideas. Use any question type from the quiz
    // list above (include its "type" field and matching fields).
    "type": "choice",
    "text": "One larger problem combining several ideas from this lesson",
    "options": ["A","B","C","D"],
    "correct": 0,
    "explanation": "A full explanation of the solution"
  },
  "summary": {
    "mainIdea": "The central idea in one sentence",
    "keyFacts": ["Fact 1", "Fact 2", "Fact 3"],
    "commonMistake": "The most common mistake",
    "realWorld": "Where this shows up in daily life",
    "visual": null
  },
  "memoryCheck": { "prompt": "Explain this concept as if teaching a friend." }
}

Quantities: 3-5 cards. 3-4 steps in workedExample. 4-5 quiz questions using a MIX of types.
At least TWO cards should carry a visual. All fields required. "correct" is a 0-based index.
Prefer interactive types (order, categorize, match, blank) over plain choice where the content suits them.
${languageRule()}`;

            const result = await callAI(prompt, '', { maxTokens: MAX_TOKENS.lesson, task: 'lesson' });

            // callAI returns null when it already reported an error, and '' when
            // the model replied with nothing usable. The empty case used to fall
            // through in silence — the spinner vanished and nothing happened.
            if (result === null) return null;
            if (!result.trim()) {
                console.error('Model returned no text for this lesson.');
                showError("The model returned an empty response. Try again.");
                return null;
            }

            const lesson = extractJSON(result);
            if (!lesson) {
                console.error('Could not parse lesson. Truncated:', lastCallTruncated, result);
                showError(lastCallTruncated
                    ? "The lesson was cut off before it finished. Try again."
                    : "The model returned an invalid lesson. Try again.");
                return null;
            }

            const normalised = normaliseLesson(lesson, concept);

            // A truncated response can parse into a husk with no teachable content.
            // Rendering that gives an empty lesson that jumps straight to "complete".
            const contentSteps = normalised.cards.length + normalised.quiz.length
                + (normalised.hook ? 1 : 0) + (normalised.workedExample ? 1 : 0)
                + (normalised.practice ? 1 : 0) + (normalised.challenge ? 1 : 0);
            if (contentSteps < 2) {
                console.error('Lesson has too little content to teach:', normalised);
                showError(lastCallTruncated
                    ? "The lesson was cut off before it finished. Try again."
                    : "The model returned an incomplete lesson. Try again.");
                return null;
            }

            return normalised;
        }

        // Validate one question of any type. Returns a clean question or null.
        // A malformed question is dropped rather than crashing the lesson.
        function normaliseQuestion(q) {
            if (!q || !q.text) return null;
            const arr = v => Array.isArray(v) ? v : [];
            const clamp = (i, n) => (Number.isInteger(i) && i >= 0 && i < n) ? i : 0;
            // Legacy questions had no type; treat them as choice.
            const type = q.type || 'choice';

            switch (type) {
                case 'choice':
                case 'blank':
                case 'mistake': {
                    const options = arr(q.options).filter(o => o != null).map(String);
                    if (options.length < 2) return null;
                    return { type, text: String(q.text), options,
                             correct: clamp(q.correct, options.length),
                             explanation: q.explanation || '' };
                }
                case 'boolean': {
                    if (typeof q.answer !== 'boolean') return null;
                    return { type, text: String(q.text), answer: q.answer,
                             explanation: q.explanation || '' };
                }
                case 'order': {
                    const items = arr(q.items).filter(o => o != null).map(String);
                    if (items.length < 2) return null;
                    return { type, text: String(q.text), items,   // stored in correct order
                             explanation: q.explanation || '' };
                }
                case 'categorize': {
                    const buckets = arr(q.buckets).filter(o => o != null).map(String);
                    const items = arr(q.items)
                        .filter(it => it && it.text != null && buckets.includes(it.bucket))
                        .map(it => ({ text: String(it.text), bucket: String(it.bucket) }));
                    if (buckets.length < 2 || items.length < 2) return null;
                    return { type, text: String(q.text), buckets, items,
                             explanation: q.explanation || '' };
                }
                case 'match': {
                    const pairs = arr(q.pairs)
                        .filter(p => p && p.left != null && p.right != null)
                        .map(p => ({ left: String(p.left), right: String(p.right) }));
                    if (pairs.length < 2) return null;
                    return { type, text: String(q.text), pairs,
                             explanation: q.explanation || '' };
                }
                default:
                    // Unknown type: salvage as choice if it has options, else drop.
                    if (arr(q.options).length >= 2) {
                        return normaliseQuestion({ ...q, type: 'choice' });
                    }
                    return null;
            }
        }

        // Drop any visual the renderer couldn't draw, before it reaches the UI.
        function validVisual(v) {
            if (!v || typeof v !== 'object' || !v.type) return null;
            const ok = {
                flow: v => Array.isArray(v.steps) && v.steps.filter(Boolean).length >= 2,
                compare: v => v.left && v.right && Array.isArray(v.left.points) && Array.isArray(v.right.points),
                hierarchy: v => v.root && Array.isArray(v.children) && v.children.filter(Boolean).length >= 1,
                timeline: v => Array.isArray(v.events) && v.events.some(e => e && (e.label || e.text)),
                table: v => Array.isArray(v.headers) && v.headers.length
                            && Array.isArray(v.rows) && v.rows.some(r => Array.isArray(r) && r.length),
                bar: v => Array.isArray(v.bars) && v.bars.some(b => b && typeof b.value === 'number' && isFinite(b.value)),
            }[v.type];
            return (ok && ok(v)) ? v : null;
        }

        // Models drift from the schema. Fill gaps so the step engine never crashes.
        function normaliseLesson(l, concept) {
            const arr = v => Array.isArray(v) ? v : [];
            const clampIdx = (i, len) => (Number.isInteger(i) && i >= 0 && i < len) ? i : 0;

            l.title = l.title || concept.name;
            l.estimatedMinutes = l.estimatedMinutes || 6;
            l.hook = l.hook?.text ? l.hook : null;
            l.prediction = (l.prediction?.question && arr(l.prediction.options).length) ? l.prediction : null;
            l.cards = arr(l.cards).filter(c => c && c.text);
            l.cards.forEach(c => { c.visual = validVisual(c.visual); });
            l.workedExample = (l.workedExample?.problem && arr(l.workedExample.steps).length) ? l.workedExample : null;
            if (l.workedExample) l.workedExample.visual = validVisual(l.workedExample.visual);

            if (l.practice && arr(l.practice.options).length) {
                l.practice.correct = clampIdx(l.practice.correct, l.practice.options.length);
                l.practice.feedback = l.practice.feedback || { correct: '', incorrect: '' };
            } else { l.practice = null; }

            l.quiz = arr(l.quiz).map(normaliseQuestion).filter(Boolean);
            l.challenge = normaliseQuestion(l.challenge);

            l.summary = l.summary || null;
            if (l.summary) {
                l.summary.keyFacts = arr(l.summary.keyFacts);
                l.summary.visual = validVisual(l.summary.visual);
            }
            l.memoryCheck = l.memoryCheck?.prompt ? l.memoryCheck : null;

            return l;
        }

        // The tutor sees the current lesson, where you are in it, and how you're
        // doing. Preset actions cost nothing to type and keep prompts short.
        const TUTOR_ACTIONS = [
            { id: 'simpler',   label: 'Explain more simply',  ask: 'Explain this more simply, as if to a complete beginner.' },
            { id: 'deeper',    label: 'Go deeper',            ask: 'Explain this in more depth. What is really going on underneath?' },
            { id: 'example',   label: 'Another example',      ask: 'Give me a different example of this concept.' },
            { id: 'realworld', label: 'Real-world use',       ask: 'Where does this show up in real life? Give a concrete case.' },
            { id: 'practice',  label: 'Practice question',    ask: 'Give me one practice question on this, with the answer hidden until I ask.' },
            { id: 'harder',    label: 'Harder challenge',     ask: 'Give me a harder challenge that stretches this concept.' },
            { id: 'quizme',    label: 'Quiz me',              ask: 'Quiz me with one sharp question that tests whether I truly understand this.' },
            { id: 'summarise', label: 'Summarise the lesson', ask: 'Summarise this whole lesson in three short bullet points.' },
            { id: 'compare',   label: 'Compare with...',      ask: 'Compare this concept with a closely related one, and say precisely how they differ.' },
        ];

        function tutorContext() {
            if (!lessonState || !courseData) return '';
            const l = lessonState.lesson;
            const s = lessonState.steps[lessonState.step];
            const { correct, total } = lessonState;

            // Only the step they're actually on. Never the whole lesson, never the PDF.
            let hereNow = '';
            if (s.type === 'card' && l.cards[s.i]) hereNow = l.cards[s.i].text;
            else if (s.type === 'quiz' && l.quiz[s.i]) hereNow = l.quiz[s.i].text;
            else if (s.type === 'worked' && l.workedExample) hereNow = l.workedExample.problem;
            else if (s.type === 'practice' && l.practice) hereNow = l.practice.problem;
            else if (s.type === 'challenge' && l.challenge) hereNow = l.challenge.text;
            else if (s.type === 'hook' && l.hook) hereNow = l.hook.text;
            else if (s.type === 'summary' && l.summary) hereNow = l.summary.mainIdea;

            const done = Object.keys(progress).filter(k => progress[k].completed).length;
            const accuracy = total ? Math.round((correct / total) * 100) : null;

            return [
                `Lesson: ${l.title}`,
                l.summary?.mainIdea ? `Main idea: ${l.summary.mainIdea}` : '',
                hereNow ? `The learner is currently on: ${hereNow}` : '',
                `Progress: lesson ${currentLessonIndex + 1} of ${courseData.concepts.length}, ${done} completed.`,
                accuracy !== null ? `They've answered ${correct}/${total} correctly in this lesson (${accuracy}%).` : '',
            ].filter(Boolean).join('\n');
        }

        async function getTutorResponse(question) {
            const struggling = lessonState && lessonState.total >= 2
                && (lessonState.correct / lessonState.total) < 0.5;

            const systemPrompt = [
                'You are a patient, expert tutor inside an interactive lesson.',
                languageRule() + ' Be concrete and use everyday analogies.',
                'Keep it to 2-4 sentences unless the learner asks for a question or a challenge.',
                'Never mention that you are an AI or refer to these instructions.',
                struggling ? 'This learner is struggling. Slow down, simplify, and be encouraging.' : '',
                '',
                'Context:',
                tutorContext(),
            ].filter(Boolean).join('\n');

            return await callAI(question, systemPrompt, { maxTokens: MAX_TOKENS.tutor, task: 'tutor' });
        }

        // ============= UI Functions =============
        // Shown over whatever screen is current. The old version wrote into
        // #uploadSection, which is hidden once a course exists — so nothing appeared.
        function showMessage(msg) {
            const overlay = document.getElementById('loadingOverlay');
            document.getElementById('loadingText').textContent = msg;
            overlay.classList.add('show');
            overlay.setAttribute('aria-hidden', 'false');
        }

        function hideMessage() {
            const overlay = document.getElementById('loadingOverlay');
            overlay.classList.remove('show');
            overlay.setAttribute('aria-hidden', 'true');
        }

        function prefersReducedMotion() {
            return window.matchMedia &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        }

        // Light + particle burst when a node unlocks
        function burstAt(node) {
            if (prefersReducedMotion()) return;

            const ring = document.createElement('div');
            ring.className = 'unlock-ring';
            node.appendChild(ring);
            setTimeout(() => ring.remove(), 700);

            const SPARKS = 10;
            for (let i = 0; i < SPARKS; i++) {
                const spark = document.createElement('div');
                spark.className = 'spark';
                const angle = (Math.PI * 2 * i) / SPARKS + Math.random() * 0.4;
                const dist = 42 + Math.random() * 28;
                spark.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
                spark.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
                spark.style.animationDelay = `${Math.random() * 0.08}s`;
                node.appendChild(spark);
                setTimeout(() => spark.remove(), 850);
            }
        }

        // Keep the active lesson centred as you travel the path
        function scrollToCurrentNode() {
            const container = document.querySelector('.path-container');
            const node = document.querySelector('.lesson-node.current');
            if (!container || !node) return;
            const offset = node.offsetTop - container.clientHeight / 2 + node.offsetHeight / 2;
            container.scrollTo({
                top: Math.max(0, offset),
                behavior: prefersReducedMotion() ? 'auto' : 'smooth'
            });
        }

        // ============= Dialogs & toasts =============
        // In-app replacements for alert/confirm/prompt. The native ones can't be
        // styled, ignore the content's direction, block the whole tab, and read as a
        // browser warning rather than as part of the app.

        const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

        // Keeps focus inside `container` while it's open, and hands focus back to
        // whatever opened it on close — otherwise a keyboard user tabs into the page
        // behind the dialog and can never get out.
        function trapFocus(container, firstFocus) {
            const restoreTo = document.activeElement;
            const onKey = (e) => {
                if (e.key !== 'Tab') return;
                const items = [...container.querySelectorAll(FOCUSABLE)]
                    .filter(el => !el.hidden && !el.disabled && el.offsetParent !== null);
                if (!items.length) return;
                const first = items[0], last = items[items.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            };
            document.addEventListener('keydown', onKey, true);
            (firstFocus || container.querySelector(FOCUSABLE))?.focus();
            return () => {
                document.removeEventListener('keydown', onKey, true);
                if (restoreTo && document.contains(restoreTo)) restoreTo.focus();
            };
        }

        // A dialog is open while its promise is pending; nothing else may open one.
        let dialogRelease = null;

        function openDialog({ title, body = '', confirmText = 'OK', cancelText = null,
                              danger = false, input = null, validate = null }) {
            const backdrop = document.getElementById('dialogBackdrop');
            const card = document.getElementById('dialogCard');
            const field = document.getElementById('dialogInput');
            const errorEl = document.getElementById('dialogError');
            const confirmBtn = document.getElementById('dialogConfirm');
            const cancelBtn = document.getElementById('dialogCancel');

            document.getElementById('dialogTitle').textContent = title;
            document.getElementById('dialogBody').textContent = body;
            confirmBtn.textContent = confirmText;
            confirmBtn.classList.toggle('reset-button', danger);
            card.classList.toggle('dialog-danger', danger);
            cancelBtn.hidden = cancelText === null;
            cancelBtn.textContent = cancelText || 'Cancel';
            errorEl.hidden = true;
            errorEl.textContent = '';

            const wantsInput = input !== null;
            field.hidden = !wantsInput;
            field.value = wantsInput ? input : '';
            // The dialog carries user content, so it follows the content's direction
            // rather than the app chrome's — a Hebrew course name must read correctly.
            card.dir = RTL_LANGUAGES.includes(courseData?.language) ? 'rtl' : 'ltr';

            backdrop.classList.add('active');
            lockBodyScroll(true);

            return new Promise((resolve) => {
                const finish = (value) => {
                    if (!dialogRelease) return;
                    dialogRelease();
                    dialogRelease = null;
                    backdrop.classList.remove('active');
                    lockBodyScroll(false);
                    document.removeEventListener('keydown', onKey, true);
                    confirmBtn.onclick = cancelBtn.onclick = backdrop.onclick = null;
                    resolve(value);
                };
                const submit = () => {
                    if (!wantsInput) return finish(true);
                    const problem = validate ? validate(field.value) : null;
                    if (problem) {
                        errorEl.textContent = problem;
                        errorEl.hidden = false;
                        field.focus();
                        return;
                    }
                    finish(field.value);
                };
                const cancel = () => finish(wantsInput ? null : false);

                const onKey = (e) => {
                    if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
                    else if (e.key === 'Enter' && (wantsInput || document.activeElement !== cancelBtn)) {
                        e.preventDefault(); e.stopPropagation(); submit();
                    }
                };
                document.addEventListener('keydown', onKey, true);

                confirmBtn.onclick = submit;
                cancelBtn.onclick = cancel;
                // Tapping the dimmed area behind the card cancels, as every other
                // overlay in this app already does.
                backdrop.onclick = (e) => { if (e.target === backdrop) cancel(); };

                dialogRelease = trapFocus(card, wantsInput ? field : confirmBtn);
                if (wantsInput) field.select();
            });
        }

        const uiAlert = (body, title = 'Heads up') =>
            openDialog({ title, body, confirmText: 'Got it' });

        const uiConfirm = (title, body, { confirmText = 'Confirm', danger = false } = {}) =>
            openDialog({ title, body, confirmText, cancelText: 'Cancel', danger });

        const uiPrompt = (title, value, { validate = null, confirmText = 'Save' } = {}) =>
            openDialog({ title, input: value || '', confirmText, cancelText: 'Cancel', validate });

        // A modal is open: stop the page behind it from scrolling under the finger.
        // Counted, because a confirm dialog can open on top of the auth modal — the
        // inner one closing must not unlock the page while the outer one is still up.
        let scrollLocks = 0;
        function lockBodyScroll(on) {
            scrollLocks = Math.max(0, scrollLocks + (on ? 1 : -1));
            document.body.style.overflow = scrollLocks > 0 ? 'hidden' : '';
        }

        // Brief confirmation for things that worked. Never blocks, never covers the
        // header, disappears on its own.
        function toast(message, kind = 'success') {
            const stack = document.getElementById('toastStack');
            if (!stack) return;
            const el = document.createElement('div');
            el.className = `toast toast-${kind}`;
            el.textContent = message;
            stack.appendChild(el);
            setTimeout(() => {
                el.classList.add('leaving');
                setTimeout(() => el.remove(), 200);
            }, 2600);
        }

        function showError(msg) {
            hideMessage();          // never leave the spinner up behind the dialog
            uiAlert(msg, 'Something went wrong');
        }

        // Return the app to a usable state after any failure.
        function resetToUpload() {
            hideMessage();
            closeLessonScreen();
            closePreview();
            document.getElementById('learningPath').classList.remove('active');
            document.getElementById('sourcePicker').hidden = false;
            document.getElementById('backToLibraryBtn').hidden = library.length === 0;
        }

        async function handleFileUpload(file) {
            // Name the file being read. "Reading PDF..." after picking the wrong one
            // from a list of near-identical names gives you nothing to check against.
            showMessage(`Reading ${file.name}...`);
            let text;
            try {
                text = await extractConceptsFromPDF(file);
            } catch (err) {
                console.error('PDF read error:', err);
                hideMessage();
                showError(err.message === 'PDF_READER_UNAVAILABLE'
                    ? "The PDF reader didn't load. Check your connection and try again, or paste the text instead."
                    : "Couldn't read that file. Make sure it's a valid PDF.");
                return;
            }
            if (!text || text.trim().length < 100) {
                hideMessage();
                showError("No text found in that file. It may be a scanned PDF with no text layer.");
                return;
            }
            await processLearningMaterial(text, file.name.replace(/\.[^/.]+$/, ''));
        }

        // A course name has to contain something readable. A filename like "-.pdf",
        // or a model that answers with a stray dash, otherwise ends up as the course's
        // whole title — a card labelled "-" with no way to fix it.
        function cleanTitle(raw) {
            const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
            // \p{L}\p{N} so Hebrew/Arabic/Cyrillic titles count as real text too.
            return /[\p{L}\p{N}]/u.test(s) ? s.slice(0, 80) : '';
        }

        // Whatever the learner typed into the "Course name" box, if anything.
        function requestedCourseName() {
            const input = document.getElementById('courseNameInput');
            return input ? cleanTitle(input.value) : '';
        }

        // `title` is the fallback (filename, or nothing for pasted text); a name the
        // learner typed themselves always beats both that and the model's suggestion.
        async function processLearningMaterial(text, title = '', chosenName = requestedCourseName()) {
            // The point of need: building a course is the first thing that
            // actually requires an account. Resume automatically after sign-up.
            if (!currentUser) {
                pendingAction = { type: 'buildCourse', text, title, chosenName };
                showAuthModal('signup');
                return;
            }
            showMessage("Generating a personalised learning path...");
            try {
                const course = await generateLessonPath(text);
                if (!course) {
                    resetToUpload();   // error already surfaced; give them a way back
                    return;
                }

                course.courseName = chosenName
                    || cleanTitle(course.courseName)
                    || cleanTitle(title)
                    || 'Untitled course';
                const id = await saveCourse(course, text);
                if (!id) return;

                const nameInput = document.getElementById('courseNameInput');
                if (nameInput) nameInput.value = '';   // don't reuse it for the next course

                courseData = course;
                activeCourseId = id;
                activeSourceText = text;
                progress = {};
                localStorage.setItem(ACTIVE_STORAGE, id);

                applyContentDirection();
                document.getElementById('sourcePicker').hidden = true;
                document.getElementById('libraryScreen').hidden = true;
                document.getElementById('learningPath').classList.add('active');
                displayLearningPath();
                // Land on the path, not inside a lesson. The user picks where to start.
            } finally {
                hideMessage();
            }
        }

        // Concepts are grouped into fixed-size units purely for the path's visual
        // rhythm (a banner every N nodes, a star node ending each unit) — the
        // underlying course/progress data has no notion of units.
        const UNIT_SIZE = 5;
        const UNIT_COLORS = ['#58CC02', '#1CB0F6', '#CE82FF', '#FF9600', '#FF4B4B'];

        function displayLearningPath() {
            document.getElementById('sourcePicker').hidden = true;
            document.getElementById('learningPath').classList.add('active');
            setActiveNav('home');

            // Update stats
            document.getElementById('courseTitle').textContent = courseData.courseName || 'Learning Path';
            document.getElementById('totalLessons').textContent = courseData.concepts.length;
            updateProgress();
            renderHud();

            // Build path
            const pathContainer = document.getElementById('lessonPath');
            const previouslyUnlocked = new Set(
                [...pathContainer.querySelectorAll('.lesson-node')]
                    .map((n, i) => (!n.classList.contains('locked') ? i : -1))
                    .filter(i => i >= 0)
            );
            const hadNodes = pathContainer.children.length > 0;
            pathContainer.innerHTML = '';

            courseData.concepts.forEach((concept, index) => {
                if (index % UNIT_SIZE === 0) {
                    const unitNum = Math.floor(index / UNIT_SIZE) + 1;
                    const banner = document.createElement('div');
                    banner.className = 'unit-banner';
                    banner.style.background = UNIT_COLORS[(unitNum - 1) % UNIT_COLORS.length];
                    banner.innerHTML = `
                        <div class="unit-banner-label">Unit ${unitNum}</div>
                        <div class="unit-banner-title">${esc(concept.name)}</div>`;
                    pathContainer.appendChild(banner);
                }

                const isCheckpoint = (index + 1) % UNIT_SIZE === 0 || index === courseData.concepts.length - 1;

                const node = document.createElement('div');
                node.className = 'lesson-node';
                node.classList.add('locked');
                if (isCheckpoint) node.classList.add('checkpoint');

                if (progress[index] && progress[index].completed) {
                    node.classList.remove('locked');
                    node.classList.add('completed');
                }

                if (index === currentLessonIndex) {
                    node.classList.remove('locked');
                    node.classList.remove('completed');
                    node.classList.add('current');
                }

                const dueNow = isDueForReview(index);
                // Real Duolingo nodes don't show sequence numbers: locked shows a
                // padlock, a finished regular lesson shows a check, everything else
                // (the current node, and any checkpoint) shows a star.
                let icon;
                if (node.classList.contains('locked')) icon = ICONS.lock;
                else if (node.classList.contains('completed') && !isCheckpoint) icon = ICONS.check;
                else icon = ICONS.star;

                node.innerHTML = `
                    <div class="lesson-circle">
                        <span>${icon}</span>
                        ${dueNow ? '<span class="due-dot" title="Due for review"></span>' : ''}
                    </div>
                    <div class="lesson-label">${concept.name.substring(0, 18)}</div>
                `;

                // Celebrate nodes that just became available
                const nowUnlocked = !node.classList.contains('locked');
                if (hadNodes && nowUnlocked && !previouslyUnlocked.has(index)) {
                    node.classList.add('unlocking');
                    burstAt(node);
                    setTimeout(() => node.classList.remove('unlocking'), 700);
                }

                node.onclick = () => openPreview(index);
                pathContainer.appendChild(node);
            });

            renderReviewBanner();
            requestAnimationFrame(scrollToCurrentNode);
        }

        // ============= Spaced repetition =============
        // Pure logic, no AI calls. A lightweight SM-2: each completion (first pass
        // or a later review) schedules the next one further out, unless the
        // learner did poorly, in which case it resets to daily.
        function isDueForReview(index) {
            const srs = progress[index]?.srs;
            return !!(progress[index]?.completed && srs && srs.dueAt <= Date.now());
        }

        function scheduleReview(index, accuracyPct) {
            if (!progress[index]) progress[index] = {};
            const srs = progress[index].srs || { ease: 2.5, interval: 0, reps: 0 };

            // Map accuracy onto SM-2's 0-5 quality scale.
            const quality = accuracyPct >= 90 ? 5 : accuracyPct >= 75 ? 4
                : accuracyPct >= 60 ? 3 : accuracyPct >= 40 ? 2 : 1;

            if (quality < 3) {
                srs.reps = 0;
                srs.interval = 1;
            } else {
                srs.reps++;
                if (srs.reps === 1) srs.interval = 1;
                else if (srs.reps === 2) srs.interval = 6;
                else srs.interval = Math.round(srs.interval * srs.ease);
                srs.ease = Math.max(1.3, srs.ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
            }

            srs.dueAt = Date.now() + srs.interval * 86400000;
            srs.lastReviewed = Date.now();
            progress[index].srs = srs;
        }

        function getDueLessons() {
            if (!courseData) return [];
            return courseData.concepts
                .map((_, i) => i)
                .filter(i => isDueForReview(i) && progress[i]?.lesson);
        }

        function renderReviewBanner() {
            const banner = document.getElementById('reviewBanner');
            if (!banner) return;
            const due = getDueLessons();
            banner.hidden = due.length === 0;
            if (due.length) {
                document.getElementById('reviewBannerText').textContent = due.length === 1
                    ? '1 lesson is due for review'
                    : `${due.length} lessons are due for review`;
            }
            const dot = document.getElementById('navReviewDot');
            if (dot) dot.hidden = due.length === 0;
        }

        // Pull 1-2 cached quiz questions per due lesson. Reuses the questions the
        // learner already generated and paid for — a review session costs nothing.
        function buildReviewSteps() {
            const items = [];
            getDueLessons().forEach(idx => {
                const lesson = progress[idx].lesson;
                const pool = [...(lesson.quiz || [])];
                if (lesson.challenge) pool.push(lesson.challenge);
                if (!pool.length) return;
                shuffle(pool).slice(0, 2).forEach(question => items.push({ lessonIndex: idx, question }));
            });
            return shuffle(items);
        }

        function startReviewSession() {
            const items = buildReviewSteps();
            if (!items.length) return;

            const steps = items.map((_, i) => ({ type: 'reviewq', i }));
            steps.push({ type: 'reviewComplete' });

            lessonState = {
                lesson: { title: 'Review session' },
                steps, step: 0,
                correct: 0, total: 0,
                heartsLeft: 5,
                startedAt: Date.now(),
                review: { items, byLesson: {} },
                result: null,
            };

            document.getElementById('sourcePicker').hidden = true;
            document.getElementById('lessonXpBadge').textContent = `${items.length} questions`;
            document.getElementById('lessonMeta').innerHTML = `<span class="meta-chip">${ICONS.refresh} Spaced repetition</span>`;
            applyContentDirection();
            buildStepSegments(steps.length);
            renderHearts();
            openLessonScreen();
            renderStep();
        }

        function commitReviewResult() {
            const { byLesson } = lessonState.review;
            Object.entries(byLesson).forEach(([idx, stat]) => {
                const accuracy = stat.total ? Math.round((stat.correct / stat.total) * 100) : 100;
                scheduleReview(Number(idx), accuracy);
            });
            saveProgress();
            bumpStreak();
            renderHud();
            return { lessonsReviewed: Object.keys(byLesson).length, correct: lessonState.correct, total: lessonState.total };
        }

        // ============= Duolingo-style HUD: streak, gems, hearts =============
        const STREAK_STORAGE = 'streak_data';   // { count, lastActive: 'YYYY-MM-DD' }

        function todayStr(offsetDays = 0) {
            return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
        }

        function getStreak() {
            const data = JSON.parse(localStorage.getItem(STREAK_STORAGE) || 'null');
            if (!data) return 0;
            // The streak is only "alive" if the learner showed up today or yesterday.
            if (data.lastActive !== todayStr() && data.lastActive !== todayStr(-1)) return 0;
            return data.count;
        }

        // Call once per completed lesson/review. Consecutive calendar days extend
        // the streak; a gap resets it; the same day twice is a no-op.
        function bumpStreak() {
            const today = todayStr();
            const data = JSON.parse(localStorage.getItem(STREAK_STORAGE) || 'null') || { count: 0, lastActive: null };
            if (data.lastActive !== today) {
                data.count = (data.lastActive === todayStr(-1)) ? data.count + 1 : 1;
                data.lastActive = today;
                localStorage.setItem(STREAK_STORAGE, JSON.stringify(data));
            }
        }

        // Gems are a cosmetic currency derived from XP — no separate ledger to keep in sync.
        function renderHud() {
            const streakEl = document.getElementById('hudStreak');
            if (!streakEl) return;
            const totalXp = Object.values(progress).reduce((sum, p) => sum + (p?.xp || 0), 0);
            streakEl.textContent = getStreak();
            document.getElementById('hudXp').textContent = totalXp;
            document.getElementById('hudGems').textContent = Math.floor(totalXp / 20);
        }

        // Build the segmented step-progress pills once we know how many steps a
        // lesson/review has. renderStep() then just toggles .filled/.current.
        function buildStepSegments(total) {
            const bar = document.getElementById('lessonStepBar');
            if (!bar) return;
            bar.innerHTML = Array.from({ length: total }, () => '<div class="step-segment"></div>').join('');
        }

        function updateStepSegments(step, total) {
            const bar = document.getElementById('lessonStepBar');
            if (!bar) return;
            [...bar.children].forEach((seg, i) => {
                seg.classList.toggle('filled', i < step);
                seg.classList.toggle('current', i === step);
            });
        }

        // Hearts are cosmetic feedback, not a hard gate — missing them never
        // blocks progress, it just reflects how clean the run has been so far.
        function renderHearts() {
            const el = document.getElementById('topbarHearts');
            if (!el || !lessonState) return;
            const left = lessonState.heartsLeft ?? 5;
            el.innerHTML = Array.from({ length: 5 }, (_, i) =>
                `<span class="heart${i < left ? '' : ' lost'}">${ICONS.heart}</span>`).join('');
        }

        // ============= Usage & cost tracking =============
        // Per million tokens, by the model the tier's lessons run on. Lessons are
        // where the tokens go — ten to fifteen of them against a single course
        // plan — so Max is priced at Sonnet's rate even though Opus plans its
        // course. `ai_usage` stores one running total with no model attached, so
        // the badge can only ever be an estimate at the current tier's rates;
        // usage from a month on a different plan is priced at today's.
        const PRICES = {
            trial: { in: 1, out: 5 },     // Haiku 4.5
            basic: { in: 1, out: 5 },     // Haiku 4.5
            pro:   { in: 3, out: 15 },    // Sonnet 5
            max:   { in: 3, out: 15 },    // Sonnet 5 writes the lessons; Opus 5 ($5/$25) plans the course
        };

        // The Edge Function increments ai_usage server-side on every real call —
        // the client just reflects it. "cached" (this app's own lesson cache, not
        // an API call at all) is session-only, there's nothing server-side to sync.
        let usage = { calls: 0, inputTokens: 0, outputTokens: 0, cached: 0 };

        // Which tier this account is on. Read from `subscriptions`, which RLS
        // scopes to the signed-in user, so this can only ever return their own
        // row. The same derivation the Edge Function does, for the same reason:
        // an unrecognised plan name falls back to the smallest tier, never the
        // largest, so a bad row can't hand out Max limits.
        async function loadPlan() {
            if (!currentUser) return;
            const { data, error } = await supabaseClient
                .from('subscriptions')
                .select('status, plan, current_period_end')
                .eq('user_id', currentUser.id)
                .maybeSingle();

            if (error) {
                // Keep whatever we had. The server clamps regardless, so the
                // worst case is a shorter document, not a wrong bill.
                console.error('Could not read subscription:', error);
                return;
            }

            const trialing = data?.status === 'trialing' && data.current_period_end &&
                new Date(data.current_period_end) > new Date();
            planKey = trialing ? 'trial' : (data?.plan && PLANS[data.plan] ? data.plan : 'basic');
            currentPlan = PLANS[planKey];
            planLoaded = true;
            renderUsage();
        }

        // Every AI call that spends the document budget goes through here first,
        // so a course built straight after sign-in still uses the right tier.
        async function ensurePlan() {
            if (!planLoaded) await loadPlan();
            return currentPlan;
        }

        async function refreshUsage() {
            if (!currentUser) return;
            const { data } = await supabaseClient
                .from('ai_usage')
                .select('calls, input_tokens, output_tokens')
                .eq('user_id', currentUser.id)
                .maybeSingle();
            if (data) {
                usage.calls = data.calls;
                usage.inputTokens = data.input_tokens;
                usage.outputTokens = data.output_tokens;
            }
            renderUsage();
        }

        function recordCacheHit() {
            usage.cached++;
            renderUsage();
        }

        function totalCost() {
            const price = PRICES[planKey] || PRICES.basic;
            return (usage.inputTokens * price.in + usage.outputTokens * price.out) / 1_000_000;
        }

        function renderUsage() {
            const el = document.getElementById('usageBadge');
            if (!el) return;
            const cost = totalCost();
            el.textContent = (planLoaded ? `${currentPlan.label} · ` : '') +
                `$${cost.toFixed(4)} · ${usage.calls} calls` +
                (usage.cached ? ` · ${usage.cached} cached this session` : '');
            el.title = planLoaded
                ? `${currentPlan.label}: ${currentPlan.lessonsPerCourse} lessons per course, ` +
                  `${currentPlan.readChars.toLocaleString()} characters of your document read per course. ` +
                  `Spend is estimated at ${currentPlan.label} rates.`
                : '';
        }

        // Models wrap JSON in prose or markdown fences, and a truncated response
        // ends mid-object. Rather than throw away a call we already paid for,
        // find the JSON, and if it's cut off, rewind to the last complete element
        // and close the open brackets.
        function extractJSON(raw) {
            if (!raw) return null;

            let s = String(raw).trim();
            s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');

            const start = s.indexOf('{');
            if (start === -1) return null;
            s = s.slice(start);

            // Fast path: already valid, possibly with trailing prose.
            const scan = (str) => {
                const stack = [];
                let inStr = false, esc = false;
                // Positions where a top-level-complete value ends, and where each
                // element of the outermost containers cleanly finishes.
                let closedAt = -1;
                const safePoints = [];
                for (let i = 0; i < str.length; i++) {
                    const c = str[i];
                    if (esc) { esc = false; continue; }
                    if (c === '\\') { esc = true; continue; }
                    if (c === '"') { inStr = !inStr; continue; }
                    if (inStr) continue;
                    if (c === '{' || c === '[') stack.push(c);
                    else if (c === '}' || c === ']') {
                        stack.pop();
                        if (stack.length === 0) closedAt = i;
                        else safePoints.push(i);   // a nested value just closed
                    } else if (c === ',' && stack.length) {
                        safePoints.push(i - 1);    // element before this comma is complete
                    }
                }
                return { stack, inStr, closedAt, safePoints };
            };

            let info = scan(s);
            if (info.closedAt !== -1) {
                try { return JSON.parse(s.slice(0, info.closedAt + 1)); } catch (_) {}
            }

            // Truncated. Rewind to the last point where a value cleanly ended,
            // then close every container still open at that point.
            for (let k = info.safePoints.length - 1; k >= 0; k--) {
                const cut = info.safePoints[k];
                const head = s.slice(0, cut + 1);
                const st = scan(head);
                if (st.inStr) continue;                 // landed inside a string
                const closers = st.stack.slice().reverse()
                    .map(ch => (ch === '{' ? '}' : ']')).join('');
                try { return JSON.parse(head + closers); } catch (_) {}
            }

            return null;
        }

        // ============= Visual renderer =============
        // The model emits a structured spec; we draw it. No image generation,
        // no extra API calls, and the output is deterministic.
        function renderVisual(v) {
            if (!v || !v.type) return '';
            const fns = {
                flow: visFlow, compare: visCompare, hierarchy: visHierarchy,
                timeline: visTimeline, table: visTable, bar: visBar,
            };
            const fn = fns[v.type];
            if (!fn) return '';
            try {
                const inner = fn(v);
                return inner ? `<figure class="visual">${inner}</figure>` : '';
            } catch (err) {
                console.warn('Visual render failed:', v.type, err);
                return '';   // a broken diagram must never break the lesson
            }
        }

        function visFlow(v) {
            const steps = (v.steps || []).filter(Boolean);
            if (steps.length < 2) return '';
            return `<div class="vis-flow">${steps.map((s, i) => `
                <div class="flow-node">
                    <div class="flow-dot">${i + 1}</div>
                    <div class="flow-label">${esc(s)}</div>
                </div>
                ${i < steps.length - 1 ? '<div class="flow-arrow" aria-hidden="true">→</div>' : ''}
            `).join('')}</div>`;
        }

        function visCompare(v) {
            const side = (s, cls) => {
                if (!s) return '';
                const pts = (s.points || []).filter(Boolean);
                return `<div class="cmp-col ${cls}">
                    <div class="cmp-title">${esc(s.title || '')}</div>
                    <ul class="cmp-list">${pts.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
                </div>`;
            };
            if (!v.left || !v.right) return '';
            return `<div class="vis-compare">${side(v.left, 'cmp-a')}<div class="cmp-divider"></div>${side(v.right, 'cmp-b')}</div>`;
        }

        function visHierarchy(v) {
            const kids = (v.children || []).filter(Boolean);
            if (!v.root || !kids.length) return '';
            return `<div class="vis-hierarchy">
                <div class="hier-root">${esc(v.root)}</div>
                <div class="hier-stem" aria-hidden="true"></div>
                <div class="hier-children">${kids.map(c =>
                    `<div class="hier-child"><span class="hier-tick" aria-hidden="true"></span>${esc(c)}</div>`
                ).join('')}</div>
            </div>`;
        }

        function visTimeline(v) {
            const ev = (v.events || []).filter(e => e && (e.label || e.text));
            if (!ev.length) return '';
            return `<div class="vis-timeline">${ev.map(e => `
                <div class="tl-item">
                    <div class="tl-marker" aria-hidden="true"></div>
                    <div class="tl-body">
                        ${e.label ? `<div class="tl-label">${esc(e.label)}</div>` : ''}
                        ${e.text ? `<div class="tl-text">${esc(e.text)}</div>` : ''}
                    </div>
                </div>`).join('')}</div>`;
        }

        function visTable(v) {
            const heads = (v.headers || []).filter(Boolean);
            const rows = (v.rows || []).filter(r => Array.isArray(r) && r.length);
            if (!heads.length || !rows.length) return '';
            return `<div class="vis-table-wrap"><table class="vis-table">
                <thead><tr>${heads.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
                <tbody>${rows.map(r =>
                    `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`
                ).join('')}</tbody>
            </table></div>`;
        }

        function visBar(v) {
            const bars = (v.bars || []).filter(b => b && typeof b.value === 'number' && isFinite(b.value));
            if (!bars.length) return '';
            const max = Math.max(...bars.map(b => Math.abs(b.value)), 1);
            const unit = v.unit || '';
            return `<div class="vis-bar">${bars.map(b => {
                const pct = Math.max(2, Math.round((Math.abs(b.value) / max) * 100));
                return `<div class="bar-row">
                    <div class="bar-label">${esc(b.label || '')}</div>
                    <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
                    <div class="bar-value">${esc(String(b.value))}${esc(unit)}</div>
                </div>`;
            }).join('')}</div>`;
        }

        // ============= Grounding lessons in the source =============
        // The model used to see only a concept name and a one-line description,
        // so it wrote questions from general knowledge. Now each lesson gets the
        // passage of the actual document that concept came from.

        const CHUNK_CHARS = 1200;
        const CHUNK_OVERLAP = 150;
        // Chars of source sent per lesson is a tier limit — see currentPlan.
        // Chunk size is not: it's the granularity retrieval works at, and the
        // same 1,200 chars is the right passage size on every plan. A larger
        // budget buys more chunks, not longer ones.

        // Split on sentence boundaries where possible. A chunk that ends mid-sentence
        // gives the model a fragment it will happily complete from imagination.
        function chunkText(text) {
            const clean = text.replace(/\s+/g, ' ').trim();
            if (clean.length <= CHUNK_CHARS) return clean.length > 80 ? [clean] : [];

            // Sentence enders across scripts: Latin, Hebrew/Arabic, CJK.
            const sentences = clean.match(/[^.!?。！？׃]+[.!?。！？׃]+|\S+$/g) || [clean];

            const chunks = [];
            let cur = '';
            for (const s of sentences) {
                if (cur.length + s.length > CHUNK_CHARS && cur.length > 200) {
                    chunks.push(cur.trim());
                    // Carry a sentence of overlap so a concept straddling the seam
                    // still appears in both chunks.
                    const tail = cur.slice(-CHUNK_OVERLAP);
                    const cut = tail.search(/[.!?。！？׃]\s/);
                    cur = (cut >= 0 ? tail.slice(cut + 2) : '') + s;
                } else {
                    cur += s;
                }
            }
            if (cur.trim().length > 80) chunks.push(cur.trim());
            return chunks;
        }

        // Words too common to carry meaning. Short tokens are dropped anyway,
        // which handles most stopwords in Hebrew, Arabic and Russian too.
        const STOPWORDS = new Set([
            'the','and','for','are','but','not','you','all','can','her','was','one','our',
            'out','has','have','with','this','that','from','they','been','will','would',
            'their','when','which','there','what','about','into','than','then','them','these'
        ]);

        function tokenize(s) {
            return (s || '')
                .toLowerCase()
                .split(/[^\p{L}\p{N}]+/u)
                .filter(w => w.length > 2 && !STOPWORDS.has(w));
        }

        // Classic TF-IDF-ish scoring: rare words that match count for more.
        function buildIndex(chunks) {
            const docFreq = new Map();
            const tokenized = chunks.map(c => {
                const toks = tokenize(c);
                new Set(toks).forEach(t => docFreq.set(t, (docFreq.get(t) || 0) + 1));
                return toks;
            });
            return { chunks, tokenized, docFreq, n: chunks.length };
        }

        function scoreChunk(queryTokens, chunkTokens, index) {
            const counts = new Map();
            chunkTokens.forEach(t => counts.set(t, (counts.get(t) || 0) + 1));
            let score = 0;
            for (const q of queryTokens) {
                const tf = counts.get(q);
                if (!tf) continue;
                const df = index.docFreq.get(q) || 1;
                const idf = Math.log(1 + index.n / df);
                score += (1 + Math.log(tf)) * idf;
            }
            return score;
        }

        // Return the passages most likely to be where this concept was taught.
        function retrieveExcerpt(concept, sourceText) {
            if (!sourceText) return '';

            const EXCERPT_BUDGET = currentPlan.excerptChars;
            const chunks = chunkText(sourceText);
            if (!chunks.length) return '';
            if (chunks.length === 1) return chunks[0].slice(0, EXCERPT_BUDGET);

            const index = buildIndex(chunks);
            const query = tokenize([
                concept.name,
                concept.description,
                concept.importance,
                ...(concept.examples || []),
            ].join(' '));

            if (!query.length) return chunks[0].slice(0, EXCERPT_BUDGET);

            const ranked = index.tokenized
                .map((toks, i) => ({ i, score: scoreChunk(query, toks, index) }))
                .filter(r => r.score > 0)
                .sort((a, b) => b.score - a.score);

            // Nothing matched — the concept may be synthesised across the document.
            if (!ranked.length) return chunks[0].slice(0, EXCERPT_BUDGET);

            // Take the best chunk, then only add more if they are genuinely
            // comparable. Filling the budget blindly drags in neighbouring
            // sections and the model starts quizzing on the wrong chapter.
            const best = ranked[0].score;
            const RELEVANCE_FLOOR = 0.55;   // a chunk must score >=55% of the best

            const picked = [ranked[0].i];
            let budget = EXCERPT_BUDGET - chunks[ranked[0].i].length;

            for (const r of ranked.slice(1)) {
                if (budget <= 0) break;
                if (r.score < best * RELEVANCE_FLOOR) break;   // ranked desc, so we're done
                if (chunks[r.i].length > budget) continue;
                picked.push(r.i);
                budget -= chunks[r.i].length;
            }
            picked.sort((a, b) => a - b);

            // Mark gaps so the model knows the passages are not contiguous.
            let out = '';
            picked.forEach((idx, k) => {
                if (k > 0) out += (idx === picked[k - 1] + 1) ? ' ' : '\n[...]\n';
                out += chunks[idx];
            });
            return out.slice(0, EXCERPT_BUDGET);
        }

        function getSourceText() {
            return activeSourceText;
        }

        // ============= Course library =============
        // Every read is scoped to the caller by RLS — there is no explicit
        // "where user_id = me" needed, the database enforces it either way.
        async function loadLibrary() {
            const { data: courses, error } = await supabaseClient
                .from('courses')
                .select('id, title, language, concepts, created_at')
                .order('created_at', { ascending: false });
            if (error) {
                console.error('loadLibrary failed:', error);
                library = [];
                return library;
            }

            const { data: doneRows } = await supabaseClient
                .from('progress')
                .select('course_id')
                .eq('completed', true);
            const doneCounts = {};
            (doneRows || []).forEach(r => { doneCounts[r.course_id] = (doneCounts[r.course_id] || 0) + 1; });

            library = (courses || []).map(c => ({
                id: c.id,
                title: c.title,
                language: c.language,
                conceptCount: c.concepts.length,
                completedCount: doneCounts[c.id] || 0,
                created: new Date(c.created_at).getTime(),
            }));
            return library;
        }

        // Fire-and-forget from every call site, same as the old localStorage
        // version — nothing awaits it, it just needs to eventually land.
        async function saveProgress() {
            if (!activeCourseId || !currentUser) return;
            const rows = Object.entries(progress).map(([lessonIndex, p]) => ({
                course_id: activeCourseId,
                lesson_index: Number(lessonIndex),
                user_id: currentUser.id,
                completed: !!p.completed,
                accuracy: p.accuracy ?? null,
                xp: p.xp ?? null,
                lesson: p.lesson ?? null,
                srs: p.srs ?? null,
                updated_at: new Date().toISOString(),
            }));
            if (!rows.length) return;
            const { error } = await supabaseClient.from('progress').upsert(rows, { onConflict: 'course_id,lesson_index' });
            if (error) console.error('saveProgress failed:', error);
        }

        async function saveCourse(course, sourceText) {
            const { data, error } = await supabaseClient.from('courses').insert({
                user_id: currentUser.id,
                title: cleanTitle(course.courseName) || 'Untitled course',
                language: course.language || 'English',
                concepts: course.concepts,
                source_text: sourceText || null,
            }).select('id').single();
            if (error) {
                console.error('saveCourse failed:', error);
                showError('Could not save that course: ' + error.message);
                return null;
            }
            await loadLibrary();
            return data.id;
        }

        // Renaming touches three places that each hold their own copy of the title:
        // the row in Supabase, the library list, and the open course in memory.
        async function renameCourse(id, rawTitle) {
            const title = cleanTitle(rawTitle);
            if (!title) {
                showError('A course name needs at least one letter or number.');
                return false;
            }
            const { error } = await supabaseClient.from('courses').update({ title }).eq('id', id);
            if (error) {
                console.error('renameCourse failed:', error);
                showError('Could not rename that course: ' + error.message);
                return false;
            }
            const meta = library.find(c => c.id === id);
            if (meta) meta.title = title;
            if (activeCourseId === id && courseData) {
                courseData.courseName = title;
                const titleEl = document.getElementById('courseTitle');
                if (titleEl) titleEl.textContent = title;
            }
            return true;
        }

        // Shared by the library card's rename button and the course title on the path.
        async function promptRename(id, currentTitle) {
            const next = await uiPrompt('Rename this course', currentTitle, {
                // Validated inside the dialog, so a bad name is corrected in place
                // instead of throwing the user out to a second error dialog.
                validate: (v) => cleanTitle(v) ? null : 'Enter a name with at least one letter or number.',
            });
            if (next === null) return;            // cancelled
            if (cleanTitle(next) === cleanTitle(currentTitle)) return;
            if (await renameCourse(id, next)) toast('Course renamed');
        }

        async function deleteCourse(id) {
            const { error } = await supabaseClient.from('courses').delete().eq('id', id);
            if (error) {
                console.error('deleteCourse failed:', error);
                showError('Could not delete that course.');
                return;
            }
            library = library.filter(c => c.id !== id);
            if (activeCourseId === id) {
                activeCourseId = null;
                courseData = null;
                progress = {};
                activeSourceText = '';
                localStorage.removeItem(ACTIVE_STORAGE);
            }
        }

        async function openCourse(id) {
            const { data: courseRow, error } = await supabaseClient
                .from('courses').select('*').eq('id', id).maybeSingle();
            if (error || !courseRow) { showError('That course could not be found.'); return false; }

            courseData = {
                courseName: courseRow.title,
                language: courseRow.language,
                concepts: courseRow.concepts,
            };
            activeSourceText = courseRow.source_text || '';

            const { data: progRows } = await supabaseClient.from('progress').select('*').eq('course_id', id);
            progress = {};
            (progRows || []).forEach(r => {
                progress[r.lesson_index] = {
                    completed: r.completed, accuracy: r.accuracy, xp: r.xp,
                    lesson: r.lesson, srs: r.srs,
                };
            });

            activeCourseId = id;
            currentLessonIndex = 0;
            localStorage.setItem(ACTIVE_STORAGE, id);

            applyContentDirection();
            document.getElementById('sourcePicker').hidden = true;
            document.getElementById('libraryScreen').hidden = true;
            document.getElementById('learningPath').classList.add('active');
            displayLearningPath();
            return true;
        }

        // ---- Library UI ----
        function courseProgressPct(id) {
            const meta = library.find(c => c.id === id);
            if (!meta?.conceptCount) return 0;
            return Math.round((meta.completedCount / meta.conceptCount) * 100);
        }

        function renderLibrary() {
            const grid = document.getElementById('libraryGrid');
            const empty = document.getElementById('libraryEmpty');
            const count = document.getElementById('libraryCount');

            count.textContent = `${library.length} of ${MAX_COURSES}`;
            empty.hidden = library.length > 0;
            grid.innerHTML = library.map(c => {
                const pct = courseProgressPct(c.id);
                const rtl = RTL_LANGUAGES.includes(c.language);
                return `
                <div class="course-card" data-id="${esc(c.id)}">
                    <button class="course-delete" data-del="${esc(c.id)}" aria-label="Delete course" title="Delete">×</button>
                    <button class="course-rename" data-rename="${esc(c.id)}" aria-label="Rename course" title="Rename">${ICONS.pencil}</button>
                    <div class="course-title" ${rtl ? 'dir="rtl"' : ''}>${esc(c.title)}</div>
                    <div class="course-meta">${c.conceptCount} lessons · ${esc(c.language)}</div>
                    <div class="course-bar"><div class="course-bar-fill" style="width:${pct}%"></div></div>
                    <div class="course-pct">${pct}% complete</div>
                </div>`;
            }).join('');

            grid.querySelectorAll('.course-card').forEach(card => {
                card.onclick = async (e) => {
                    // closest(), not e.target.dataset — a tap usually lands on the
                    // icon's <svg>/<path>, not on the button carrying the data attribute.
                    if (e.target.closest('[data-del], [data-rename]')) return;
                    await openCourse(card.dataset.id);
                };
            });
            grid.querySelectorAll('[data-rename]').forEach(btn => {
                btn.onclick = async (e) => {
                    e.stopPropagation();
                    const id = btn.dataset.rename;
                    await promptRename(id, library.find(c => c.id === id)?.title);
                    renderLibrary();
                };
            });
            grid.querySelectorAll('[data-del]').forEach(btn => {
                btn.onclick = async (e) => {
                    e.stopPropagation();
                    const meta = library.find(c => c.id === btn.dataset.del);
                    const name = meta?.title || 'this course';
                    const ok = await uiConfirm(
                        `Delete "${name}"?`,
                        'The course and all your progress in it are removed. This cannot be undone.',
                        { confirmText: 'Delete', danger: true });
                    if (ok) {
                        await deleteCourse(btn.dataset.del);
                        renderLibrary();
                        toast(`Deleted "${name}"`);
                    }
                };
            });
        }

        async function showLibrary() {
            if (!currentUser) {
                pendingAction = { type: 'showLibrary' };
                showAuthModal('signin');
                return;
            }
            await loadLibrary();
            renderLibrary();
            document.getElementById('libraryScreen').hidden = false;
            document.getElementById('sourcePicker').hidden = true;
            document.getElementById('learningPath').classList.remove('active');
            setActiveNav('courses');
        }

        function showNewCourse() {
            if (library.length >= MAX_COURSES) {
                showError(`You can keep ${MAX_COURSES} courses at a time. Delete one to add another.`);
                return;
            }
            document.getElementById('libraryScreen').hidden = true;
            document.getElementById('sourcePicker').hidden = false;
            document.getElementById('backToLibraryBtn').hidden = library.length === 0;
            document.getElementById('learningPath').classList.remove('active');
            setActiveNav('home');
        }

        // ============= Lesson preview =============
        let previewIndex = null;

        function openPreview(index) {
            const concept = courseData.concepts[index];
            const done = progress[index]?.completed;
            const cached = !!progress[index]?.lesson;

            previewIndex = index;

            const num = document.getElementById('previewNum');
            num.textContent = index + 1;

            document.getElementById('previewTitle').textContent = concept.name;
            document.getElementById('previewDesc').textContent = concept.description || '';

            const why = document.getElementById('previewWhy');
            why.innerHTML = concept.importance
                ? `<span class="why-label">Why this matters</span>${esc(concept.importance)}`
                : '';

            const diff = concept.difficulty || 1;
            const chips = [
                `<span class="meta-chip">Difficulty ${'●'.repeat(diff)}${'○'.repeat(Math.max(0, 5 - diff))}</span>`,
                done ? `<span class="meta-chip">${ICONS.check} Completed</span>` : '',
                isDueForReview(index) ? `<span class="meta-chip">${ICONS.refresh} Due for review</span>` : '',
                // Be honest about when a lesson costs an API call
                cached ? `<span class="meta-chip">Ready — no cost</span>` : `<span class="meta-chip">Will generate now</span>`,
            ].filter(Boolean).join('');
            document.getElementById('previewChips').innerHTML = chips;

            document.getElementById('previewStart').textContent =
                done ? "Review lesson" : cached ? "Start lesson" : "Generate and start";
            document.getElementById('previewCancel').textContent = "Cancel";

            applyContentDirection();
            const ov = document.getElementById('previewOverlay');
            ov.classList.add('show');
            ov.setAttribute('aria-hidden', 'false');
            document.getElementById('previewStart').focus();
        }

        function closePreview() {
            const ov = document.getElementById('previewOverlay');
            ov.classList.remove('show');
            ov.setAttribute('aria-hidden', 'true');
            previewIndex = null;
        }

        // ============= Screen Manager =============
        let savedPathScroll = 0;

        function openLessonScreen() {
            const path = document.querySelector('.path-container');
            savedPathScroll = path ? path.scrollTop : 0;

            document.body.classList.add('lesson-open');
            const screen = document.getElementById('lessonScreen');
            screen.classList.add('open');
            screen.setAttribute('aria-hidden', 'false');
            document.getElementById('lessonScroll').scrollTop = 0;
            document.getElementById('backBtn').focus();
        }

        function closeLessonScreen() {
            const screen = document.getElementById('lessonScreen');
            screen.classList.remove('open');
            screen.setAttribute('aria-hidden', 'true');
            document.body.classList.remove('lesson-open');
            hideTutorPanel();

            // Restore the path exactly as it was
            const path = document.querySelector('.path-container');
            if (path) {
                const behavior = path.style.scrollBehavior;
                path.style.scrollBehavior = 'auto';
                path.scrollTop = savedPathScroll;
                path.style.scrollBehavior = behavior;
            }
        }

        function hideTutorPanel() {
            const panel = document.getElementById('tutorPanel');
            if (panel) panel.hidden = true;
            const resp = document.getElementById('tutorResponse');
            if (resp) resp.style.display = 'none';
        }

        // Leave a lesson without finishing it. No reward, no confetti.
        function exitLesson() {
            closeLessonScreen();
            setTimeout(() => {
                displayLearningPath();
                scrollToCurrentNode();
            }, 340);
        }

        // Finish a lesson properly: close, redraw, celebrate the unlock.
        function completeLesson() {
            closeLessonScreen();
            setTimeout(() => {
                displayLearningPath();
                scrollToCurrentNode();
                celebrate();
            }, 340);
        }

        // ============= Question engine =============
        // One renderer and one grader, dispatching on question type. Each type
        // builds its own interaction; grading normalises them all to right/wrong
        // plus an explanation, so the surrounding lesson flow stays identical.

        function shuffle(arr) {
            const a = arr.slice();
            for (let i = a.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [a[i], a[j]] = [a[j], a[i]];
            }
            return a;
        }

        // Returns the inner HTML for a question body (without the eyebrow).
        function renderQuestion(q, idPrefix) {
            const p = idPrefix || 'q';
            switch (q.type) {
                case 'boolean':    return renderBoolean(q, p);
                case 'order':      return renderOrder(q, p);
                case 'categorize': return renderCategorize(q, p);
                case 'match':      return renderMatch(q, p);
                case 'blank':      return renderBlank(q, p);
                case 'choice':
                case 'mistake':
                default:           return renderChoice(q, p);
            }
        }

        function renderChoice(q, p) {
            const opts = q.options.map((o, i) =>
                `<div class="option" data-answer="${i}">${esc(o)}</div>`).join('');
            return `<div class="question-text">${esc(q.text)}</div>
                    <div class="options" id="answerOpts">${opts}</div>`;
        }

        function renderBlank(q, p) {
            // Render the sentence with the gap highlighted, options below.
            const sentence = esc(q.text).replace(/_{2,}|＿+/g, '<span class="blank-gap">?</span>');
            const opts = q.options.map((o, i) =>
                `<div class="option" data-answer="${i}">${esc(o)}</div>`).join('');
            return `<div class="question-text blank-sentence">${sentence}</div>
                    <div class="step-note">Choose the word that fills the gap</div>
                    <div class="options" id="answerOpts">${opts}</div>`;
        }

        function renderBoolean(q, p) {
            return `<div class="question-text">${esc(q.text)}</div>
                    <div class="bool-row" id="answerOpts">
                        <div class="option bool-opt" data-answer="true">${ICONS.check} True</div>
                        <div class="option bool-opt" data-answer="false">${ICONS.x} False</div>
                    </div>`;
        }

        function renderOrder(q, p) {
            // Present shuffled; learner taps to build the sequence.
            const shuffled = shuffle(q.items.map((text, idx) => ({ text, idx })));
            const pool = shuffled.map(it =>
                `<button class="order-chip" data-idx="${it.idx}">${esc(it.text)}</button>`).join('');
            return `<div class="question-text">${esc(q.text)}</div>
                    <div class="step-note">Tap in the correct order</div>
                    <ol class="order-slots" id="orderSlots"></ol>
                    <div class="order-pool" id="orderPool">${pool}</div>
                    <button class="button button-secondary order-undo" id="orderUndo" hidden>Undo last</button>`;
        }

        function renderCategorize(q, p) {
            const buckets = q.buckets.map((b, bi) =>
                `<div class="cat-bucket" data-bucket="${bi}">
                    <div class="cat-bucket-title">${esc(b)}</div>
                    <div class="cat-drop" data-bucket="${bi}"></div>
                 </div>`).join('');
            const pool = shuffle(q.items.map((it, idx) => ({ it, idx }))).map(({ it, idx }) =>
                `<button class="cat-chip" data-idx="${idx}">${esc(it.text)}</button>`).join('');
            return `<div class="question-text">${esc(q.text)}</div>
                    <div class="step-note">Tap an item, then tap its group</div>
                    <div class="cat-pool" id="catPool">${pool}</div>
                    <div class="cat-buckets" id="catBuckets">${buckets}</div>`;
        }

        function renderMatch(q, p) {
            // Two columns; tap left then right to connect. Right side shuffled.
            const left = q.pairs.map((pair, i) =>
                `<button class="match-item match-left" data-left="${i}">${esc(pair.left)}</button>`).join('');
            const right = shuffle(q.pairs.map((pair, i) => ({ text: pair.right, i })))
                .map(r => `<button class="match-item match-right" data-right="${r.i}">${esc(r.text)}</button>`).join('');
            return `<div class="question-text">${esc(q.text)}</div>
                    <div class="step-note">Tap a term, then tap its match</div>
                    <div class="match-grid">
                        <div class="match-col" id="matchLeft">${left}</div>
                        <div class="match-col" id="matchRight">${right}</div>
                    </div>`;
        }

        // ---- Wiring & grading ----
        // Each wirer calls finishQuestion(correct, explanation) when the learner
        // has committed an answer.
        function wireQuestion(q, onGraded) {
            const done = (correct, explanationOverride) => {
                lessonState.total++;
                if (correct) {
                    lessonState.correct++;
                } else if ((lessonState.heartsLeft ?? 5) > 0) {
                    lessonState.heartsLeft = (lessonState.heartsLeft ?? 5) - 1;
                    renderHearts();
                }
                showQuestionFeedback(correct, explanationOverride || q.explanation);
                onGraded && onGraded(correct);
            };

            switch (q.type) {
                case 'boolean':    return wireBoolean(q, done);
                case 'order':      return wireOrder(q, done);
                case 'categorize': return wireCategorize(q, done);
                case 'match':      return wireMatch(q, done);
                case 'blank':
                case 'choice':
                case 'mistake':
                default:           return wireChoice(q, done);
            }
        }

        // Duolingo's signature moment: a colored banner docks in from the bottom
        // of the screen, above the tutor dock, with the verdict and a big Continue.
        function showQuestionFeedback(correct, explanation) {
            const bar = document.getElementById('feedbackBar');
            if (!bar) return;
            bar.className = 'feedback-bar show ' + (correct ? 'feedback-ok' : 'feedback-bad');
            bar.innerHTML = `
                <div class="feedback-head">${correct ? ICONS.check + ' Nice!' : ICONS.x + ' Not quite'}</div>
                <div class="feedback-body">${explanation ? esc(explanation) : ''}</div>
                <button class="button step-next" id="stepNext">Continue</button>`;
            document.getElementById('stepNext').onclick = advanceStep;
        }

        function lockOptions() {
            document.querySelectorAll('#answerOpts .option').forEach(o => {
                o.classList.add('locked-in');
                o.onclick = null;
            });
        }

        function wireChoice(q, done) {
            const opts = [...document.querySelectorAll('#answerOpts .option')];
            opts.forEach(el => {
                el.onclick = () => {
                    if (opts.some(o => o.classList.contains('locked-in'))) return;
                    const picked = Number(el.dataset.answer);
                    const isRight = picked === q.correct;
                    lockOptions();
                    opts.forEach((o, i) => {
                        if (i === q.correct) o.classList.add('correct');
                        else if (i === picked) o.classList.add('incorrect');
                    });
                    el.classList.add(isRight ? 'pop' : 'shake');
                    done(isRight);
                };
            });
        }

        function wireBoolean(q, done) {
            const opts = [...document.querySelectorAll('#answerOpts .bool-opt')];
            opts.forEach(el => {
                el.onclick = () => {
                    if (opts.some(o => o.classList.contains('locked-in'))) return;
                    const picked = el.dataset.answer === 'true';
                    const isRight = picked === q.answer;
                    opts.forEach(o => { o.classList.add('locked-in'); o.onclick = null; });
                    opts.forEach(o => {
                        const val = o.dataset.answer === 'true';
                        if (val === q.answer) o.classList.add('correct');
                        else if (val === picked) o.classList.add('incorrect');
                    });
                    el.classList.add(isRight ? 'pop' : 'shake');
                    done(isRight);
                };
            });
        }

        function wireOrder(q, done) {
            const slots = document.getElementById('orderSlots');
            const pool = document.getElementById('orderPool');
            const undo = document.getElementById('orderUndo');
            const placed = [];   // idx values in tapped order

            const refresh = () => {
                undo.hidden = placed.length === 0;
                slots.innerHTML = placed.map((idx, pos) => {
                    const chip = q.items[idx];
                    return `<li class="order-placed">${pos + 1}. ${esc(chip)}</li>`;
                }).join('');
                if (placed.length === q.items.length) grade();
            };

            const grade = () => {
                pool.querySelectorAll('.order-chip').forEach(c => c.disabled = true);
                undo.hidden = true;
                // Correct order is the original array order: 0,1,2,...
                const correct = placed.every((idx, pos) => idx === pos);
                placed.forEach((idx, pos) => {
                    const li = slots.children[pos];
                    li.classList.add(idx === pos ? 'slot-ok' : 'slot-bad');
                });
                let exp = q.explanation || '';
                if (!correct) {
                    const answer = q.items.map((t, i) => `${i + 1}. ${t}`).join('  ');
                    exp = (exp ? exp + ' ' : '') + 'Correct order: ' + answer;
                }
                done(correct, exp);
            };

            pool.querySelectorAll('.order-chip').forEach(chip => {
                chip.onclick = () => {
                    if (chip.disabled || chip.classList.contains('used')) return;
                    chip.classList.add('used');
                    placed.push(Number(chip.dataset.idx));
                    refresh();
                };
            });
            undo.onclick = () => {
                const last = placed.pop();
                const chip = pool.querySelector(`.order-chip[data-idx="${last}"]`);
                if (chip) chip.classList.remove('used');
                refresh();
            };
        }

        function wireCategorize(q, done) {
            const pool = document.getElementById('catPool');
            let selected = null;   // the chip element awaiting a bucket
            const assign = {};     // idx -> bucket index
            const total = q.items.length;

            pool.querySelectorAll('.cat-chip').forEach(chip => {
                chip.onclick = () => {
                    if (chip.classList.contains('placed')) return;
                    pool.querySelectorAll('.cat-chip').forEach(c => c.classList.remove('selected'));
                    if (selected === chip) { selected = null; return; }
                    selected = chip;
                    chip.classList.add('selected');
                };
            });

            document.querySelectorAll('.cat-drop').forEach(drop => {
                drop.onclick = () => {
                    if (!selected) return;
                    const idx = Number(selected.dataset.idx);
                    const bucket = Number(drop.dataset.bucket);
                    assign[idx] = bucket;
                    const clone = document.createElement('span');
                    clone.className = 'cat-placed';
                    clone.textContent = q.items[idx].text;
                    drop.appendChild(clone);
                    selected.classList.add('placed');
                    selected.classList.remove('selected');
                    selected = null;
                    if (Object.keys(assign).length === total) grade();
                };
            });

            const grade = () => {
                let right = 0;
                q.items.forEach((it, idx) => {
                    const correctBucket = q.buckets.indexOf(it.bucket);
                    if (assign[idx] === correctBucket) right++;
                });
                const allRight = right === total;
                let exp = q.explanation || '';
                if (!allRight) {
                    const key = q.items.map(it => `${it.text} → ${it.bucket}`).join(', ');
                    exp = (exp ? exp + ' ' : '') + 'Correct grouping: ' + key;
                }
                done(allRight, exp);
            };
        }

        function wireMatch(q, done) {
            const leftBtns = [...document.querySelectorAll('.match-left')];
            const rightBtns = [...document.querySelectorAll('.match-right')];
            let selLeft = null;
            const matched = {};   // left index -> right index
            const palette = ['#1CB0F6', '#CE82FF', '#58CC02', '#FFC800', '#FF4B4B', '#FF9600'];

            leftBtns.forEach(btn => {
                btn.onclick = () => {
                    if (btn.classList.contains('matched')) return;
                    leftBtns.forEach(b => b.classList.remove('selected'));
                    if (selLeft === btn) { selLeft = null; return; }
                    selLeft = btn;
                    btn.classList.add('selected');
                };
            });

            rightBtns.forEach(btn => {
                btn.onclick = () => {
                    if (!selLeft || btn.classList.contains('matched')) return;
                    const li = Number(selLeft.dataset.left);
                    const ri = Number(btn.dataset.right);
                    matched[li] = ri;
                    const color = palette[Object.keys(matched).length % palette.length];
                    selLeft.classList.add('matched');
                    btn.classList.add('matched');
                    selLeft.style.borderColor = color;
                    btn.style.borderColor = color;
                    selLeft.classList.remove('selected');
                    selLeft = null;
                    if (Object.keys(matched).length === q.pairs.length) grade();
                };
            });

            const grade = () => {
                // Pair i is correct when left i is matched to right i.
                let right = 0;
                q.pairs.forEach((_, i) => { if (matched[i] === i) right++; });
                const allRight = right === q.pairs.length;
                let exp = q.explanation || '';
                if (!allRight) {
                    const key = q.pairs.map(pr => `${pr.left} = ${pr.right}`).join(', ');
                    exp = (exp ? exp + ' ' : '') + 'Correct pairs: ' + key;
                }
                done(allRight, exp);
            };
        }

        // ============= Lesson Step Engine =============
        let lessonState = null;

        let lessonLoading = false;   // guards against double-entry

        async function loadLesson(index) {
            if (lessonLoading) return;          // already fetching one
            lessonLoading = true;

            try {
                currentLessonIndex = index;
                const concept = courseData.concepts[index];

                showMessage("Preparing lesson...");

                let lesson = progress[index]?.lesson;

                // A lesson cached by an older build may be malformed. Re-normalise
                // it and throw it away if it has nothing to teach.
                if (lesson) {
                    lesson = normaliseLesson(lesson, concept);
                    const usable = lesson.cards.length + lesson.quiz.length
                        + (lesson.hook ? 1 : 0) + (lesson.workedExample ? 1 : 0)
                        + (lesson.practice ? 1 : 0) + (lesson.challenge ? 1 : 0);
                    if (usable < 2) {
                        console.warn('Discarding a broken cached lesson.');
                        delete progress[index].lesson;
                        saveProgress();
                        lesson = null;
                    }
                }

                if (lesson) {
                    recordCacheHit();           // served from cache, no API call
                } else {
                    lesson = await generateLesson(concept);
                    if (!lesson) {
                        // Generation failed. Stay on the path; the error was already shown.
                        closeLessonScreen();
                        return;
                    }
                    if (!progress[index]) progress[index] = {};
                    progress[index].lesson = lesson;
                    saveProgress();
                }

                // Build the step sequence, skipping anything the model omitted
                const steps = [];
                if (lesson.hook) steps.push({ type: 'hook' });
                if (lesson.prediction) steps.push({ type: 'prediction' });
                lesson.cards.forEach((_, i) => steps.push({ type: 'card', i }));
                if (lesson.workedExample) steps.push({ type: 'worked' });
                if (lesson.practice) steps.push({ type: 'practice' });
                lesson.quiz.forEach((_, i) => steps.push({ type: 'quiz', i }));
                if (lesson.challenge) steps.push({ type: 'challenge' });
                if (lesson.summary) steps.push({ type: 'summary' });
                if (lesson.memoryCheck) steps.push({ type: 'memory' });

                // Never open a lesson that would show nothing but a finish screen.
                if (!steps.length) {
                    console.error('Lesson produced no steps:', lesson);
                    showError("That lesson came back empty. Try opening it again.");
                    if (progress[index]) delete progress[index].lesson;
                    saveProgress();
                    closeLessonScreen();
                    return;
                }
                steps.push({ type: 'complete' });

                lessonState = {
                    lesson, steps, step: 0,
                    correct: 0, total: 0,
                    heartsLeft: 5,
                    startedAt: Date.now(),
                    answered: {},
                    result: null
                };

                document.getElementById('sourcePicker').hidden = true;
                document.getElementById('learningPath').classList.add('active');

                // Max possible: base + 10 per gradeable question + perfect-run bonus.
                const gradeable = (lesson.quiz?.length || 0)
                    + (lesson.practice ? 1 : 0)
                    + (lesson.challenge ? 1 : 0);
                const maxXp = 20 + gradeable * 10 + (gradeable > 0 ? 25 : 0);
                document.getElementById('lessonXpBadge').textContent = `Up to ${maxXp} XP`;
                document.getElementById('lessonMeta').innerHTML = `
                    <span class="meta-chip">${lesson.estimatedMinutes} min</span>
                    <span class="meta-chip">Difficulty ${'●'.repeat(concept.difficulty || 1)}${'○'.repeat(Math.max(0, 5 - (concept.difficulty || 1)))}</span>
                    <span class="meta-chip">${steps.length} steps</span>`;

                applyContentDirection();
                buildStepSegments(steps.length);
                renderHearts();
                displayLearningPath();
                openLessonScreen();
                renderStep();
            } finally {
                lessonLoading = false;
                hideMessage();
            }
        }

        function advanceStep() {
            if (!lessonState) return;
            if (lessonState.step < lessonState.steps.length - 1) {
                lessonState.step++;
                renderStep();
            }
        }

        function esc(s) {
            const d = document.createElement('div');
            d.textContent = s == null ? '' : String(s);
            return d.innerHTML;
        }

        function renderStep() {
            const { lesson, steps, step } = lessonState;
            const s = steps[step];

            document.getElementById('lessonTitle').textContent = lesson.title;
            updateStepSegments(step, steps.length);

            // A stale banner from the previous step must never carry over —
            // it lives outside the body that gets replaced below.
            const feedbackBar = document.getElementById('feedbackBar');
            if (feedbackBar) { feedbackBar.className = 'feedback-bar'; feedbackBar.innerHTML = ''; }

            const body = document.getElementById('lessonExplanation');

            // Commit exactly once, before rendering the complete screen.
            if (s.type === 'complete' && !lessonState.result) {
                lessonState.result = commitLessonResult();
            }
            if (s.type === 'reviewComplete' && !lessonState.result) {
                lessonState.result = commitReviewResult();
            }

            const renderers = {
                hook: () => stepHook(lesson),
                prediction: () => stepPrediction(lesson),
                card: () => stepCard(lesson, s.i),
                worked: () => stepWorked(lesson),
                practice: () => stepPractice(lesson),
                quiz: () => stepQuiz(lesson, s.i),
                challenge: () => stepChallenge(lesson),
                summary: () => stepSummary(lesson),
                memory: () => stepMemory(lesson),
                complete: () => stepComplete(lesson),
                reviewq: () => stepReviewQuestion(s.i),
                reviewComplete: () => stepReviewComplete(),
            };
            body.innerHTML = renderers[s.type]();
            wireStep(s);
            const scroller = document.getElementById('lessonScroll');
            if (scroller) {
                scroller.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
            }
        }

        // ---- Step renderers ----
        function stepHook(l) {
            return `
                <div class="step-eyebrow">A moment of curiosity</div>
                <div class="hook-card">${esc(l.hook.text)}</div>
                <button class="button step-next" id="stepNext">Continue</button>`;
        }

        function stepPrediction(l) {
            const opts = l.prediction.options.map((o, i) =>
                `<div class="option" data-pick="${i}">${esc(o)}</div>`).join('');
            return `
                <div class="step-eyebrow">Guess before we explain</div>
                <div class="question-text">${esc(l.prediction.question)}</div>
                <div class="step-note">${"No wrong answer \u2014 just think for a second."}</div>
                <div class="options" id="predictOpts">${opts}</div>`;
        }

        function stepCard(l, i) {
            const c = l.cards[i];
            const analogy = c.analogy
                ? `<div class="analogy-box"><span class="analogy-label">Think of it this way</span>${esc(c.analogy)}</div>`
                : '';
            return `
                <div class="step-eyebrow">Idea ${i + 1} / ${l.cards.length}</div>
                ${c.idea ? `<h3 class="card-idea">${esc(c.idea)}</h3>` : ''}
                <div class="concept-text">${esc(c.text)}</div>
                ${renderVisual(c.visual)}
                ${analogy}
                <button class="button step-next" id="stepNext">Continue</button>`;
        }

        function stepWorked(l) {
            const w = l.workedExample;
            const steps = w.steps.map((st, i) => `
                <div class="worked-step" data-idx="${i}">
                    <button class="worked-reveal" data-reveal="${i}">
                        <span class="worked-num">${i + 1}</span>
                        <span>${esc(st.action)}</span>
                    </button>
                    <div class="worked-why" id="why${i}" hidden>${esc(st.why)}</div>
                </div>`).join('');
            return `
                <div class="step-eyebrow">Worked example</div>
                <div class="concept-text">${esc(w.problem)}</div>
                ${renderVisual(w.visual)}
                <div class="worked-list">${steps}</div>
                <div class="example-box"><div class="example-label">The answer</div>${esc(w.answer)}</div>
                <button class="button step-next" id="stepNext">Continue</button>`;
        }

        function stepPractice(l) {
            const p = l.practice;
            const opts = p.options.map((o, i) =>
                `<div class="option" data-answer="${i}">${esc(o)}</div>`).join('');
            return `
                <div class="step-eyebrow">Guided practice</div>
                <div class="question-text">${esc(p.problem)}</div>
                <div class="options" id="answerOpts">${opts}</div>
                ${p.hint ? `<button class="button button-secondary hint-btn" id="hintBtn">Show hint</button>
                <div class="hint-box" id="hintBox" hidden>${esc(p.hint)}</div>` : ''}`;
        }

        function stepQuiz(l, i) {
            const q = l.quiz[i];
            return `
                <div class="step-eyebrow">Question ${i + 1} / ${l.quiz.length}</div>
                ${renderQuestion(q, 'quiz')}`;
        }

        function stepChallenge(l) {
            return `
                <div class="step-eyebrow challenge-eyebrow">Final challenge</div>
                <div class="step-note">Put it all together.</div>
                ${renderQuestion(l.challenge, 'chal')}`;
        }

        function stepSummary(l) {
            const s = l.summary;
            const facts = s.keyFacts.map(f => `<li>${esc(f)}</li>`).join('');
            return `
                <div class="step-eyebrow">Summary</div>
                <div class="concept-text"><strong>The main idea</strong><br>${esc(s.mainIdea)}</div>
                ${renderVisual(s.visual)}
                ${facts ? `<div class="summary-facts"><strong>Key facts</strong><ul>${facts}</ul></div>` : ''}
                ${s.commonMistake ? `<div class="misconception-box"><strong>Common Misconception:</strong><br>${esc(s.commonMistake)}</div>` : ''}
                ${s.realWorld ? `<div class="example-box"><div class="example-label">Real-World Example:</div>${esc(s.realWorld)}</div>` : ''}
                <button class="button step-next" id="stepNext">Continue</button>`;
        }

        function stepMemory(l) {
            return `
                <div class="step-eyebrow">Memory check</div>
                <div class="question-text">${esc(l.memoryCheck.prompt)}</div>
                <textarea class="memory-input" id="memoryInput" placeholder="Write it in your own words..."></textarea>
                <button class="button" id="memorySubmit">Check my answer</button>
                <div class="feedback" id="memoryFeedback" hidden></div>`;
        }

        function stepReviewQuestion(i) {
            const { lessonIndex, question } = lessonState.review.items[i];
            const concept = courseData.concepts[lessonIndex];
            return `
                <div class="step-eyebrow">Review · ${esc(concept.name)}</div>
                ${renderQuestion(question, 'rev' + i)}`;
        }

        function stepReviewComplete() {
            const { lessonsReviewed, correct, total } = lessonState.result;
            const accuracy = total ? Math.round((correct / total) * 100) : 100;
            return `
                <div class="complete-screen">
                    <div class="complete-badge">${ICONS.refresh}</div>
                    <h3 class="complete-title">Review complete</h3>
                    <div class="complete-stats">
                        <div class="cstat"><div class="cstat-val">${lessonsReviewed}</div><div class="cstat-lbl">Lessons reviewed</div></div>
                        <div class="cstat"><div class="cstat-val">${accuracy}%</div><div class="cstat-lbl">Accuracy</div></div>
                        <div class="cstat"><div class="cstat-val">${correct}/${total}</div><div class="cstat-lbl">Correct</div></div>
                    </div>
                    <div class="step-note">Lessons you remembered well come back later. Shaky ones come back tomorrow.</div>
                    <button class="button button-secondary" id="backToPath">Back to path</button>
                </div>`;
        }

        // Commit the result. Separate from rendering so re-rendering can't
        // re-award XP or re-save progress.
        function commitLessonResult() {
            const { correct, total, startedAt } = lessonState;
            const accuracy = total ? Math.round((correct / total) * 100) : 100;
            const xp = 20 + correct * 10 + (accuracy === 100 && total > 0 ? 25 : 0);

            if (!progress[currentLessonIndex]) progress[currentLessonIndex] = {};
            const prev = progress[currentLessonIndex];
            prev.completed = true;
            // Replaying a lesson keeps your best result, it doesn't overwrite it.
            prev.accuracy = Math.max(prev.accuracy || 0, accuracy);
            prev.xp = Math.max(prev.xp || 0, xp);
            scheduleReview(currentLessonIndex, accuracy);
            saveProgress();
            updateProgress();
            bumpStreak();
            renderHud();
            return { accuracy, xp, minutes: Math.max(1, Math.round((Date.now() - startedAt) / 60000)) };
        }

        function stepComplete(l) {
            const { correct, total } = lessonState;
            const { accuracy, xp, minutes: mins } = lessonState.result;

            const isLast = currentLessonIndex >= courseData.concepts.length - 1;
            return `
                <div class="complete-screen">
                    <div class="complete-badge">${ICONS.check}</div>
                    <h3 class="complete-title">Lesson complete</h3>
                    <div class="complete-stats">
                        <div class="cstat"><div class="cstat-val">+${xp}</div><div class="cstat-lbl">XP</div></div>
                        <div class="cstat"><div class="cstat-val">${accuracy}%</div><div class="cstat-lbl">Accuracy</div></div>
                        <div class="cstat"><div class="cstat-val">${correct}/${total}</div><div class="cstat-lbl">Correct</div></div>
                        <div class="cstat"><div class="cstat-val">${mins}m</div><div class="cstat-lbl">Time</div></div>
                    </div>
                    ${isLast
                        ? `<div class="step-note">You finished the whole course. Well done.</div>`
                        : `<button class="button" id="continueNext">Next lesson</button>`}
                    <button class="button button-secondary" id="backToPath">Back to path</button>
                </div>`;
        }

        // ---- Wiring ----
        function wireStep(s) {
            const next = document.getElementById('stepNext');
            if (next) next.onclick = advanceStep;

            if (s.type === 'prediction') {
                document.querySelectorAll('#predictOpts .option').forEach(el => {
                    el.onclick = () => {
                        document.querySelectorAll('#predictOpts .option').forEach(o => o.classList.add('dimmed'));
                        el.classList.remove('dimmed');
                        el.classList.add('picked');
                        setTimeout(advanceStep, 550);
                    };
                });
            }

            if (s.type === 'worked') {
                document.querySelectorAll('[data-reveal]').forEach(btn => {
                    btn.onclick = () => {
                        const why = document.getElementById('why' + btn.dataset.reveal);
                        why.hidden = !why.hidden;
                        btn.classList.toggle('revealed', !why.hidden);
                    };
                });
            }

            if (s.type === 'quiz' || s.type === 'challenge') {
                const l = lessonState.lesson;
                const item = s.type === 'quiz' ? l.quiz[s.i] : l.challenge;
                wireQuestion(item);
            }

            if (s.type === 'reviewq') {
                const { lessonIndex, question } = lessonState.review.items[s.i];
                wireQuestion(question, (correct) => {
                    const by = lessonState.review.byLesson;
                    by[lessonIndex] = by[lessonIndex] || { correct: 0, total: 0 };
                    by[lessonIndex].total++;
                    if (correct) by[lessonIndex].correct++;
                });
            }

            if (s.type === 'practice') {
                // Practice keeps its optional hint, then grades like a choice question.
                const p = lessonState.lesson.practice;
                const hintBtn = document.getElementById('hintBtn');
                if (hintBtn) hintBtn.onclick = () => {
                    document.getElementById('hintBox').hidden = false;
                    hintBtn.remove();
                };
                wireQuestion({
                    type: 'choice', text: p.problem, options: p.options,
                    correct: p.correct,
                    explanation: '',   // practice shows tailored feedback instead
                }, (correct) => {
                    const msg = correct ? p.feedback.correct : p.feedback.incorrect;
                    const body = document.querySelector('#feedbackBar .feedback-body');
                    if (body && msg) body.textContent = msg;
                });
            }

            if (s.type === 'memory') {
                document.getElementById('memorySubmit').onclick = () => evaluateMemory();
            }

            if (s.type === 'complete') {
                const cn = document.getElementById('continueNext');
                if (cn) cn.onclick = () => {
                    // Return to the path, celebrate the unlock, then open the next lesson
                    completeLesson();
                    setTimeout(() => nextLesson(), 1100);
                };
                document.getElementById('backToPath').onclick = completeLesson;
            }

            if (s.type === 'reviewComplete') {
                document.getElementById('backToPath').onclick = completeLesson;
            }
        }

        async function evaluateMemory() {
            const input = document.getElementById('memoryInput').value.trim();
            const fb = document.getElementById('memoryFeedback');
            if (!input) return;

            fb.hidden = false;
            fb.className = 'feedback';
            fb.innerHTML = `<div class="spinner"></div> Thinking...`;

            const l = lessonState.lesson;
            const sys = "You are a tutor. Gently evaluate the learner's explanation: name what they got right, then what is missing. 2-3 sentences. " + languageRule();
            const res = await callAI(
                `Concept: ${l.title}\nMain idea: ${l.summary?.mainIdea || ''}\n\nLearner's explanation: ${input}`,
                sys,
                { maxTokens: MAX_TOKENS.feedback, task: 'feedback' }
            );

            fb.className = 'feedback feedback-ok';
            fb.innerHTML = `
                <div>${esc(res || "Thanks \u2014 putting it in your own words is the best way to remember it.")}</div>
                <button class="button step-next" id="stepNext">Continue</button>`;
            document.getElementById('stepNext').onclick = advanceStep;
        }

        function renderTutorActions() {
            const box = document.getElementById('tutorActions');
            if (!box || box.dataset.built) return;
            box.innerHTML = TUTOR_ACTIONS.map(a =>
                `<button class="tutor-chip" data-ask="${esc(a.id)}">${esc(a.label)}</button>`).join('');
            box.querySelectorAll('.tutor-chip').forEach(chip => {
                chip.onclick = () => {
                    const action = TUTOR_ACTIONS.find(a => a.id === chip.dataset.ask);
                    if (action) askTutor(action.ask, action.label);
                };
            });
            box.dataset.built = '1';
        }

        let tutorBusy = false;

        async function askTutor(presetQuestion, presetLabel) {
            if (tutorBusy) return;

            const input = document.getElementById('tutorQuestion');
            const question = presetQuestion || input.value.trim();
            if (!question || !courseData) return;

            tutorBusy = true;
            const box = document.getElementById('tutorResponse');
            box.style.display = 'block';
            box.innerHTML = `<div class="tutor-asked">${esc(presetLabel || question)}</div>
                             <div class="tutor-thinking"><div class="spinner"></div> Thinking...</div>`;

            try {
                const response = await getTutorResponse(question);
                if (response && response.trim()) {
                    box.innerHTML = `<div class="tutor-asked">${esc(presetLabel || question)}</div>
                                     <div class="tutor-answer">${esc(response)}</div>`;
                    if (!presetQuestion) input.value = '';
                } else if (response === '') {
                    box.innerHTML = `<div class="tutor-asked">${esc(presetLabel || question)}</div>
                                     <div class="tutor-answer">No answer came back. Try asking again.</div>`;
                } else {
                    box.style.display = 'none';   // callAI already showed the error
                }
            } finally {
                tutorBusy = false;
            }
        }

        function celebrate() {
            if (prefersReducedMotion()) return;
            const colors = ['#58CC02', '#1CB0F6', '#CE82FF', '#FFC800', '#FF4B4B'];
            for (let i = 0; i < 40; i++) {
                const c = document.createElement('div');
                c.className = 'confetti';
                c.style.left = Math.random() * 100 + 'vw';
                c.style.top = '-10px';
                c.style.background = colors[i % colors.length];
                c.style.animationDelay = Math.random() * 0.4 + 's';
                c.style.transform = `rotate(${Math.random() * 360}deg)`;
                document.body.appendChild(c);
                setTimeout(() => c.remove(), 3400);
            }
        }

        function nextLesson() {
            if (currentLessonIndex < courseData.concepts.length - 1) {
                loadLesson(currentLessonIndex + 1);
            }
        }

        function updateProgress() {
            const completed = Object.keys(progress).filter(k => progress[k].completed).length;
            const total = courseData.concepts.length;
            const percent = Math.round((completed / total) * 100);

            document.getElementById('completedCount').textContent = completed;
            document.getElementById('progressPercent').textContent = percent + '%';
            document.getElementById('progressBar').style.width = percent + '%';
        }

        // ============= Event Listeners =============
        document.getElementById('uploadSection').addEventListener('click', () => {
            document.getElementById('fileInput').click();
        });

        document.getElementById('fileInput').addEventListener('change', (e) => {
            const file = e.target.files[0];
            // Clear the value so picking the same file again still fires 'change'
            // (otherwise a retry after a failure silently does nothing).
            e.target.value = '';
            if (file) handleFileUpload(file);
        });

        document.getElementById('uploadSection').addEventListener('dragover', (e) => {
            e.preventDefault();
            document.getElementById('uploadSection').style.borderColor = '#1CB0F6';
        });

        document.getElementById('uploadSection').addEventListener('dragleave', () => {
            document.getElementById('uploadSection').style.borderColor = '';
        });

        document.getElementById('uploadSection').addEventListener('drop', (e) => {
            e.preventDefault();
            if (e.dataTransfer.files[0]) {
                handleFileUpload(e.dataTransfer.files[0]);
            }
        });

        function selectSource(mode) {
            const file = mode === 'file';
            document.getElementById('uploadSection').hidden = !file;
            document.getElementById('textPasteSection').hidden = file;
            document.getElementById('tabFile').classList.toggle('active', file);
            document.getElementById('tabPaste').classList.toggle('active', !file);
            document.getElementById('tabFile').setAttribute('aria-selected', String(file));
            document.getElementById('tabPaste').setAttribute('aria-selected', String(!file));
        }

        document.getElementById('libraryBtn').addEventListener('click', showLibrary);
        document.getElementById('newCourseBtn').addEventListener('click', showNewCourse);
        document.getElementById('backToLibraryBtn').addEventListener('click', showLibrary);

        // ============= Bottom nav =============
        function setActiveNav(name) {
            document.querySelectorAll('.bottom-nav-item').forEach(b => {
                b.classList.remove('active');
                // The green tint alone carries the "you are here" state; without
                // aria-current a screen reader hears four identical tabs.
                b.removeAttribute('aria-current');
            });
            const map = { home: 'navHome', courses: 'navCourses', review: 'navReview', account: 'navAccount' };
            const el = document.getElementById(map[name]);
            if (el) { el.classList.add('active'); el.setAttribute('aria-current', 'page'); }
        }

        document.getElementById('navHome').addEventListener('click', async () => {
            if (activeCourseId && courseData) {
                document.getElementById('libraryScreen').hidden = true;
                document.getElementById('sourcePicker').hidden = true;
                displayLearningPath();
            } else if (library.length) {
                await showLibrary();
            } else {
                document.getElementById('libraryScreen').hidden = true;
                document.getElementById('learningPath').classList.remove('active');
                document.getElementById('sourcePicker').hidden = false;
                setActiveNav('home');
            }
        });

        document.getElementById('navCourses').addEventListener('click', showLibrary);

        document.getElementById('navReview').addEventListener('click', () => {
            if (!currentUser) { showAuthModal('signin'); return; }
            if (!activeCourseId) { showError('Open a course first.'); return; }
            if (!getDueLessons().length) { showError('Nothing is due for review right now.'); return; }
            setActiveNav('review');
            startReviewSession();
        });

        document.getElementById('navAccount').addEventListener('click', async () => {
            if (!currentUser) { showAuthModal('signin'); return; }
            const out = await uiConfirm('Account', `Signed in as ${currentUser.email}.`,
                { confirmText: 'Sign out', danger: true });
            if (out) {
                await supabaseClient.auth.signOut();
            }
        });

        document.getElementById('signInPromptBtn').addEventListener('click', () => showAuthModal('signin'));

        document.getElementById('tabFile').addEventListener('click', () => selectSource('file'));
        document.getElementById('tabPaste').addEventListener('click', () => selectSource('paste'));

        document.getElementById('submitTextBtn').addEventListener('click', async () => {
            const text = document.getElementById('textInput').value;
            // Used to return silently on empty input, which read as a dead button.
            if (!text.trim()) {
                showError('Paste some study material first, then tap "Build learning path".');
                return;
            }
            // The loading overlay already blocks the screen, but the button keeps its
            // own state so it is never left looking pressable while work is running.
            const btn = document.getElementById('submitTextBtn');
            const label = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Building…';
            try {
                await processLearningMaterial(text);
            } finally {
                btn.disabled = false;
                btn.textContent = label;
            }
        });

        document.getElementById('courseTitle').addEventListener('click', async () => {
            if (!activeCourseId || !courseData) return;
            await promptRename(activeCourseId, courseData.courseName);
        });

        document.getElementById('startReviewBtn').addEventListener('click', startReviewSession);

        document.getElementById('resetBtn').addEventListener('click', async () => {
            if (!activeCourseId) return;
            // Name the course — "are you sure?" with no subject is how people reset
            // the wrong one.
            const ok = await uiConfirm(
                `Reset your progress in "${courseData?.courseName || 'this course'}"?`,
                'Every lesson goes back to locked. The course and its lessons are kept, so nothing has to be generated again.',
                { confirmText: 'Reset progress', danger: true });
            if (ok) {
                progress = {};
                saveProgress();
                displayLearningPath();
                toast('Progress reset');
            }
        });

        document.getElementById('previewStart').addEventListener('click', () => {
            const i = previewIndex;
            closePreview();
            if (i !== null) loadLesson(i);
        });
        document.getElementById('previewCancel').addEventListener('click', closePreview);
        document.getElementById('previewOverlay').addEventListener('click', (e) => {
            if (e.target.id === 'previewOverlay') closePreview();
        });

        document.getElementById('authModal').addEventListener('click', (e) => {
            if (e.target.id === 'authModal') {
                pendingAction = null;
                hideAuthModal();
            }
        });

        document.getElementById('backBtn').addEventListener('click', exitLesson);

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (document.getElementById('previewOverlay').classList.contains('show')) {
                closePreview();
            } else if (document.body.classList.contains('lesson-open')) {
                exitLesson();
            } else if (document.getElementById('authModal').classList.contains('active')) {
                pendingAction = null;
                hideAuthModal();
            }
        });

        document.getElementById('tutorToggle').addEventListener('click', (e) => {
            const panel = document.getElementById('tutorPanel');
            panel.hidden = !panel.hidden;
            e.currentTarget.setAttribute('aria-expanded', String(!panel.hidden));
            if (!panel.hidden) {
                renderTutorActions();
                document.getElementById('tutorQuestion').focus();
            }
        });

        document.getElementById('tutorAskBtn').addEventListener('click', () => askTutor());
        document.getElementById('tutorQuestion').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') askTutor();
        });

        // ============= Auth =============
        // Released on close: puts focus back on whatever opened the modal.
        let authModalRelease = null;

        function showAuthModal(mode = 'signin') {
            const modal = document.getElementById('authModal');
            if (modal.classList.contains('active')) { setAuthMode(mode); return; }
            modal.classList.add('active');
            modal.setAttribute('aria-hidden', 'false');
            setAuthMode(mode);
            lockBodyScroll(true);
            // Land on the email field, not on the close button — the first thing
            // asked for should be the first thing focused.
            authModalRelease = trapFocus(modal.querySelector('.modal-content'),
                document.getElementById('authEmail'));
        }
        function hideAuthModal() {
            const modal = document.getElementById('authModal');
            modal.classList.remove('active');
            modal.setAttribute('aria-hidden', 'true');
            lockBodyScroll(false);
            if (authModalRelease) { authModalRelease(); authModalRelease = null; }
        }
        function setAuthMode(mode) {
            const isUp = mode === 'signup';
            document.getElementById('authTabIn').classList.toggle('active', !isUp);
            document.getElementById('authTabUp').classList.toggle('active', isUp);
            document.getElementById('authTabIn').setAttribute('aria-selected', String(!isUp));
            document.getElementById('authTabUp').setAttribute('aria-selected', String(isUp));
            document.getElementById('authTitle').textContent = isUp ? 'Create your account' : 'Welcome back';
            document.getElementById('authSubmitBtn').textContent = isUp ? 'Sign up' : 'Sign in';
            const err = document.getElementById('authError');
            err.hidden = true;
            err.className = 'error-message';

            const pwInput = document.getElementById('authPassword');
            const pwToggle = document.getElementById('authPasswordToggle');
            pwInput.type = 'password';
            // Signing up needs a *new* password: with current-password the manager
            // offers the old one instead of generating a strong one.
            pwInput.autocomplete = isUp ? 'new-password' : 'current-password';
            pwToggle.innerHTML = ICONS.eye;
            pwToggle.setAttribute('aria-label', 'Show password');

            // "Forgot password" only makes sense once an account exists.
            document.getElementById('authForgotBtn').closest('div').hidden = isUp;
        }

        // Placeholder until Stripe is wired in — the entitlement check server-side
        // already works, this just needs a real checkout link.
        function showUpgradePrompt() {
            uiAlert('Paid subscriptions are coming soon — check back shortly. Your courses and progress are all still here in the meantime.',
                'Your free trial has ended');
        }

        // Set by any gated action (building a course, opening the library, etc.)
        // when it hits the auth wall — resumed automatically right after sign-in,
        // so the person never has to redo what they were already doing.
        // A plain serializable descriptor, not a closure — so it can also
        // survive the full-page redirect an OAuth sign-in does (stashed in
        // sessionStorage right before redirecting, restored on return).
        let pendingAction = null;

        async function runPendingAction(action) {
            if (action.type === 'buildCourse') return processLearningMaterial(action.text, action.title, action.chosenName);
            if (action.type === 'showLibrary') return showLibrary();
        }

        async function onSignedIn(user) {
            currentUser = user;
            document.getElementById('userEmail').textContent = user.email;
            document.getElementById('userBadge').hidden = false;
            document.getElementById('signInPromptBtn').hidden = true;
            hideAuthModal();

            if (pendingAction) {
                const action = pendingAction;
                pendingAction = null;
                await Promise.all([refreshUsage(), loadPlan()]);
                await runPendingAction(action);
                return;
            }

            try {
                await Promise.all([refreshUsage(), loadPlan()]);
                await loadLibrary();
                const lastId = localStorage.getItem(ACTIVE_STORAGE);
                if (lastId && library.some(c => c.id === lastId)) {
                    await openCourse(lastId);
                } else if (library.length) {
                    await showLibrary();
                } else {
                    document.getElementById('sourcePicker').hidden = false;
                }
            } catch (e) {
                // Signed in successfully, but loading their data failed. Never
                // leave them staring at a blank screen with no explanation.
                console.error('Post-signin load failed:', e);
                showError('Signed in, but something went wrong loading your courses. Try refreshing the page.');
                document.getElementById('sourcePicker').hidden = false;
            }
        }

        // The default state for anyone not signed in — browsing is free, the
        // auth modal only ever appears when something they do actually needs
        // an account (building a course, opening the library, reviewing).
        function showAnonymousHome() {
            currentUser = null;
            courseData = null;
            progress = {};
            activeCourseId = null;
            activeSourceText = '';
            library = [];
            pendingAction = null;
            planKey = 'basic';
            currentPlan = PLANS.basic;
            planLoaded = false;   // the next person to sign in gets their own tier
            document.getElementById('userBadge').hidden = true;
            document.getElementById('signInPromptBtn').hidden = false;
            document.getElementById('libraryScreen').hidden = true;
            document.getElementById('learningPath').classList.remove('active');
            document.getElementById('sourcePicker').hidden = false;
            hideAuthModal();
            setActiveNav('home');
        }

        function onSignedOut() {
            showAnonymousHome();
        }

        document.getElementById('authCloseBtn').addEventListener('click', () => {
            pendingAction = null;   // they backed out — don't resume whatever triggered this
            hideAuthModal();
        });

        // OAuth is a full-page redirect (to Google and back), which wipes any
        // in-memory JS state — stash the pending action in sessionStorage first
        // so onSignedIn() can still pick it up once we land back here.
        document.getElementById('authGoogleBtn').addEventListener('click', async () => {
            if (pendingAction) {
                try { sessionStorage.setItem('pending_action', JSON.stringify(pendingAction)); } catch (_) {}
            }
            const { error } = await supabaseClient.auth.signInWithOAuth({
                provider: 'google',
                options: { redirectTo: window.location.origin + window.location.pathname },
            });
            if (error) {
                const err = document.getElementById('authError');
                err.className = 'error-message';
                err.textContent = error.message;
                err.hidden = false;
            }
        });

        document.getElementById('authTabIn').addEventListener('click', () => setAuthMode('signin'));
        document.getElementById('authTabUp').addEventListener('click', () => setAuthMode('signup'));

        async function submitAuth() {
            const email = document.getElementById('authEmail').value.trim();
            const password = document.getElementById('authPassword').value;
            const isUp = document.getElementById('authTabUp').classList.contains('active');
            const err = document.getElementById('authError');
            err.className = 'error-message';
            err.hidden = true;

            if (!email || !password) {
                err.textContent = 'Enter an email and password.';
                err.hidden = false;
                return;
            }

            const btn = document.getElementById('authSubmitBtn');
            const originalBtnText = btn.textContent;
            btn.disabled = true;
            btn.textContent = isUp ? 'Creating account…' : 'Signing in…';
            try {
                const { data, error } = isUp
                    ? await supabaseClient.auth.signUp({ email, password })
                    : await supabaseClient.auth.signInWithPassword({ email, password });

                if (error) {
                    err.textContent = error.message;
                    err.hidden = false;
                    return;
                }
                if (isUp && !data.session) {
                    err.className = 'info-message';
                    err.textContent = 'Check your email to confirm your account, then sign in.';
                    err.hidden = false;
                    return;
                }
                if (!data.session) {
                    err.textContent = 'Something went wrong signing you in. Please try again.';
                    err.hidden = false;
                    return;
                }
                await onSignedIn(data.session.user);
            } catch (e) {
                // A thrown (not returned) error — e.g. a network hiccup — must
                // never leave the button silently stuck with no feedback.
                console.error('Auth failed:', e);
                err.textContent = 'Connection problem. Check your internet and try again.';
                err.hidden = false;
            } finally {
                btn.disabled = false;
                btn.textContent = originalBtnText;
            }
        }

        document.getElementById('authSubmitBtn').addEventListener('click', submitAuth);
        document.getElementById('authPassword').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') submitAuth();
        });

        // Enter from the email field moved nowhere, so the form felt unfinishable
        // from the keyboard. It now advances to the password.
        document.getElementById('authEmail').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); document.getElementById('authPassword').focus(); }
        });

        document.getElementById('authPasswordToggle').addEventListener('click', () => {
            const input = document.getElementById('authPassword');
            const btn = document.getElementById('authPasswordToggle');
            const showing = input.type === 'text';
            input.type = showing ? 'password' : 'text';
            btn.innerHTML = showing ? ICONS.eye : ICONS.eyeOff;
            btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
        });

        document.getElementById('authForgotBtn').addEventListener('click', async () => {
            const email = document.getElementById('authEmail').value.trim();
            const err = document.getElementById('authError');
            if (!email) {
                err.className = 'error-message';
                err.textContent = 'Enter your email above first, then tap this again.';
                err.hidden = false;
                return;
            }
            const { error } = await supabaseClient.auth.resetPasswordForEmail(email);
            err.className = 'info-message';
            err.textContent = error
                ? error.message
                : `If an account exists for ${email}, a reset link is on its way.`;
            err.hidden = false;
        });

        supabaseClient.auth.onAuthStateChange((event) => {
            if (event === 'SIGNED_OUT') onSignedOut();
        });

        // Initialize
        // Static icon slots that never change — filled once here rather than
        // duplicating the SVG markup inline in the HTML.
        const staticIcons = {
            hudIconStreak: 'flame', hudIconGems: 'gem', hudIconXp: 'star',
            libraryEmptyIcon: 'book', uploadIcon: 'file', reviewBannerIcon: 'refresh',
            navIconHome: 'home', navIconCourses: 'book', navIconReview: 'refresh', navIconAccount: 'account',
            tutorToggleIcon: 'chat', authInfoIcon: 'info', authCloseBtn: 'x',
        };
        Object.entries(staticIcons).forEach(([id, icon]) => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = ICONS[icon];
        });

        (async () => {
            try {
                const { data: { session } } = await supabaseClient.auth.getSession();
                if (session?.user) {
                    try {
                        const raw = sessionStorage.getItem('pending_action');
                        if (raw) {
                            pendingAction = JSON.parse(raw);
                            sessionStorage.removeItem('pending_action');
                        }
                    } catch (_) {}
                    await onSignedIn(session.user);
                } else {
                    showAnonymousHome();
                }
            } catch (e) {
                console.error('init failed:', e);
            }
        })();

        // Last statement in the file. index.html watches for this: every icon and
        // every button listener is registered above, so if this never runs the page
        // is half-wired and says so instead of looking fine and doing nothing.
        window.__appBooted = true;
