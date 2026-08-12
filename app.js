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
        const MAX_COURSES = 8;

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
            logout: svgIcon('<path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3"/><path d="M10 8l-4 4 4 4M6 12h9"/>'),
            key: svgIcon('<circle cx="8" cy="12" r="4"/><path d="M12 12h9M17 12v3.5M20 12v2.5"/>'),
            clock: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/>'),
            trash: svgIcon('<path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2"/><path d="M6 7l1 13h10l1-13"/>'),
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
        const MAX_TOKENS = { path: 4000, lesson: 5000, feedback: 250 };

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
            // A string is one block. An array is [shared context, this call's
            // prompt] — the split the server needs to mark the first one
            // cacheable, and the order matters: caching matches on a prefix, so
            // the half that repeats has to come first. Empty entries are dropped
            // rather than sent, so a tier with no context budget produces exactly
            // the single-block request it always did.
            const content = Array.isArray(userMessage)
                ? userMessage.filter(Boolean).map(text => ({ type: 'text', text }))
                : userMessage;
            const body = { messages: [{ role: 'user', content }], max_tokens: maxTokens };
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

        // ============= PDF text extraction =============
        // PDF has no notion of a paragraph — a page is a bag of positioned text
        // runs. Joining those runs with spaces (which is what this used to do)
        // throws away every line and paragraph boundary, so the model received one
        // undifferentiated smear per page: headings glued to body text, table cells
        // glued to their neighbours, and the page number welded onto the first
        // sentence. Everything downstream — concept extraction, chunking,
        // retrieval — is only as good as this step, so it reconstructs the layout
        // from the geometry PDF.js hands us instead of discarding it.

        const MAX_PDF_PAGES = 600;      // a hard stop, not a quality budget
        const MAX_SOURCE_CHARS = 600000; // what we're willing to keep per course

        // Two runs belong to the same visual line if their baselines are within a
        // fraction of the text height. Exact equality fails: superscripts, inline
        // maths and mixed font sizes all shift the baseline by a hair.
        const LINE_TOLERANCE = 0.5;

        // Enough of each direction to tell which way a line reads. Hebrew, Arabic
        // and their presentation forms against Latin, Greek and Cyrillic.
        const RTL_CHARS = /[֐-׿؀-ۿ܀-ݏݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿]/g;
        const LTR_CHARS = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/g;

        // Reconstruct one page's lines from positioned text runs.
        function pageItemsToLines(items) {
            const lines = [];

            for (const item of items) {
                const str = item.str;
                if (!str) continue;
                const tr = item.transform || [1, 0, 0, 1, 0, 0];
                const x = tr[4];
                const y = tr[5];
                const height = item.height || Math.abs(tr[3]) || 10;
                const width = item.width || 0;

                // Match against the most recent line first: PDF content streams are
                // usually emitted in reading order, so that is nearly always the hit.
                let line = null;
                for (let i = lines.length - 1; i >= 0 && i >= lines.length - 4; i--) {
                    if (Math.abs(lines[i].y - y) <= Math.max(1, height * LINE_TOLERANCE)) {
                        line = lines[i];
                        break;
                    }
                }
                if (!line) {
                    line = { y, height, runs: [] };
                    lines.push(line);
                } else {
                    line.height = Math.max(line.height, height);
                }
                line.runs.push({ str, x, width, height });
            }

            // Top of the page downwards. PDF's y axis grows upward, so descending y
            // is reading order.
            lines.sort((a, b) => b.y - a.y);

            return lines.map(line => {
                // Runs come in visual order — left to right across the page. For
                // Latin text that is also reading order, but a Hebrew or Arabic
                // line is read right to left, so its runs must be walked backwards.
                //
                // This only shows up on mixed lines. A run of pure Hebrew arrives
                // as a single run holding a correctly-ordered string, so it looks
                // fine either way; it is the moment a digit or a Latin word splits
                // the line into several runs — "פרק 2: המיטוכונדריה", every
                // numbered heading in the document — that visual order stops
                // matching reading order and the line comes out inside out.
                const joined = line.runs.map(r => r.str).join('');
                const rtl = (joined.match(RTL_CHARS) || []).length;
                const ltr = (joined.match(LTR_CHARS) || []).length;
                const isRTL = rtl > ltr;

                const runs = [...line.runs].sort((a, b) => isRTL ? b.x - a.x : a.x - b.x);

                let text = '';
                for (let i = 0; i < runs.length; i++) {
                    const run = runs[i];
                    if (i > 0) {
                        const prev = runs[i - 1];
                        // The gap between the two runs' facing edges, whichever
                        // direction the line is read in.
                        const gap = isRTL
                            ? prev.x - (run.x + run.width)
                            : run.x - (prev.x + prev.width);
                        const needsSpace = gap > Math.max(1, run.height * 0.2);
                        if (needsSpace && !/\s$/.test(text) && !/^\s/.test(run.str)) text += ' ';
                    }
                    text += run.str;
                }
                return { text: text.replace(/\s+/g, ' ').trim(), y: line.y, height: line.height };
            }).filter(line => line.text.length > 0);
        }

        // Running heads, folios and "Chapter 3 | 47" footers repeat on every page.
        // Left in, they are the single most frequent string in the document, which
        // makes them look important to anything that counts words — and they break
        // sentences apart wherever a page happens to turn.
        function stripRepeatedFurniture(pages) {
            const seen = new Map();

            // Two ways a line can be "the same line as last page". Exact match is
            // safe for anything. Ignoring digits is what catches "Page 12 of 40"
            // and "Chapter 3 | 47", but it also collapses genuine prose that
            // differs only by a number ("Sample 4 showed a marked response"), so
            // it is allowed only for lines short enough to be furniture in the
            // first place — a full sentence must repeat exactly to be dropped.
            const LOOSE_MAX = 50;
            const exact = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
            const loose = s => exact(s).replace(/\d+/g, '#');
            const keysFor = s => {
                const e = exact(s);
                if (!e || e.length >= 120) return [];
                // A heading is never matched loosely. "Chapter 1", "Chapter 2",
                // "Chapter 3" all collapse to "chapter #", so the loose rule would
                // see a running head repeating on every chapter opening and delete
                // the entire outline — the one part of the document that describes
                // its structure. An identical heading repeated verbatim is still
                // caught by the exact key.
                if (looksLikeHeading(e)) return [e];
                return e.length <= LOOSE_MAX ? [e, 'loose:' + loose(s)] : [e];
            };

            // Only the top and bottom few lines of a page can be furniture — and on
            // a sparse page (a title page, the last page of a chapter) a fixed two
            // from each end would cover the entire page and put real body text at
            // risk of being read as a running head.
            const edgeLines = page => {
                const n = Math.min(2, Math.floor(page.length / 3));
                return n < 1 ? [] : [...page.slice(0, n), ...page.slice(-n)];
            };

            for (const page of pages) {
                const keys = new Set();
                edgeLines(page).forEach(l => keysFor(l.text).forEach(k => keys.add(k)));
                keys.forEach(k => seen.set(k, (seen.get(k) || 0) + 1));
            }

            // Repeating on a third of a long document is furniture; on a 3-page
            // handout it is a coincidence, so require an absolute count too.
            const threshold = Math.max(3, Math.ceil(pages.length * 0.3));
            const furniture = new Set([...seen].filter(([, n]) => n >= threshold).map(([k]) => k));

            return pages.map(page => {
                const edges = new Set(edgeLines(page));
                return page.filter(line => {
                    if (/^[\s\-–—|]*\d{1,4}[\s\-–—|]*$/.test(line.text)) return false;  // a bare folio
                    if (!edges.has(line)) return true;
                    return !keysFor(line.text).some(k => furniture.has(k));
                });
            });
        }

        // Lines become paragraphs. A wider-than-usual vertical gap, an indent, or a
        // line that simply ends short of the margin all mark a break; anything else
        // is a soft wrap that should be joined back into one flowing sentence.
        function linesToParagraphs(lines) {
            if (!lines.length) return '';

            const gaps = [];
            for (let i = 1; i < lines.length; i++) gaps.push(Math.abs(lines[i - 1].y - lines[i].y));
            gaps.sort((a, b) => a - b);
            // The 40th percentile, not the median: paragraph breaks are a minority
            // of the gaps but a large enough one to drag a median upward, and on a
            // page with only a few lines the median lands on the paragraph gap
            // itself — which then measures as "normal" and no break is ever found.
            const medianGap = gaps.length ? gaps[Math.floor(gaps.length * 0.4)] : 0;
            const paragraphGap = medianGap * 1.4;

            const widths = lines.map(l => l.text.length).sort((a, b) => a - b);
            const typicalWidth = widths.length ? widths[Math.floor(widths.length * 0.75)] : 0;

            // Headings are set larger than body text, and that is a far more
            // reliable signal than spacing: the gap below a heading is often only
            // a few points wider than normal leading, which is not enough to
            // separate them — and a heading swallowed into the paragraph beneath
            // it is lost to the outline, which is where the document's structure
            // comes from.
            // The 40th percentile again, and for the same reason as the gaps: body
            // type is what we want to measure against, and on a sparse page — a
            // chapter opening with a heading and one paragraph — a median lands on
            // the heading itself, which then reads as "normal size" and no heading
            // is ever detected.
            const heights = lines.map(l => l.height).sort((a, b) => a - b);
            const typicalHeight = heights.length ? heights[Math.floor(heights.length * 0.4)] : 0;
            const prominent = l => typicalHeight > 0 && l.height > typicalHeight * 1.15;

            const paragraphs = [];
            let cur = '';

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!cur) { cur = line.text; continue; }

                const gap = Math.abs(lines[i - 1].y - line.y);
                const prevEndsSentence = /[.!?。！？׃:;]["')\]]?$/.test(lines[i - 1].text);
                const prevRunsShort = lines[i - 1].text.length < typicalWidth * 0.65;
                // Crossing between a larger-type run and body type, in either
                // direction, is a boundary: body ends where a heading starts, and
                // the heading ends where body type resumes.
                const sizeChanged = prominent(line) !== prominent(lines[i - 1]);

                if (sizeChanged || (medianGap > 0 && gap > paragraphGap) || (prevEndsSentence && prevRunsShort)) {
                    paragraphs.push(cur);
                    cur = line.text;
                    continue;
                }

                // A word broken across the line wrap: rejoin it rather than leaving
                // "photo- synthesis", which no search or tokeniser will ever match.
                if (/(\p{L})[-­]$/u.test(cur) && /^\p{Ll}/u.test(line.text)) {
                    cur = cur.replace(/[-­]$/, '') + line.text;
                } else {
                    cur += ' ' + line.text;
                }
            }
            if (cur) paragraphs.push(cur);

            return paragraphs.map(p => p.trim()).filter(Boolean).join('\n\n');
        }

        // Read the document. `onProgress` is called per page because a 300-page
        // textbook takes long enough that a frozen "Reading..." looks like a hang.
        async function extractConceptsFromPDF(file, onProgress) {
            if (!window.pdfjsLib) throw new Error('PDF_READER_UNAVAILABLE');
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

            const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
            const pages = [];

            for (let i = 1; i <= pageCount; i++) {
                if (onProgress) onProgress(i, pageCount);
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                pages.push(pageItemsToLines(textContent.items));
                // Pages hold on to their rendering resources until told otherwise,
                // and a few hundred of them will exhaust a phone's memory.
                page.cleanup();
            }

            const text = stripRepeatedFurniture(pages)
                .map(linesToParagraphs)
                .filter(Boolean)
                .join('\n\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim();

            return text.length > MAX_SOURCE_CHARS ? text.slice(0, MAX_SOURCE_CHARS) : text;
        }

        async function generateLessonPath(text) {
            showMessage("Analyzing your material...");

            // Not the first N characters of the document. The opening pages of a
            // textbook are a title page, a copyright notice and a table of contents
            // — the least conceptual text in the whole file — and a course built
            // from them lists the chapters instead of teaching them. The digest
            // reads the whole document and spends the budget on the parts that
            // actually carry concepts, spread from first page to last.
            const digest = buildSourceDigest(text, planReadChars());

            const extractPrompt = `Analyse the study material below and extract its key concepts.

The material is a digest of a longer document. Lines in [SQUARE BRACKETS] are
labels added by the app, not part of the document — do not treat them as content,
and do not let them influence which language you report. [...] marks text that was
left out. [OUTLINE] lists the document's own section headings in order, so use it
to understand the shape and coverage of the whole document even where the body
text below it was omitted.

MATERIAL:
${digest}

TASK:
1. Identify 10-20 core concepts a learner must understand from this material.
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
        // Everything downstream — lessons, feedback — must follow suit.
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
            ['lessonExplanation', 'lessonScroll', 'lessonPath'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.setAttribute('dir', dir);
            });
            const preview = document.getElementById('previewCard');
            if (preview) preview.setAttribute('dir', dir);
        }

        async function generateLesson(concept) {
            // Ground the lesson in the actual document, not the model's priors.
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
- Any [COURSE MATERIAL] above is background: use it to place this concept in the document, never as a source of facts or quiz answers.
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

            // The course context goes first and is the same on every lesson, so
            // the API caches it; the prompt goes second because it changes.
            const result = await callAI([courseContext(), prompt], '',
                { maxTokens: MAX_TOKENS.lesson, task: 'lesson' });

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

        function openDialog({ title, body = '', bodyHtml = null, confirmText = 'OK', cancelText = null,
                              danger = false, input = null, validate = null }) {
            const backdrop = document.getElementById('dialogBackdrop');
            const card = document.getElementById('dialogCard');
            const field = document.getElementById('dialogInput');
            const errorEl = document.getElementById('dialogError');
            const confirmBtn = document.getElementById('dialogConfirm');
            const cancelBtn = document.getElementById('dialogCancel');

            document.getElementById('dialogTitle').textContent = title;
            // textContent by default — a dialog usually carries a course name or an
            // error string. bodyHtml is opt-in and only ever passed app-authored
            // markup, never anything a user or a model wrote.
            const bodyEl = document.getElementById('dialogBody');
            if (bodyHtml !== null) bodyEl.innerHTML = bodyHtml;
            else bodyEl.textContent = body;
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

        const uiAlert = (body, title = 'Heads up', { html = false } = {}) =>
            openDialog({ title, confirmText: 'Got it', ...(html ? { bodyHtml: body } : { body }) });

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
            setScreen('home');
            document.getElementById('backToLibraryBtn').hidden = library.length === 0;
        }

        async function handleFileUpload(file) {
            // Name the file being read. "Reading PDF..." after picking the wrong one
            // from a list of near-identical names gives you nothing to check against.
            showMessage(`Reading ${file.name}...`);
            let text;
            try {
                text = await extractConceptsFromPDF(file, (page, total) => {
                    // A long document takes tens of seconds to read. Without a
                    // moving count that is indistinguishable from a hung tab.
                    if (total > 8) showMessage(`Reading ${file.name} — page ${page} of ${total}...`);
                });
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
            setScreen('path');

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

        // Every lesson in the open course that has a cached lesson to build
        // questions from — the pool a "practice anyway" session draws on when
        // nothing is actually due yet.
        function getPracticeLessons() {
            if (!courseData) return [];
            return courseData.concepts
                .map((_, i) => i)
                .filter(i => progress[i]?.completed && progress[i]?.lesson);
        }

        function renderReviewBanner() {
            const due = getDueLessons();
            const banner = document.getElementById('reviewBanner');
            if (banner) {
                banner.hidden = due.length === 0;
                if (due.length) {
                    document.getElementById('reviewBannerText').textContent = due.length === 1
                        ? '1 lesson is due for review'
                        : `${due.length} lessons are due for review`;
                }
            }
            // The dot means "there is something to review", not "in this course" —
            // otherwise the Review tab looks idle while another course is overdue.
            const elsewhere = (dueOverview || [])
                .filter(c => c.id !== activeCourseId)
                .reduce((n, c) => n + c.due, 0);
            const dot = document.getElementById('navReviewDot');
            if (dot) dot.hidden = due.length + elsewhere === 0;
        }

        // Pull 1-2 cached quiz questions per lesson. Reuses the questions the
        // learner already generated and paid for — a review session costs nothing.
        function buildReviewSteps(indices = getDueLessons()) {
            const items = [];
            indices.forEach(idx => {
                const lesson = progress[idx].lesson;
                const pool = [...(lesson.quiz || [])];
                if (lesson.challenge) pool.push(lesson.challenge);
                if (!pool.length) return;
                shuffle(pool).slice(0, 2).forEach(question => items.push({ lessonIndex: idx, question }));
            });
            return shuffle(items);
        }

        // `practice` sessions are the same questions without the bookkeeping: they
        // never move a lesson's schedule, so drilling something early can't push
        // its real review out to next month.
        function startReviewSession({ indices = null, practice = false } = {}) {
            const items = buildReviewSteps(indices || getDueLessons());
            if (!items.length) {
                showError(practice
                    ? 'No finished lessons in this course to practise yet.'
                    : 'Nothing is due for review in this course right now.');
                return;
            }

            const steps = items.map((_, i) => ({ type: 'reviewq', i }));
            steps.push({ type: 'reviewComplete' });

            lessonState = {
                lesson: { title: 'Review session' },
                steps, step: 0,
                correct: 0, total: 0,
                heartsLeft: 5,
                startedAt: Date.now(),
                review: { items, byLesson: {}, practice },
                result: null,
            };

            document.getElementById('lessonXpBadge').textContent = `${items.length} questions`;
            document.getElementById('lessonMeta').innerHTML = practice
                ? `<span class="meta-chip">${ICONS.refresh} Extra practice</span>`
                : `<span class="meta-chip">${ICONS.refresh} Spaced repetition</span>`;
            applyContentDirection();
            buildStepSegments(steps.length);
            renderHearts();
            openLessonScreen();
            renderStep();
        }

        function commitReviewResult() {
            const { byLesson, practice } = lessonState.review;
            if (!practice) {
                Object.entries(byLesson).forEach(([idx, stat]) => {
                    const accuracy = stat.total ? Math.round((stat.correct / stat.total) * 100) : 100;
                    scheduleReview(Number(idx), accuracy);
                });
                saveProgress();
                // The counts on the Review tab are now stale — refresh them in the
                // background so going back there doesn't show what you just cleared.
                loadDueOverview().then(renderReviewBanner);
            }
            bumpStreak();
            renderHud();
            return {
                lessonsReviewed: Object.keys(byLesson).length,
                correct: lessonState.correct,
                total: lessonState.total,
                practice: !!practice,
            };
        }

        // ============= Review screen =============
        // The Review tab used to be a shortcut that refused to work: with no course
        // open it threw an error and left you where you were. It's a screen now,
        // and it answers the same question for every course at once — what's due,
        // where, and what to do about it if nothing is.
        let dueOverview = null;   // [{ ...libraryEntry, due, scheduled, nextDueAt }]
        let xpByCourse = {};      // { courseId: xp } — every course, for the HUD total

        // Only `srs` and `xp` are selected, never `lesson` — the cached lesson JSON
        // is large and there are up to eight courses' worth of them. A row can only
        // have an srs schedule if it was completed, and completing a lesson caches
        // it, so counting schedules is enough to know what a session would contain.
        async function loadDueOverview() {
            if (!currentUser) { dueOverview = null; xpByCourse = {}; return null; }
            const { data, error } = await supabaseClient
                .from('progress')
                .select('course_id, srs, xp')
                .eq('completed', true);
            if (error) {
                console.error('loadDueOverview failed:', error);
                dueOverview = null;
                return null;
            }

            const now = Date.now();
            const byCourse = {};
            xpByCourse = {};
            (data || []).forEach(r => {
                xpByCourse[r.course_id] = (xpByCourse[r.course_id] || 0) + (r.xp || 0);
                const dueAt = r.srs?.dueAt;
                if (!dueAt) return;
                const b = byCourse[r.course_id] || (byCourse[r.course_id] = { due: 0, scheduled: 0, nextDueAt: null });
                b.scheduled++;
                if (dueAt <= now) b.due++;
                else if (b.nextDueAt === null || dueAt < b.nextDueAt) b.nextDueAt = dueAt;
            });

            dueOverview = library.map(c => ({
                ...c,
                ...(byCourse[c.id] || { due: 0, scheduled: 0, nextDueAt: null }),
            }));
            return dueOverview;
        }

        // "in 3 days" / "tomorrow" reads better than a date for anything close,
        // which is where reviews nearly always land.
        function relativeDay(ts) {
            const days = Math.ceil((ts - Date.now()) / 86400000);
            if (days <= 0) return 'today';
            if (days === 1) return 'tomorrow';
            if (days < 7) return `in ${days} days`;
            if (days < 60) return `in ${Math.round(days / 7)} weeks`;
            return `on ${new Date(ts).toLocaleDateString()}`;
        }

        async function showReview() {
            setScreen('review');
            renderReview();               // paint what we already know, then refresh
            if (!currentUser) return;
            await loadLibrary();
            await loadDueOverview();
            renderReview();
            renderReviewBanner();
        }

        function emptyState({ icon, title, body, actionId, actionLabel, secondary }) {
            return `
                <div class="screen-empty">
                    <div class="screen-empty-icon">${icon}</div>
                    <h3 class="screen-empty-title">${title}</h3>
                    <p class="screen-empty-body">${body}</p>
                    <div class="screen-empty-actions">
                        <button class="button" id="${actionId}">${actionLabel}</button>
                        ${secondary ? `<button class="button button-secondary" id="${secondary.id}">${secondary.label}</button>` : ''}
                    </div>
                </div>`;
        }

        function renderReview() {
            const body = document.getElementById('reviewBody');
            const sub = document.getElementById('reviewSubtitle');
            if (!body) return;

            if (!currentUser) {
                sub.textContent = 'Spaced repetition, once you have an account';
                body.innerHTML = emptyState({
                    icon: ICONS.refresh,
                    title: 'Reviews live in your account',
                    body: 'Finished lessons come back on a schedule — a day later, then six, then further out each time you get them right. Sign in and your reviews follow you to any device.',
                    actionId: 'reviewSignIn', actionLabel: 'Sign in',
                });
                document.getElementById('reviewSignIn').onclick = () => showAuthModal('signin');
                return;
            }

            const courses = dueOverview || [];

            if (!courses.length) {
                sub.textContent = 'Nothing to review yet';
                body.innerHTML = emptyState({
                    icon: ICONS.book,
                    title: 'Build a course first',
                    body: 'Reviews are built from lessons you have finished, so there is nothing to schedule until you have a course. Upload a PDF or paste your notes and the first one takes about a minute.',
                    actionId: 'reviewNewCourse', actionLabel: 'Create a course',
                });
                document.getElementById('reviewNewCourse').onclick = () => showNewCourse();
                return;
            }

            const totalDue = courses.reduce((n, c) => n + c.due, 0);
            const anyCompleted = courses.some(c => c.completedCount > 0);

            if (!anyCompleted) {
                sub.textContent = 'Nothing scheduled yet';
                body.innerHTML = emptyState({
                    icon: ICONS.star,
                    title: 'Finish a lesson to start the clock',
                    body: 'A lesson is scheduled for review the moment you complete it. Open a course, finish the first lesson, and it will be waiting here tomorrow.',
                    actionId: 'reviewOpenCourses', actionLabel: 'Open my courses',
                });
                document.getElementById('reviewOpenCourses').onclick = () => showLibrary();
                return;
            }

            const soonest = courses
                .map(c => c.nextDueAt)
                .filter(Boolean)
                .sort((a, b) => a - b)[0];

            sub.textContent = totalDue
                ? `${totalDue} lesson${totalDue === 1 ? '' : 's'} ready across your courses`
                : soonest ? `All caught up — next review ${relativeDay(soonest)}`
                : 'All caught up';

            // Due courses first, then whatever is scheduled soonest.
            const ordered = [...courses].sort((a, b) =>
                (b.due - a.due) || ((a.nextDueAt || Infinity) - (b.nextDueAt || Infinity)));

            body.innerHTML = `
                <div class="review-summary ${totalDue ? 'is-due' : ''}">
                    <div class="review-summary-num">${totalDue}</div>
                    <div class="review-summary-text">
                        <strong>${totalDue ? 'ready to review now' : 'due right now'}</strong>
                        <span>${totalDue
                            ? 'Reviews reuse questions you already generated, so they cost nothing.'
                            : soonest ? `Your next review comes back ${relativeDay(soonest)}. You can still practise early below — it won't change the schedule.`
                            : 'Finish a few more lessons and they will start coming back here.'}</span>
                    </div>
                </div>
                <div class="review-list">
                    ${ordered.map(c => {
                        const canPractise = c.completedCount > 0;
                        const status = c.due
                            ? `<span class="review-chip is-due">${c.due} due now</span>`
                            : c.nextDueAt
                                ? `<span class="review-chip">${ICONS.clock} Next ${relativeDay(c.nextDueAt)}</span>`
                                : `<span class="review-chip">No reviews scheduled</span>`;
                        return `
                        <div class="review-course">
                            <div class="review-course-main">
                                <div class="review-course-title">${esc(c.title)}</div>
                                <div class="review-course-meta">${c.completedCount} of ${c.conceptCount} lessons finished ${status}</div>
                            </div>
                            <div class="review-course-actions">
                                ${c.due ? `<button class="button" data-review="${esc(c.id)}">Review now</button>` : ''}
                                ${!c.due && canPractise ? `<button class="button button-secondary" data-practise="${esc(c.id)}">Practise early</button>` : ''}
                                ${!canPractise ? `<button class="button button-secondary" data-open="${esc(c.id)}">Open course</button>` : ''}
                            </div>
                        </div>`;
                    }).join('')}
                </div>`;

            // Each of these opens the course first: a session is built from that
            // course's cached lessons, which only exist in memory once it's open.
            body.querySelectorAll('[data-review]').forEach(btn => {
                btn.onclick = async () => {
                    if (await openCourse(btn.dataset.review)) startReviewSession();
                };
            });
            body.querySelectorAll('[data-practise]').forEach(btn => {
                btn.onclick = async () => {
                    if (await openCourse(btn.dataset.practise)) {
                        startReviewSession({ indices: shuffle(getPracticeLessons()).slice(0, 5), practice: true });
                    }
                };
            });
            body.querySelectorAll('[data-open]').forEach(btn => {
                btn.onclick = () => openCourse(btn.dataset.open);
            });
        }

        // ============= Duolingo-style HUD: streak, gems, hearts =============
        // The streak lives in `user_stats` now, like everything else about an
        // account. localStorage stays as a cache: it's what the HUD reads on the
        // first paint before the row arrives, and what keeps a streak intact for
        // someone who finishes a lesson while the network is down.
        // Keyed per account. Two people sharing a browser each have their own
        // cache, so signing in second doesn't inherit the first one's streak —
        // and doesn't push it up to their row on the next sync either.
        const STREAK_STORAGE = 'streak_data';   // legacy, unscoped: { count, lastActive }
        const streakKey = () => currentUser ? `${STREAK_STORAGE}:${currentUser.id}` : STREAK_STORAGE;

        let streak = { count: 0, lastActive: null };

        function todayStr(offsetDays = 0) {
            return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
        }

        function parseStreak(raw) {
            try {
                return JSON.parse(raw || 'null') || { count: 0, lastActive: null };
            } catch (_) {
                return { count: 0, lastActive: null };
            }
        }

        function readLocalStreak() {
            const scoped = localStorage.getItem(streakKey());
            if (scoped) return parseStreak(scoped);
            // First run after the key became per-account: adopt whatever the old
            // shared key holds, then let writeLocalStreak() move it across. Only
            // the first account to sign in on this browser inherits it, which is
            // the only guess available and the right one on a personal device.
            const legacy = localStorage.getItem(STREAK_STORAGE);
            if (legacy) {
                localStorage.removeItem(STREAK_STORAGE);
                return parseStreak(legacy);
            }
            return { count: 0, lastActive: null };
        }

        function writeLocalStreak(data) {
            try { localStorage.setItem(streakKey(), JSON.stringify(data)); } catch (_) {}
        }

        // Whichever record saw the learner more recently wins; on the same day the
        // higher count does. That is also the migration path — an existing local
        // streak is newer than the empty row it syncs against, so it survives the
        // move to the server instead of being reset to zero by it.
        function mergeStreak(a, b) {
            if (!a?.lastActive) return b;
            if (!b?.lastActive) return a;
            if (a.lastActive === b.lastActive) return a.count >= b.count ? a : b;
            return a.lastActive > b.lastActive ? a : b;
        }

        async function loadStreak() {
            const local = readLocalStreak();
            streak = local;
            renderHud();
            if (!currentUser) return streak;

            const { data, error } = await supabaseClient
                .from('user_stats')
                .select('streak_count, streak_last_active')
                .eq('user_id', currentUser.id)
                .maybeSingle();
            if (error) {
                console.error('loadStreak failed:', error);
                return streak;   // the cached one still shows something true-ish
            }

            const remote = data
                ? { count: data.streak_count, lastActive: data.streak_last_active }
                : { count: 0, lastActive: null };
            streak = mergeStreak(local, remote);
            writeLocalStreak(streak);
            // Only write back when the local copy was the one that won, so opening
            // the app on a second device doesn't churn the row for nothing.
            if (streak.lastActive && streak.lastActive !== remote.lastActive) saveStreak();
            renderHud();
            return streak;
        }

        // Fire-and-forget, like saveProgress — the local copy is already correct.
        async function saveStreak() {
            if (!currentUser) return;
            const { error } = await supabaseClient.from('user_stats').upsert({
                user_id: currentUser.id,
                streak_count: streak.count,
                streak_last_active: streak.lastActive,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'user_id' });
            if (error) console.error('saveStreak failed:', error);
        }

        function getStreak() {
            // The streak is only "alive" if the learner showed up today or yesterday.
            if (streak.lastActive !== todayStr() && streak.lastActive !== todayStr(-1)) return 0;
            return streak.count;
        }

        // Call once per completed lesson/review. Consecutive calendar days extend
        // the streak; a gap resets it; the same day twice is a no-op.
        function bumpStreak() {
            const today = todayStr();
            if (streak.lastActive === today) return;
            streak = {
                count: (streak.lastActive === todayStr(-1)) ? streak.count + 1 : 1,
                lastActive: today,
            };
            writeLocalStreak(streak);
            saveStreak();
        }

        // XP earned in every course, not just the open one. The open course is
        // summed live from `progress` so the number moves the instant a lesson
        // ends, and the rest comes from the overview query.
        function totalXp() {
            const others = Object.entries(xpByCourse)
                .filter(([id]) => id !== activeCourseId)
                .reduce((sum, [, xp]) => sum + xp, 0);
            const open = Object.values(progress).reduce((sum, p) => sum + (p?.xp || 0), 0);
            return others + open;
        }

        // Gems are a cosmetic currency derived from XP — no separate ledger to keep in sync.
        function renderHud() {
            const streakEl = document.getElementById('hudStreak');
            if (!streakEl) return;
            const xp = totalXp();
            streakEl.textContent = getStreak();
            document.getElementById('hudXp').textContent = xp;
            document.getElementById('hudGems').textContent = Math.floor(xp / 20);
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
        // Haiku 4.5 pricing: $1 per 1M input tokens, $5 per 1M output tokens.
        const PRICE_IN = 1 / 1_000_000;
        const PRICE_OUT = 5 / 1_000_000;

        // The Edge Function increments ai_usage server-side on every real call —
        // the client just reflects it. "cached" (this app's own lesson cache, not
        // an API call at all) is session-only, there's nothing server-side to sync.
        let usage = { calls: 0, inputTokens: 0, outputTokens: 0, cached: 0,
                      coursesMonth: 0, lessonsMonth: 0, monthResetAt: null };

        async function refreshUsage() {
            if (!currentUser) return;
            const { data } = await supabaseClient
                .from('ai_usage')
                .select('calls, input_tokens, output_tokens, courses_month, lessons_month, month_reset_at')
                .eq('user_id', currentUser.id)
                .maybeSingle();
            if (data) {
                usage.calls = data.calls;
                usage.inputTokens = data.input_tokens;
                usage.outputTokens = data.output_tokens;
                // The month counters are what the Edge Function actually meters
                // against your plan — the ones worth showing you before you hit them.
                usage.coursesMonth = data.courses_month || 0;
                usage.lessonsMonth = data.lessons_month || 0;
                usage.monthResetAt = data.month_reset_at || null;
            }
            renderUsage();
        }

        function recordCacheHit() {
            usage.cached++;
            renderUsage();
        }

        function totalCost() {
            return usage.inputTokens * PRICE_IN + usage.outputTokens * PRICE_OUT;
        }

        // Spend used to sit in the header on every screen. It belongs on the
        // Account page with the rest of the account facts — so the only thing this
        // does now is refresh that page if it happens to be open.
        function renderUsage() {
            if (document.getElementById('accountScreen')?.hidden === false) renderAccount();
        }

        // ============= Account screen =============
        // A mirror of the plan table the ai-proxy Edge Function enforces. It is
        // display only — the server decides — but it is the difference between
        // "why did that stop working" and knowing what you have left before you
        // spend it.
        // `readChars` and `excerptChars` mirror the PLANS table in the ai-proxy Edge
        // Function, which is the authority: it clamps every request down to the
        // caller's real tier. They are here so the client asks for the tier's full
        // size — a client that keeps sending Basic's 5,000 characters gets a Basic
        // -sized answer no matter what the account pays for, because the server can
        // only ever clamp down, never refill what the browser already cut away.
        // `contextChars` is the slice of the document sent with every lesson of a
        // course, byte-identical each time so the API can cache it: the first
        // lesson pays a write premium and the rest read it back at about a tenth
        // of input price. Zero on the Haiku tiers, where the minimum cacheable
        // prefix is 4,096 tokens — below that the API accepts the request, caches
        // nothing, and charges the premium anyway.
        const PLAN_LIMITS = {
            trial: { label: 'Free trial', courses: 1, lessonsPerCourse: 10, quality: 'Haiku',         readChars: 5000,   excerptChars: 2400,  contextChars: 0 },
            basic: { label: 'Basic',      courses: 3, lessonsPerCourse: 10, quality: 'Haiku',         readChars: 5000,   excerptChars: 2400,  contextChars: 0 },
            pro:   { label: 'Pro',        courses: 5, lessonsPerCourse: 12, quality: 'Sonnet',        readChars: 40000,  excerptChars: 8000,  contextChars: 24000 },
            max:   { label: 'Max',        courses: 8, lessonsPerCourse: 15, quality: 'Opus + Sonnet', readChars: 120000, excerptChars: 16000, contextChars: 48000 },
        };

        let entitlement = null;   // { status, plan, planKey, periodEnd, trialing, active }

        async function loadEntitlement() {
            if (!currentUser) { entitlement = null; return null; }
            const { data, error } = await supabaseClient
                .from('subscriptions')
                .select('status, plan, interval, current_period_end')
                .eq('user_id', currentUser.id)
                .maybeSingle();
            if (error) {
                console.error('loadEntitlement failed:', error);
                entitlement = null;
                return null;
            }
            const periodEnd = data?.current_period_end ? new Date(data.current_period_end).getTime() : null;
            const trialing = data?.status === 'trialing' && !!periodEnd && periodEnd > Date.now();
            const active = data?.status === 'active';
            entitlement = {
                status: data?.status || 'none',
                plan: data?.plan || 'basic',
                interval: data?.interval || 'month',
                periodEnd, trialing, active,
                // Same fallback the Edge Function uses: an unknown plan is the
                // smallest tier, never the largest.
                planKey: trialing ? 'trial' : (data?.plan && PLAN_LIMITS[data.plan] ? data.plan : 'basic'),
            };
            return entitlement;
        }

        async function showAccount() {
            setScreen('account');
            renderAccount();
            if (!currentUser) return;
            await Promise.all([loadEntitlement(), refreshUsage(), loadLibrary()]);
            renderAccount();
        }

        function meter(used, limit) {
            const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
            const tone = pct >= 100 ? 'is-full' : pct >= 75 ? 'is-high' : '';
            return `<div class="meter"><div class="meter-fill ${tone}" style="width:${pct}%"></div></div>`;
        }

        function renderAccount() {
            const body = document.getElementById('accountBody');
            if (!body) return;

            // Signed out is a state of this page, not a reason to throw a modal
            // over whatever you were looking at.
            if (!currentUser) {
                body.innerHTML = emptyState({
                    icon: ICONS.account,
                    title: "You're not signed in",
                    body: 'An account is what holds your courses, your progress and your review schedule — and it syncs them to any device you open this on. New accounts get a free trial course straight away.',
                    actionId: 'acctSignIn', actionLabel: 'Sign in',
                    secondary: { id: 'acctSignUp', label: 'Create an account' },
                });
                document.getElementById('acctSignIn').onclick = () => showAuthModal('signin');
                document.getElementById('acctSignUp').onclick = () => showAuthModal('signup');
                return;
            }

            const email = currentUser.email || 'Signed in';
            const initial = (email[0] || '?').toUpperCase();
            const joined = currentUser.created_at
                ? new Date(currentUser.created_at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
                : null;

            const ent = entitlement;
            const limits = PLAN_LIMITS[ent?.planKey || 'trial'];
            const lessonAllowance = limits.courses * limits.lessonsPerCourse;

            let planLine, planTone;
            if (!ent) { planLine = 'Checking your plan…'; planTone = ''; }
            else if (ent.trialing) {
                const days = Math.max(0, Math.ceil((ent.periodEnd - Date.now()) / 86400000));
                planLine = days === 0 ? 'Ends today' : `${days} day${days === 1 ? '' : 's'} left`;
                planTone = days <= 3 ? 'is-warn' : '';
            } else if (ent.active) {
                planLine = ent.periodEnd
                    ? `Renews ${new Date(ent.periodEnd).toLocaleDateString()}`
                    : `Billed ${ent.interval === 'year' ? 'yearly' : 'monthly'}`;
                planTone = '';
            } else {
                planLine = 'Ended — new lessons are paused';
                planTone = 'is-warn';
            }

            const lessonsDone = library.reduce((n, c) => n + c.completedCount, 0);
            const dueNow = (dueOverview || []).reduce((n, c) => n + c.due, 0);
            const resets = usage.monthResetAt
                ? new Date(new Date(usage.monthResetAt).getFullYear(), new Date(usage.monthResetAt).getMonth() + 1, 1)
                    .toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
                : null;

            body.innerHTML = `
                <div class="account-identity">
                    <div class="account-avatar">${esc(initial)}</div>
                    <div class="account-identity-text">
                        <div class="account-email">${esc(email)}</div>
                        <div class="account-sub">${joined ? `Learning here since ${esc(joined)}` : 'Signed in'}</div>
                    </div>
                </div>

                <section class="account-card">
                    <div class="account-card-head">
                        <h3>${esc(limits.label)}</h3>
                        <span class="plan-status ${planTone}">${esc(planLine)}</span>
                    </div>
                    <p class="account-card-note">
                        ${limits.courses} course${limits.courses === 1 ? '' : 's'} a month,
                        up to ${limits.lessonsPerCourse} lessons each, written by ${esc(limits.quality)}.
                    </p>
                    <div class="quota">
                        <div class="quota-row">
                            <span>Courses built this month</span>
                            <span class="quota-num">${usage.coursesMonth} / ${limits.courses}</span>
                        </div>
                        ${meter(usage.coursesMonth, limits.courses)}
                    </div>
                    <div class="quota">
                        <div class="quota-row">
                            <span>Lessons generated this month</span>
                            <span class="quota-num">${usage.lessonsMonth} / ${lessonAllowance}</span>
                        </div>
                        ${meter(usage.lessonsMonth, lessonAllowance)}
                    </div>
                    <p class="account-card-note">
                        ${resets ? `Resets ${esc(resets)}. ` : ''}Replaying a lesson you already have is free — only new generation counts.
                    </p>
                    <button class="button" id="acctPlans">${ent?.active ? 'Change plan' : 'See plans'}</button>
                </section>

                <section class="account-card">
                    <div class="account-card-head"><h3>Your learning</h3></div>
                    <div class="account-stats">
                        <div class="astat"><div class="astat-val">${getStreak()}</div><div class="astat-lbl">Day streak</div></div>
                        <div class="astat"><div class="astat-val">${totalXp()}</div><div class="astat-lbl">Total XP</div></div>
                        <div class="astat"><div class="astat-val">${library.length}</div><div class="astat-lbl">Courses</div></div>
                        <div class="astat"><div class="astat-val">${lessonsDone}</div><div class="astat-lbl">Lessons done</div></div>
                    </div>
                    ${dueNow ? `<button class="button button-secondary" id="acctReview">${dueNow} lesson${dueNow === 1 ? '' : 's'} due — review now</button>` : ''}
                </section>

                <section class="account-card">
                    <div class="account-card-head"><h3>AI spend</h3></div>
                    <p class="account-card-note">
                        What your generations have cost so far. Included in your plan — shown because
                        every lesson here is a real model call, not a canned one.
                    </p>
                    <div class="account-stats">
                        <div class="astat"><div class="astat-val">$${totalCost().toFixed(4)}</div><div class="astat-lbl">Total</div></div>
                        <div class="astat"><div class="astat-val">${usage.calls}</div><div class="astat-lbl">Model calls</div></div>
                        <div class="astat"><div class="astat-val">${usage.cached}</div><div class="astat-lbl">Cached this session</div></div>
                    </div>
                </section>

                <section class="account-card">
                    <div class="account-card-head"><h3>Settings</h3></div>
                    <button class="account-row" id="acctPassword">
                        <span class="account-row-icon">${ICONS.key}</span>
                        <span class="account-row-text">
                            <strong>Change password</strong>
                            <span>We'll email a reset link to ${esc(email)}</span>
                        </span>
                    </button>
                    <button class="account-row" id="acctSignOut">
                        <span class="account-row-icon">${ICONS.logout}</span>
                        <span class="account-row-text">
                            <strong>Sign out</strong>
                            <span>Your courses stay on this account</span>
                        </span>
                    </button>
                    <button class="account-row is-danger" id="acctWipe">
                        <span class="account-row-icon">${ICONS.trash}</span>
                        <span class="account-row-text">
                            <strong>Delete all courses</strong>
                            <span>Removes every course and all progress. Can't be undone.</span>
                        </span>
                    </button>
                </section>`;

            document.getElementById('acctPlans').onclick = () => showUpgradePrompt();
            const reviewBtn = document.getElementById('acctReview');
            if (reviewBtn) reviewBtn.onclick = () => showReview();

            document.getElementById('acctPassword').onclick = async () => {
                const { error } = await supabaseClient.auth.resetPasswordForEmail(currentUser.email);
                if (error) showError(error.message);
                else toast(`Reset link sent to ${currentUser.email}`);
            };

            document.getElementById('acctSignOut').onclick = async () => {
                const ok = await uiConfirm('Sign out?', `You're signed in as ${currentUser.email}. Your courses and progress stay on the account.`,
                    { confirmText: 'Sign out', danger: true });
                if (ok) await supabaseClient.auth.signOut();
            };

            document.getElementById('acctWipe').onclick = async () => {
                if (!library.length) { toast('There are no courses to delete', 'info'); return; }
                const ok = await uiConfirm(
                    `Delete all ${library.length} courses?`,
                    'Every course, every lesson you generated and all your progress are removed for good. Your account itself stays.',
                    { confirmText: 'Delete everything', danger: true });
                if (!ok) return;
                const { error } = await supabaseClient
                    .from('courses').delete().in('id', library.map(c => c.id));
                if (error) {
                    console.error('wipe failed:', error);
                    showError('Could not delete your courses. Nothing was removed.');
                    return;
                }
                library = [];
                activeCourseId = null; courseData = null; progress = {}; activeSourceText = '';
                localStorage.removeItem(ACTIVE_STORAGE);
                dueOverview = [];
                renderHud();
                renderReviewBanner();
                renderAccount();
                toast('All courses deleted');
            };
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

        // How much source each call may carry, per tier. The server clamps these
        // down to whatever the account actually pays for, so a tampered client
        // gains nothing — but until the client asks for the larger figure, the
        // clamp never fires and Pro and Max quietly read a Basic-sized document.
        // These have to match the PLANS table in the ai-proxy Edge Function.
        function planReadChars() {
            return (entitlement && PLAN_LIMITS[entitlement.planKey]?.readChars) || 5000;
        }
        function excerptBudget() {
            return (entitlement && PLAN_LIMITS[entitlement.planKey]?.excerptChars) || 2400;
        }
        function contextBudget() {
            return (entitlement && PLAN_LIMITS[entitlement.planKey]?.contextChars) || 0;
        }

        // The shared document context sent ahead of every lesson in a course.
        //
        // Two things make this worth having. It is a digest of the *whole*
        // document, so a lesson is no longer limited to the one passage its
        // concept was retrieved from — it can see how that concept sits in the
        // rest of the material. And because it is identical on every lesson of
        // the course, the API caches it: the first lesson pays to write it, the
        // rest read it back at roughly a tenth of input price.
        //
        // Byte-identical is the whole requirement — caching is a prefix match, so
        // a single character's difference makes every later lesson a fresh write.
        // `buildSourceDigest` is deterministic, so recomputing after a reload
        // produces the same bytes; the memo is here to avoid rebuilding a
        // 48,000-character digest on every lesson, not to guarantee sameness.
        let courseContextCache = { key: '', text: '' };

        function courseContext() {
            const budget = contextBudget();
            const source = getSourceText();
            if (!budget || !source) return '';

            const key = `${activeCourseId || 'none'}:${budget}:${source.length}`;
            if (courseContextCache.key !== key) {
                // The label is part of the cached block, so it has to be fixed
                // text — nothing per-lesson may appear here.
                const header = `[COURSE MATERIAL] A digest of the learner's whole document, the same for every lesson in this course. Lines in [SQUARE BRACKETS] are labels added by the app, not part of the document; [...] marks text left out. Use this for context — where a concept sits in the material, what came before it, what it connects to. The passage quoted in the lesson prompt below is the authority for facts.`;
                courseContextCache = { key, text: `${header}\n\n${buildSourceDigest(source, budget)}` };
            }
            return courseContextCache.text;
        }

        // Split on sentence boundaries where possible. A chunk that ends mid-sentence
        // gives the model a fragment it will happily complete from imagination.
        // Paragraph breaks, where the extractor found them, are stronger boundaries
        // than sentence ends: a chunk that stops at one holds a single idea rather
        // than the tail of a heading plus the start of the next section.
        function chunkText(text) {
            const blocks = splitBlocks(text);
            const chunks = [];
            let cur = '';

            const flush = () => {
                if (cur.trim().length > 80) chunks.push(cur.trim());
                cur = '';
            };

            for (const block of blocks) {
                // A paragraph that fits alongside what we have joins it; the seam is
                // marked so the model can see the two were not one running passage.
                if (cur && cur.length + block.length + 1 <= CHUNK_CHARS) {
                    cur += '\n' + block;
                    continue;
                }
                if (block.length <= CHUNK_CHARS) {
                    flush();
                    cur = block;
                    continue;
                }

                // A paragraph too long to be a chunk on its own — usually a page of
                // unbroken prose — falls back to sentence splitting.
                flush();
                const sentences = (block.match(/[^.!?。！？׃]+[.!?。！？׃]+|\S+$/g) || [block])
                    // Text with no sentence enders at all — OCR that lost its
                    // punctuation, a table flattened into one line — otherwise
                    // arrives here as a single "sentence" the size of the whole
                    // block, and sails through the loop below as one huge chunk
                    // that then outweighs every real chunk in the ranking.
                    .flatMap(s => s.length <= CHUNK_CHARS
                        ? [s]
                        : (s.match(new RegExp(`[\\s\\S]{1,${CHUNK_CHARS}}`, 'g')) || []));
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
                flush();
            }
            flush();
            return chunks;
        }

        // Paragraphs, when the source has them. Pasted text often arrives as one
        // wall with no blank lines at all, in which case the whole thing is a
        // single block and chunkText falls through to sentence splitting.
        function splitBlocks(text) {
            return String(text || '')
                .split(/\n\s*\n/)
                .map(b => b.replace(/\s+/g, ' ').trim())
                .filter(Boolean);
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

            const cap = excerptBudget();
            const chunks = chunkText(sourceText);
            if (!chunks.length) return '';
            if (chunks.length === 1) return chunks[0].slice(0, cap);

            const index = buildIndex(chunks);
            const query = tokenize([
                concept.name,
                concept.description,
                concept.importance,
                ...(concept.examples || []),
            ].join(' '));

            if (!query.length) return chunks[0].slice(0, cap);

            const ranked = index.tokenized
                .map((toks, i) => ({ i, score: scoreChunk(query, toks, index) }))
                .filter(r => r.score > 0)
                .sort((a, b) => b.score - a.score);

            // Nothing matched — the concept may be synthesised across the document.
            if (!ranked.length) return chunks[0].slice(0, cap);

            // Take the best chunk, then only add more if they are genuinely
            // comparable. Filling the budget blindly drags in neighbouring
            // sections and the model starts quizzing on the wrong chapter.
            const best = ranked[0].score;
            const RELEVANCE_FLOOR = 0.55;   // a chunk must score >=55% of the best

            const picked = [ranked[0].i];
            let budget = cap - chunks[ranked[0].i].length;

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
            return out.slice(0, cap);
        }

        // ============= Condensing a document for the planning call =============
        // The planner gets one shot at the whole document, and its budget is far
        // smaller than a textbook. What it is given decides which concepts exist,
        // so the goal is coverage — some evidence from every part of the document —
        // rather than depth on whichever part happened to come first.

        // Headings are the author's own summary of their document, already ordered
        // by prerequisite. A few hundred characters of them tell the planner more
        // about a 400-page book than any single chapter would.
        function looksLikeHeading(block) {
            const s = block.trim();
            if (s.length < 3 || s.length > 90) return false;
            if (/[.!?]["')\]]?$/.test(s)) return false;          // a sentence, not a heading
            if (/^\d+(\.\d+)*[.)]?\s+\p{L}/u.test(s)) return true; // "3.2 Photosynthesis"
            if (/^(chapter|section|part|unit|appendix|lesson)\b/iu.test(s)) return true;
            // \b is defined in terms of ASCII word characters, so it never matches
            // at the edge of a Hebrew word — these need an explicit lookahead.
            if (/^(פרק|חלק|יחידה|נספח|שיעור)(?=[\s:.\-–—]|$)/u.test(s)) return true;
            const words = s.split(/\s+/);
            if (words.length > 12) return false;
            // ALL CAPS, or Title Case across most words — both read as headings.
            const letters = s.replace(/[^\p{L}]/gu, '');
            if (letters.length > 2 && letters === letters.toUpperCase() && /\p{Lu}/u.test(letters)) return true;
            const capitalised = words.filter(w => /^\p{Lu}/u.test(w)).length;
            return words.length >= 2 && capitalised >= Math.ceil(words.length * 0.7);
        }

        function extractOutline(blocks, maxChars) {
            const out = [];
            let used = 0;
            for (const b of blocks) {
                if (!looksLikeHeading(b)) continue;
                const line = '- ' + b.trim();
                if (used + line.length + 1 > maxChars) break;
                out.push(line);
                used += line.length + 1;
            }
            return out;
        }

        // Build a digest of `text` that fits in `budget` characters.
        function buildSourceDigest(text, budget) {
            const source = String(text || '');
            if (source.length <= budget) return source;

            const blocks = splitBlocks(source);
            if (blocks.length <= 1) return source.slice(0, budget);

            // Reserve: outline gets a fifth, the opening an eighth (title, abstract
            // and introduction genuinely do say what a document is about), and the
            // closing a tenth (conclusions and summaries are dense with concepts).
            // The rest is spread across the body.
            const outlineBudget = Math.floor(budget * 0.20);
            const openingBudget = Math.floor(budget * 0.12);
            const closingBudget = Math.floor(budget * 0.10);

            const outline = extractOutline(blocks, outlineBudget);

            // Score every block by how much distinctive vocabulary it carries.
            // Boilerplate — copyright lines, running examples, navigation — reuses
            // words that appear everywhere, so it scores near zero; the passage
            // that introduces a term is where that rare term is densest.
            const docFreq = new Map();
            const tokenised = blocks.map(b => {
                const toks = tokenize(b);
                new Set(toks).forEach(t => docFreq.set(t, (docFreq.get(t) || 0) + 1));
                return toks;
            });
            const n = blocks.length;
            const density = blocks.map((b, i) => {
                const toks = tokenised[i];
                if (toks.length < 12) return 0;      // captions, page furniture, stubs
                let score = 0;
                new Set(toks).forEach(t => { score += Math.log(1 + n / (docFreq.get(t) || 1)); });
                // Divide by sqrt(length) so a long mediocre block cannot outrank a
                // short dense one purely by being long.
                return score / Math.sqrt(toks.length);
            });

            const opening = takeBlocks(blocks, 0, openingBudget);
            const closing = takeBlocks(blocks, blocks.length - 1, closingBudget, -1);

            // Walk the document in equal segments and take the densest block from
            // each. This is what guarantees the last chapter is represented: the
            // budget is divided by position first and quality only second.
            const bodyBudget = budget - outline.join('\n').length - opening.chars - closing.chars - 200;
            const body = [];
            let bodyUsed = 0;

            if (bodyBudget > 0) {
                // How many places in the document we can afford to sample. Sizing
                // this from the document's own paragraph length matters: a fixed
                // guess either asks for more sample points than the budget can pay
                // for, or — the worse failure — takes one short paragraph per
                // segment and leaves most of the budget unspent while whole
                // chapters go unrepresented.
                const lengths = blocks.map(b => b.length).sort((a, b) => a - b);
                const typical = Math.max(200, lengths[Math.floor(lengths.length / 2)] || 400);
                const SEGMENTS = Math.max(4, Math.min(60, Math.floor(bodyBudget / typical)));
                const size = Math.max(1, blocks.length / SEGMENTS);
                const taken = new Set([...opening.indices, ...closing.indices]);

                // Each pass nominates the best unused block from every segment,
                // then accepts nominations best-first until the budget runs out.
                //
                // Nominating first and spending afterwards is the whole point. If
                // segments simply spent as they were visited, the budget would be
                // exhausted somewhere in the middle of the document and every
                // segment after that would get nothing — reproducing, one level
                // down, the very bias this function exists to remove. Choosing
                // across all segments at once means what gets dropped is the
                // weakest passage, not the last one.
                for (let pass = 0; pass < 3 && bodyUsed < bodyBudget; pass++) {
                    const nominees = [];
                    for (let s = 0; s < SEGMENTS; s++) {
                        const from = Math.floor(s * size);
                        const to = (s === SEGMENTS - 1) ? blocks.length : Math.floor((s + 1) * size);
                        let bestIdx = -1;
                        let bestScore = 0;
                        for (let i = from; i < to; i++) {
                            if (taken.has(i)) continue;
                            if (blocks[i].length > bodyBudget) continue;
                            if (density[i] > bestScore) { bestScore = density[i]; bestIdx = i; }
                        }
                        if (bestIdx >= 0) nominees.push({ i: bestIdx, score: bestScore });
                    }
                    if (!nominees.length) break;

                    nominees.sort((a, b) => b.score - a.score);
                    let acceptedAny = false;
                    for (const nominee of nominees) {
                        if (bodyUsed + blocks[nominee.i].length > bodyBudget) continue;
                        taken.add(nominee.i);
                        body.push(nominee.i);
                        bodyUsed += blocks[nominee.i].length;
                        acceptedAny = true;
                    }
                    if (!acceptedAny) break;
                }
                body.sort((a, b) => a - b);
            }

            const parts = [];
            if (outline.length) parts.push('[OUTLINE]\n' + outline.join('\n'));
            if (opening.text) parts.push('[OPENING]\n' + opening.text);
            if (body.length) {
                let passage = '';
                body.forEach((idx, k) => {
                    if (k > 0) passage += (idx === body[k - 1] + 1) ? '\n\n' : '\n\n[...]\n\n';
                    passage += blocks[idx];
                });
                parts.push('[BODY — passages sampled across the whole document]\n' + passage);
            }
            if (closing.text) parts.push('[CLOSING]\n' + closing.text);

            return parts.join('\n\n').slice(0, budget);
        }

        // Consecutive blocks from one end of the document, up to a character budget.
        function takeBlocks(blocks, start, budget, step = 1) {
            const indices = [];
            let used = 0;
            for (let i = start; i >= 0 && i < blocks.length; i += step) {
                if (used + blocks[i].length > budget) break;
                indices.push(i);
                used += blocks[i].length;
            }
            indices.sort((a, b) => a - b);
            return {
                indices,
                chars: used,
                text: indices.map(i => blocks[i]).join('\n\n'),
            };
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

            // Two different limits, and only one of them was ever shown: how many
            // courses you may keep, and how many you may build this month. Hitting
            // the second one used to be a surprise mid-upload.
            const monthly = entitlement ? PLAN_LIMITS[entitlement.planKey] : null;
            count.textContent = `${library.length} of ${MAX_COURSES} kept`
                + (monthly ? ` · ${usage.coursesMonth} of ${monthly.courses} built this month` : '');
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
            setScreen('courses');
        }

        async function showNewCourse() {
            if (library.length >= MAX_COURSES) {
                showError(`You can keep ${MAX_COURSES} courses at a time. Delete one to add another.`);
                return;
            }
            // The server is the authority on quota and this copy of the count can
            // be a few minutes stale, so this warns rather than blocks — but it
            // warns before you pick a file, not after the upload finishes.
            const limits = entitlement ? PLAN_LIMITS[entitlement.planKey] : null;
            if (limits && usage.coursesMonth >= limits.courses) {
                const go = await uiConfirm(
                    'Out of courses this month',
                    `Your ${limits.label} plan builds ${limits.courses} course${limits.courses === 1 ? '' : 's'} a month and you've used ${usage.coursesMonth}. Building another will be refused until it resets. Everything you already have still works — you can open, replay and review any of it.`,
                    { confirmText: 'See plans' });
                if (go) { showUpgradePrompt(); return; }
            }
            setScreen('home');
            document.getElementById('backToLibraryBtn').hidden = library.length === 0;
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

            // Restore the path exactly as it was
            const path = document.querySelector('.path-container');
            if (path) {
                const behavior = path.style.scrollBehavior;
                path.style.scrollBehavior = 'auto';
                path.scrollTop = savedPathScroll;
                path.style.scrollBehavior = behavior;
            }
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
        // of the screen with the verdict and a big Continue.
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
            const { lessonsReviewed, correct, total, practice } = lessonState.result;
            const accuracy = total ? Math.round((correct / total) * 100) : 100;
            return `
                <div class="complete-screen">
                    <div class="complete-badge">${ICONS.refresh}</div>
                    <h3 class="complete-title">${practice ? 'Practice complete' : 'Review complete'}</h3>
                    <div class="complete-stats">
                        <div class="cstat"><div class="cstat-val">${lessonsReviewed}</div><div class="cstat-lbl">Lessons reviewed</div></div>
                        <div class="cstat"><div class="cstat-val">${accuracy}%</div><div class="cstat-lbl">Accuracy</div></div>
                        <div class="cstat"><div class="cstat-val">${correct}/${total}</div><div class="cstat-lbl">Correct</div></div>
                    </div>
                    <div class="step-note">${practice
                        ? 'Extra practice doesn\'t change your review schedule — your due dates are exactly where they were.'
                        : 'Lessons you remembered well come back later. Shaky ones come back tomorrow.'}</div>
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

        // ============= Screens & bottom nav =============
        // Every full-page view in the app is listed here, and setScreen() is the
        // only thing that switches between them. That single choke point is what
        // makes each tab a real page: whatever was showing before is closed, so a
        // screen is never left visible underneath the one you just opened.
        const SCREENS = {
            home:    'sourcePicker',
            courses: 'libraryScreen',
            review:  'reviewScreen',
            account: 'accountScreen',
        };

        function setScreen(name) {
            Object.entries(SCREENS).forEach(([key, id]) => {
                const el = document.getElementById(id);
                if (el) el.hidden = key !== name;
            });
            // The path is the one view driven by a class rather than [hidden]: its
            // layout is a flex column that only holds together at `display:flex`.
            document.getElementById('learningPath').classList.toggle('active', name === 'path');
            // The path lives under the Home tab — it's what Home shows once a
            // course is open, not a fifth tab.
            setActiveNav(name === 'path' ? 'home' : name);
            // The tagline is onboarding copy — it explains the app to someone who
            // has never used it. Once you're signed in and past the upload screen
            // it is just chrome eating the top third of a phone.
            const tagline = document.getElementById('t_subtitle');
            if (tagline) tagline.hidden = !!currentUser && name !== 'home';

            const main = document.querySelector('.main-content');
            if (main) main.scrollTop = 0;
        }

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
                displayLearningPath();
            } else if (library.length) {
                await showLibrary();
            } else {
                setScreen('home');
            }
        });

        document.getElementById('navCourses').addEventListener('click', showLibrary);
        document.getElementById('navReview').addEventListener('click', showReview);
        document.getElementById('navAccount').addEventListener('click', showAccount);

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

        // Wrapped, not passed by reference: the handler would otherwise hand the
        // click event straight into the options object.
        document.getElementById('startReviewBtn').addEventListener('click', () => startReviewSession());

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

        // Checkout isn't wired up yet (no Stripe), but the tiers are real — the
        // Edge Function already enforces them. Showing what each one is beats a
        // one-line "coming soon" that leaves you with nothing to do: the things
        // that still work without paying are spelled out at the bottom.
        function showUpgradePrompt() {
            const rows = Object.entries(PLAN_LIMITS)
                .filter(([key]) => key !== 'trial')
                .map(([key, p]) => {
                    const here = entitlement && !entitlement.trialing && entitlement.planKey === key;
                    // Roughly 1,800 characters to a printed page — close enough to
                    // turn an abstract character budget into something you can
                    // picture against the document you were about to upload.
                    const pages = Math.round(p.readChars / 1800);
                    return `<li${here ? ' class="is-current"' : ''}><strong>${p.label}</strong>${here ? ' — your plan' : ''}<br>
                        ${p.courses} courses a month · up to ${p.lessonsPerCourse} lessons each · written by ${p.quality}<br>
                        reads about ${pages} page${pages === 1 ? '' : 's'} of your document when planning the course</li>`;
                }).join('');

            uiAlert(
                `<ul class="plan-list">${rows}</ul>
                 <p>Checkout isn't live yet, so there's nothing to buy today. Until it is,
                 everything you've already built keeps working: open any course, replay any
                 lesson, and run reviews and extra practice as often as you like — replays
                 and reviews reuse lessons you already generated and don't count against
                 any limit.</p>`,
                entitlement?.trialing ? 'Plans' : 'Your trial has ended',
                { html: true });
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
            document.getElementById('signInPromptBtn').hidden = true;
            hideAuthModal();

            // Account-wide state, needed on every path: the streak and XP feed the
            // HUD that is on screen whatever you do next, and the plan feeds the
            // quota warning that has to be right before the first upload. These
            // used to be skipped entirely when a pending action resumed.
            loadEntitlement();
            loadStreak();

            if (pendingAction) {
                const action = pendingAction;
                pendingAction = null;
                await refreshUsage();
                await runPendingAction(action);
                loadDueOverview().then(() => { renderReviewBanner(); renderHud(); });
                return;
            }

            try {
                await refreshUsage();
                await loadLibrary();
                const lastId = localStorage.getItem(ACTIVE_STORAGE);
                if (lastId && library.some(c => c.id === lastId)) {
                    await openCourse(lastId);
                } else if (library.length) {
                    await showLibrary();
                } else {
                    setScreen('home');
                }
                loadDueOverview().then(() => { renderReviewBanner(); renderHud(); });
            } catch (e) {
                // Signed in successfully, but loading their data failed. Never
                // leave them staring at a blank screen with no explanation.
                console.error('Post-signin load failed:', e);
                showError('Signed in, but something went wrong loading your courses. Try refreshing the page.');
                setScreen('home');
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
            entitlement = null;
            dueOverview = null;
            xpByCourse = {};
            // The streak is the signed-out person's, not the one who just left —
            // it reloads from their own row (and their own cache) at next sign-in.
            streak = { count: 0, lastActive: null };
            document.getElementById('signInPromptBtn').hidden = false;
            hideAuthModal();
            setScreen('home');
            renderReviewBanner();
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
            authInfoIcon: 'info', authCloseBtn: 'x',
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
