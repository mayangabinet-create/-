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
            // The one screen that has to render when nothing else did. It uses the
            // page's own tokens — they live in index.html's <style>, which has
            // already parsed by the time this runs — so even the failure state is
            // part of the same design rather than a bare browser-looking page.
            document.body.innerHTML = `
                <div style="max-width:38ch;margin:15vh auto;text-align:center;padding:var(--sp-6);font-family:var(--font);color:var(--text);">
                    <h2 style="font-size:var(--fs-h2);margin-bottom:var(--sp-3);">Couldn't load the app</h2>
                    <p style="color:var(--text-muted);line-height:var(--lh-body);margin-bottom:var(--sp-5);">A required script didn't load. Check your internet connection, or try turning off an ad-blocker or VPN for this site, then try again.</p>
                    <button id="cdnFailureRetry" style="min-height:48px;padding:0 var(--sp-5);border:none;border-bottom:var(--press) solid var(--brand-strong);border-radius:var(--r-md);background:var(--brand);color:var(--text-inverse);font-family:var(--font);font-weight:700;font-size:var(--fs-body);cursor:pointer;">Try again</button>
                </div>`;
            // addEventListener, not an inline onclick= attribute: the CSP in
            // index.html's <head> has no 'unsafe-inline' for script-src, which
            // blocks inline event handlers along with everything else it blocks.
            document.getElementById('cdnFailureRetry').addEventListener('click', () => location.reload());
            throw new Error('supabase-js failed to load from CDN');
        }
        const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

        const ACTIVE_STORAGE = 'active_course_id';  // just "last opened", fine to keep per-device
        // The largest tier's figure — the fallback for a signed-out visitor or the
        // moment before entitlement has loaded. Once signed in, maxCourses() below
        // reads the account's own tier instead.
        const MAX_COURSES = 8;

        // ============= Theme =============
        // Absent key = follow the OS. An explicit 'light'/'dark' overrides it.
        // The inline script in <head> reads this same key to set data-theme
        // before first paint, so a returning learner never sees a flash of the
        // wrong theme; everything here just keeps the rest of the page (meta
        // chrome colour, live system-change updates, the Account toggle) in sync
        // with whatever that script already decided.
        const THEME_STORAGE = 'theme_pref';

        function themePref() {
            try { return localStorage.getItem(THEME_STORAGE); } catch (_) { return null; }
        }

        function effectiveTheme() {
            const pref = themePref();
            if (pref === 'light' || pref === 'dark') return pref;
            return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
        }

        function applyTheme() {
            const pref = themePref();
            const html = document.documentElement;
            if (pref === 'light' || pref === 'dark') html.setAttribute('data-theme', pref);
            else html.removeAttribute('data-theme');

            const themeColor = document.getElementById('metaThemeColor');
            if (themeColor) themeColor.setAttribute('content', effectiveTheme() === 'dark' ? '#14171C' : '#F4F5F7');
            const colorScheme = document.getElementById('metaColorScheme');
            if (colorScheme) colorScheme.setAttribute('content', pref === 'light' ? 'light' : pref === 'dark' ? 'dark' : 'light dark');
        }

        function setThemePref(pref) {
            try {
                if (pref) localStorage.setItem(THEME_STORAGE, pref);
                else localStorage.removeItem(THEME_STORAGE);
            } catch (_) { /* private mode: theme just won't persist across visits */ }
            applyTheme();
        }

        if (window.matchMedia) {
            window.matchMedia('(prefers-color-scheme: dark)')
                .addEventListener('change', () => { if (!themePref()) applyTheme(); });
        }

        let currentUser = null;
        let courseData = null;
        let currentLessonIndex = 0;
        let progress = {};
        let activeCourseId = null;
        let activeSourceText = '';
        // The outline of the active course's document, when it has one. Only a
        // document prepared by tools/pdf_prep arrives with structure already
        // known; everything else derives what it can from the text itself.
        let activeStructure = null;
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
            file: svgIcon('<path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/>'),
            info: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 8v.01"/>'),
            x: svgIcon('<path d="M6 6l12 12M18 6L6 18"/>'),
            pencil: svgIcon('<path d="M4 20h4L19 9a2.1 2.1 0 00-3-3L5 17z"/><path d="M14.5 6.5l3 3"/>'),
            logout: svgIcon('<path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3"/><path d="M10 8l-4 4 4 4M6 12h9"/>'),
            key: svgIcon('<circle cx="8" cy="12" r="4"/><path d="M12 12h9M17 12v3.5M20 12v2.5"/>'),
            clock: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/>'),
            trash: svgIcon('<path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2"/><path d="M6 7l1 13h10l1-13"/>'),
            // The first run's subjects and goals. Same line style as the rest —
            // a row of emoji next to Nunito would be a second typeface, chosen
            // by the operating system, in the first thing anyone sees.
            cap:       svgIcon('<path d="M2 9l10-4.5L22 9l-10 4.5z"/><path d="M6 11v5.5c0 1.7 2.7 3 6 3s6-1.3 6-3V11"/>'),
            briefcase: svgIcon('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0110.5 4h3A1.5 1.5 0 0115 5.5V7"/><path d="M3 12.5h18"/>'),
            compass:   svgIcon('<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>'),
            shapes:    svgIcon('<path d="M5 19h14L5 6z"/><path d="M8.5 19v-3.5H5"/>'),
            atom:      svgIcon('<circle cx="12" cy="12" r="2"/><ellipse cx="12" cy="12" rx="10" ry="4.2"/><ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(120 12 12)"/>'),
            pulse:     svgIcon('<path d="M2.5 12h4.2l2.1-5.5 3.6 11L14.8 12h6.7"/>'),
            chip:      svgIcon('<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>'),
            coins:     svgIcon('<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>'),
            bulb:      svgIcon('<path d="M12 3a6 6 0 00-3.4 10.9c.5.4.9 1 .9 1.6v.5h5v-.5c0-.6.4-1.2.9-1.6A6 6 0 0012 3z"/><path d="M9.5 19h5M10.5 21.5h3"/>'),
            sparkle:   svgIcon('<path d="M11 3l1.6 4.9L17.5 9.5l-4.9 1.6L11 16l-1.6-4.9L4.5 9.5l4.9-1.6z"/><path d="M18 15l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6z"/>'),
            moon:      svgIcon('<path d="M20 14.5A8.5 8.5 0 019.5 4 8.5 8.5 0 1020 14.5z"/>'),
        };

        // PDF.js loads on first use, not at boot: PDF upload is one optional path
        // into the app (pasting text is the other, and needs none of this), so
        // every visitor who never touches it was paying ~320KB and a render-blocking
        // script for a feature they didn't use. extractConceptsFromPDF() awaits this
        // before touching pdfjsLib; a blocked/slow CDN load surfaces there as
        // PDF_READER_UNAVAILABLE, same as it always did.
        const PDFJS_VERSION = '3.11.174';
        const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/`;
        let pdfjsLoadPromise = null;
        function loadPdfJs() {
            if (window.pdfjsLib) return Promise.resolve();
            if (pdfjsLoadPromise) return pdfjsLoadPromise;
            pdfjsLoadPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = PDFJS_BASE + 'pdf.min.js';
                // Same hash a static <script> tag would carry — computed from the
                // file as published to npm, same as the two in index.html's <head>.
                script.integrity = 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e';
                script.crossOrigin = 'anonymous';
                script.onload = () => {
                    if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js';
                    resolve();
                };
                script.onerror = () => reject(new Error('PDF_READER_UNAVAILABLE'));
                document.head.appendChild(script);
            });
            return pdfjsLoadPromise;
        }

        // ============= API & AI Functions =============
        // Token ceilings per task. Nothing here needs 3000 tokens except lesson JSON.
        // Hebrew runs ~2x the tokens of English, and this JSON is verbose.
        // Too low a ceiling truncates the response mid-object and JSON.parse dies.
        // A lesson now carries drawn figures and interactive widgets as well as
        // prose, and a lesson cut off mid-JSON is a lesson the learner cannot
        // open, so it asks for more room than it used to. The server clamps this
        // to whatever `classify()` allows: asking for more than the deployed
        // Edge Function grants is harmless — it comes back clamped, exactly as
        // before — so the client and the function can be deployed in either order.
        // `primer` is the material written for a topic nobody uploaded a
        // document for (see the first run). 1000 because that is exactly what
        // the Edge Function allows anything under the course threshold —
        // asking for more only buys a sentence cut in half.
        const MAX_TOKENS = { path: 4000, lesson: 6000, feedback: 250, primer: 1000 };

        let lastCallTruncated = false;

        const AI_ENDPOINT = `${SUPABASE_URL}/functions/v1/ai-proxy`;

        /**
         * Split an SSE stream into the JSON payloads it carries.
         *
         * The twin of the one in `policy.mjs`, and deliberately a copy: this
         * file is a script tag with no build step and that one is a Deno
         * module. Both do the same small thing — hold the tail of a chunk
         * until a blank line says the frame is whole, then parse what the
         * `data:` lines spell out — and neither is worth a module loader.
         */
        function sseScanner() {
            let buffer = '';
            return function push(chunk) {
                buffer += chunk;
                const parts = buffer.split(/\r?\n\r?\n/);
                buffer = parts.pop() ?? '';
                const out = [];
                for (const frame of parts) {
                    const data = frame.split(/\r?\n/)
                        .filter(line => line.startsWith('data:'))
                        .map(line => line.slice(5).trim())
                        .join('\n');
                    if (!data || data === '[DONE]') continue;
                    try { out.push(JSON.parse(data)); } catch (_) { /* not ours */ }
                }
                return out;
            };
        }

        /**
         * Read the model's answer as it is written.
         *
         * Nothing here makes the call faster: a 6,000-token lesson takes the
         * model exactly as long to write as it always did, and on the tiers
         * that run the larger models that is minutes, not seconds. What this
         * changes is what those minutes look like. The first words arrive in
         * about a second, so the wait can be reported as work in progress —
         * which part of the lesson is being written right now — instead of a
         * spinner that is indistinguishable from a hung tab.
         *
         * `onProgress` is handed the text so far after each chunk, never per
         * event: a token at a time would re-render the overlay a thousand
         * times for one lesson.
         */
        async function readAIStream(res, onProgress, onChunk) {
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            const scan = sseScanner();
            let text = '';
            let stopReason = null;

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                // A connection that died without a clean close never rejects
                // on its own — the socket just goes quiet — so the caller's
                // idle watchdog has to hear about every chunk that does
                // arrive to know the stream is still alive.
                if (onChunk) onChunk();
                // `stream: true` on the decoder: a Hebrew character split
                // across two network chunks is two bytes that only mean
                // something together, and decoding each half alone yields two
                // replacement characters in the middle of a word.
                for (const event of scan(decoder.decode(value, { stream: true }))) {
                    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                        text += event.delta.text;
                    } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
                        stopReason = event.delta.stop_reason;
                    } else if (event.type === 'error') {
                        throw new Error(event.error?.message || 'The model stopped mid-answer.');
                    }
                }
                if (onProgress) onProgress(text);
            }
            return { text, stopReason };
        }

        // Every generation call goes through the ai-proxy Edge Function instead of
        // Anthropic directly: it holds the real API key server-side, checks the
        // caller has an active subscription/trial, and enforces the daily cap.
        //
        // It is a bare `fetch` rather than `supabaseClient.functions.invoke`
        // because invoke reads the whole body before it returns, which is the
        // one thing a stream must not do.
        //
        // A connection a phone's OS or carrier network drops silently — no
        // TCP reset, just packets that stop arriving — never rejects `fetch`
        // on its own; the promise sits pending until some much longer OS
        // timeout, which from the learner's side is a lesson stuck on
        // "loading" forever with no error and nothing to retry. Every attempt
        // below gets a watchdog that aborts it once this long has passed with
        // not one byte back — headers, or the next streamed chunk — so a dead
        // connection fails fast into the retry this function already has,
        // instead of hanging past the point anyone is still waiting.
        const IDLE_TIMEOUT_MS = 30000;

        async function callAI(userMessage, systemPrompt = '', opts = {}) {
            lastCallTruncated = false;
            if (!currentUser) {
                showAuthModal('signin');
                return null;
            }

            const {
                retries = 2, maxTokens = 1000, task = null,
                stream = false, onProgress = null,
                // Work the learner did not ask for — a prefetch — reports its
                // failures to the console and nowhere else. An error toast for
                // a lesson nobody has opened yet is a bug report about a
                // lesson that is not on screen.
                quiet = false,
            } = opts;
            const fail = msg => { if (!quiet) showError(msg); };
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
            if (task) body.task = task;
            if (stream) body.stream = true;

            for (let attempt = 0; attempt <= retries; attempt++) {
                const controller = new AbortController();
                let idleTimer = null;
                const resetIdle = () => {
                    clearTimeout(idleTimer);
                    idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
                };
                try {
                    // Read the session on every attempt rather than once: a long
                    // generation can outlive an access token, and the retry
                    // that follows a 401 must not carry the same dead one.
                    const { data: { session } } = await supabaseClient.auth.getSession();
                    if (!session) {
                        showAuthModal('signin');
                        return null;
                    }

                    resetIdle();
                    const res = await fetch(AI_ENDPOINT, {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            'authorization': `Bearer ${session.access_token}`,
                            'apikey': SUPABASE_ANON_KEY,
                        },
                        body: JSON.stringify(body),
                        signal: controller.signal,
                    });
                    resetIdle();   // headers are back; still watching for a body that stalls

                    if (res.ok) {
                        // A function deployed before streaming existed answers
                        // a `stream: true` request with one JSON body, exactly
                        // as it always did. Deciding by what came back rather
                        // than by what was asked for is what lets the client
                        // and the function be deployed in either order.
                        const streamed = (res.headers.get('content-type') || '')
                            .includes('text/event-stream');

                        let text, stopReason;
                        if (streamed) {
                            // Every chunk that lands resets the watchdog, so a
                            // lesson genuinely taking its full minute or two
                            // is never mistaken for a dead connection — only
                            // silence this long is.
                            ({ text, stopReason } = await readAIStream(res, onProgress, resetIdle));
                        } else {
                            const data = await res.json();
                            stopReason = data.stop_reason;
                            text = (data.content || [])
                                .filter(p => p.type === 'text').map(p => p.text).join('');
                            if (onProgress) onProgress(text);
                        }

                        clearTimeout(idleTimer);
                        refreshUsage();
                        if (stopReason === 'max_tokens') {
                            console.warn('Response truncated at max_tokens');
                        }
                        lastCallTruncated = stopReason === 'max_tokens';
                        return text || '';
                    }

                    clearTimeout(idleTimer);
                    const status = res.status;
                    let payload = {};
                    try { payload = await res.json(); } catch (_) {}
                    console.error('ai-proxy error:', status, payload);

                    // Rate limited or overloaded — back off and retry
                    if ((status === 429 || status >= 500) && attempt < retries) {
                        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
                        continue;
                    }

                    if (status === 401) {
                        fail("Your session expired. Please sign in again.");
                        await supabaseClient.auth.signOut();
                        showAuthModal('signin');
                        return null;
                    }
                    if (status === 402) {
                        fail(payload.message || "Your trial has ended. Subscribe to keep generating lessons.");
                        if (!quiet) showUpgradePrompt();
                        return null;
                    }
                    if (status === 429) {
                        fail(payload.message || "Daily limit reached. Try again tomorrow.");
                        return null;
                    }

                    fail(payload.message || payload.error || `HTTP ${status || 'error'}`);
                    return null;

                } catch (error) {
                    clearTimeout(idleTimer);
                    console.error('Network error:', error);
                    // A stream that broke after the model had already written
                    // half a lesson is not worth restarting from nothing on a
                    // tier where that half took a minute — but a stream that
                    // broke is also not a lesson, so the retry is the only way
                    // to get one. Retry, and let the quota do the arguing.
                    if (attempt < retries) {
                        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
                        continue;
                    }
                    fail("Connection problem. Check your internet and try again.");
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
            await loadPdfJs();
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

        // Shared by both plan prompts below — the JSON shape and the language
        // rule are identical either way, only the TASK section above them
        // differs. Kept as one string so the two prompts cannot drift apart on
        // the part that the rest of the app actually parses.
        const PLAN_DOMAIN_KIND_RULE = `   - domain: the subject it belongs to, which decides which ready-made
     figures its lesson may use. Exactly one of:
       math | physics | cs | logic | data | science | finance | other
     Use "other" honestly — for history, law, literature, medicine, business
     and anything else. It is not a lesser option.
   - kind: what sort of thing it is, which decides how its lesson will be
     taught. Exactly one of:
       geometry       — figures, shapes, sides, angles, areas
       quantity       — formulas, rates, money, measurements, anything calculated
       process        — steps or stages in an order, including repeating cycles
       timeline       — events fixed in time
       comparison     — two or more things set against each other
       classification — a set of things divided into groups
       definition     — a term and what it means
       text           — wording, sources, terminology, interpretation`;

        function planSchemaAndLanguage(exampleConcept) {
            return `Return valid JSON only (no markdown, no surrounding prose), in exactly this shape:
{
  "courseName": "Course title",
  "language": "The language of the MATERIAL above, as an English name (e.g. English, Hebrew, Spanish)",
  "concepts": [
    ${exampleConcept}
  ]
}

LANGUAGE: write every string above in the same language as the MATERIAL.
If the material is in Hebrew, write in Hebrew. If Spanish, Spanish. Do not translate.
The exceptions are "language", "domain" and "kind", which are labels the app
reads: keep those in English, spelled exactly as listed above. "section" is not
written at all — it is copied from the outline, character for character, in
whatever language the outline is in, because the app looks it up there.`;
        }

        function buildTopicPlanPrompt(digest) {
            return `Analyse the study material below and extract its key concepts.

The material is a digest of a longer document. Lines in [SQUARE BRACKETS] are
labels added by the app, not part of the document — do not treat them as content,
and do not let them influence which language you report. [...] marks text that was
left out.

[OUTLINE] is the document's own structure: its parts, in order, indented by depth,
each with the share of the document it takes up. It is complete even where the
body below it is not. Treat it as the map of what this document covers — a part
listed there with no passage under it is still part of the document, and a course
that skips it has skipped a chapter of the book.

Under [BODY], a line like [Chapter 2 › 2.1 Rates] says which part the passage
below it came from.

MATERIAL:
${digest}

TASK:
1. Identify 10-20 core concepts a learner must understand from this material.
2. Order them by logical progression — prerequisites first.
3. Cover the outline. Spread the concepts across the document's parts in rough
   proportion to their share, rather than drawing them all from the parts that
   happen to have the most passages quoted below. A part with a large share and
   no passage is a gap in the digest, not a gap in the document: name the concept
   its heading implies and let the lesson find the text later.
4. For each concept give:
   - name (1-4 words)
   - description (one sentence)
   - difficulty (1-5)
   - why it matters
${PLAN_DOMAIN_KIND_RULE}

${planSchemaAndLanguage(`{
      "id": 1,
      "name": "Concept name",
      "description": "One-sentence description",
      "difficulty": 2,
      "domain": "other",
      "kind": "definition",
      "section": "The [OUTLINE] heading this concept comes from, copied exactly, or \\"\\" if it spans the whole document",
      "importance": "Why this matters",
      "examples": ["Example 1", "Example 2"]
    }`)}`;
        }

        // Worksheet mode: the model is not asked to synthesize themes, it is
        // asked to enumerate the material's own exercises — every one of them,
        // in the order they appear, none merged, none invented. There is no
        // "10-20" here on purpose: the count is whatever the worksheet actually
        // contains, and the server does not rewrite it to the tier's number
        // for a `worksheet` call the way it does for `path` (see
        // `shouldFixCourseSize` in policy.mjs). What still caps the cost is the
        // same monthly lesson quota every course draws from — a worksheet with
        // more exercises just spends more of that same budget, the way three
        // short courses would.
        function buildWorksheetPlanPrompt(digest) {
            return `Analyse the worksheet below and list every exercise in it — not the topics
behind them, the exercises themselves.

The material is a digest of the document. Lines in [SQUARE BRACKETS] are labels
added by the app, not part of the document — do not treat them as content, and
do not let them influence which language you report. [...] marks text that was
left out. If [OUTLINE] appears, it is the document's own structure (its parts,
in order) — use it only to say which part an exercise belongs to, if the
worksheet is organised into parts; most are not, and that is fine.

MATERIAL:
${digest}

TASK:
1. List every distinct exercise, problem or question in this material, in the
   exact order they appear. Do not skip any. Do not merge two exercises into
   one entry. Do not invent one the material does not contain.
2. If the material numbers or labels them (Exercise 3, תרגיל ב, Question 12,
   שאלה 4), start "name" with that exact label. If it does not label them,
   number them yourself in the order they appear ("Exercise 1", "Exercise 2", …).
3. For each exercise give:
   - name: its label (see above), plus a 2-4 word hint at what it asks
   - description: the exercise itself, in full — the actual question or
     problem as written in the material, not a summary of its topic
   - difficulty (1-5)
   - why it matters: what solving it practises, in one short phrase
${PLAN_DOMAIN_KIND_RULE}

${planSchemaAndLanguage(`{
      "id": 1,
      "name": "Exercise 3 — solving for x",
      "description": "The exercise itself, copied in full from the material",
      "difficulty": 2,
      "domain": "math",
      "kind": "quantity",
      "section": "The [OUTLINE] heading this exercise comes from, copied exactly, or \\"\\" if there is none",
      "importance": "What solving it practises",
      "examples": []
    }`)}`;
        }

        /**
         * The first concept, as soon as the plan has finished writing it.
         *
         * Course planning and lesson writing used to run strictly one after the
         * other, and both are slow for the same reason: thousands of output
         * tokens, generated one at a time. Nothing about caching touches that.
         * But the two do not actually depend on each other end to end — writing
         * lesson 1 needs *one* concept, not the whole list — so the moment the
         * first one is complete the second call can start, and the learner
         * waits for the longer of the two rather than the sum.
         *
         * `importance` is the gate rather than `name`, because the plan writes
         * a concept's fields in a fixed order and `importance` is the last one
         * the lesson prompt actually reads. Seeing it means `domain` and `kind`
         * have landed too, so the lesson starts with its template shelf and its
         * playbook rather than without them.
         *
         * `language` is reported before `concepts` in the same schema, which is
         * what makes this safe at all: a lesson started without it would be
         * written in whatever `courseLanguage()` guessed from an empty list —
         * English — for a course whose material is Hebrew.
         */
        function firstPlannedConcept(text) {
            if (!text.includes('"concepts"')) return null;
            const draft = extractJSON(text);
            const c = draft?.concepts?.[0];
            if (!draft?.language || !c?.name || !c?.description || !c?.importance) return null;
            return { language: draft.language, concept: c };
        }

        async function generateLessonPath(text, structure = null, worksheet = false, { onFirstConcept = null, onConcepts = null } = {}) {

            // Not the first N characters of the document. The opening pages of a
            // textbook are a title page, a copyright notice and a table of contents
            // — the least conceptual text in the whole file — and a course built
            // from them lists the chapters instead of teaching them. The digest
            // reads the whole document and spends the budget on the parts that
            // actually carry concepts, spread from first page to last.
            const digest = buildSourceDigest(text, planReadChars(), structure);
            const extractPrompt = worksheet ? buildWorksheetPlanPrompt(digest) : buildTopicPlanPrompt(digest);

            let firedFirst = false;
            // Grows past 1 as the plan keeps streaming, so the path on screen
            // can grow with it instead of sitting on a spinner until every
            // concept the tier asked for has landed. Gated on the count of
            // `"importance"` fields — cheap, and the same signal
            // `firstPlannedConcept` already trusts for "this concept is
            // whole" — so a full `extractJSON` only runs when a concept has
            // actually finished, not on every network chunk.
            let reportedCount = 0;
            const result = await callAI(extractPrompt, '', {
                maxTokens: MAX_TOKENS.path, task: worksheet ? 'worksheet' : 'path',
                stream: true,
                onProgress: (streamed) => {
                    pathProgress(streamed);
                    if (!firedFirst && onFirstConcept) {
                        const first = firstPlannedConcept(streamed);
                        if (first) {
                            firedFirst = true;
                            try {
                                onFirstConcept(first);
                            } catch (err) {
                                // Starting lesson 1 early is an optimisation. A course
                                // that plans fine must not fail because of it.
                                console.warn('Could not start the first lesson early:', err);
                            }
                        }
                    }
                    if (!onConcepts) return;
                    const doneSoFar = (streamed.match(/"importance"\s*:/g) || []).length;
                    if (doneSoFar <= reportedCount) return;
                    const draft = extractJSON(streamed);
                    const concepts = (draft?.concepts || [])
                        .filter(c => c && c.name && c.description && c.importance);
                    if (concepts.length <= reportedCount) return;
                    reportedCount = concepts.length;
                    try {
                        onConcepts({ language: draft.language, concepts });
                    } catch (err) {
                        console.warn('Could not grow the path early:', err);
                    }
                },
            });
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

        // The question types, in the same shape as VISUALS and for the same
        // reason: the catalogue the model is shown is generated from the list the
        // app can actually grade.
        const QUESTION_TYPES = {
            choice: {
                use: 'one right answer among options',
                spec: '{"type":"choice","text":"…","options":["A","B","C","D"],"correct":0,"explanation":"…"}',
            },
            boolean: {
                use: 'a single claim to judge true or false',
                spec: '{"type":"boolean","text":"A claim","answer":true,"explanation":"…"}',
            },
            numeric: {
                use: 'a number worked out and typed. Use for anything calculable — options give a calculation away. "tolerance" is how far off still counts (0 = exact)',
                spec: '{"type":"numeric","text":"…","answer":12.5,"tolerance":0.1,"unit":" cm","explanation":"…"}',
            },
            order: {
                use: 'arrange into the right sequence. List items in the CORRECT order; the app shuffles them',
                spec: '{"type":"order","text":"Put these in order","items":["first","second","third"],"explanation":"…"}',
            },
            categorize: {
                use: 'sort items into buckets',
                spec: '{"type":"categorize","text":"Sort these","buckets":["Group A","Group B"],"items":[{"text":"thing","bucket":"Group A"}],"explanation":"…"}',
            },
            match: {
                use: 'pair items from two columns',
                spec: '{"type":"match","text":"Match each to its partner","pairs":[{"left":"Heart","right":"Pumps blood"}],"explanation":"…"}',
            },
            blank: {
                use: 'fill the gap in a sentence. Write the gap as ___',
                spec: '{"type":"blank","text":"Water boils at ___ degrees.","options":["50","100","200"],"correct":1,"explanation":"…"}',
            },
            mistake: {
                use: 'find the one wrong statement among correct ones. Each option is one self-contained '
                    + 'claim — never alternatives joined by "or", never labelled right/wrong in its own text',
                spec: '{"type":"mistake","text":"Which statement is WRONG?","options":["A squared plus B squared equals C squared","The hypotenuse is the shortest side","Both legs are shorter than the hypotenuse"],"correct":1,"explanation":"…"}',
            },
            hotspot: {
                use: 'tap a part of a figure. "visual" must be a shape; "target" is side:N, vertex:N or angle:N, numbered as in that shape',
                spec: '{"type":"hotspot","text":"Tap the hypotenuse","visual":{"type":"shape","shape":"right-triangle","sides":[3,4,5],"sideLabels":["3","4","5"]},"target":"side:2","explanation":"…"}',
            },
        };

        function questionCatalogue() {
            return Object.entries(QUESTION_TYPES)
                .map(([name, def]) => `  "${name}" — ${def.use}\n      ${def.spec}`)
                .join('\n');
        }

        // What tends to teach each kind of concept well. The course plan labels
        // every concept with a kind; this turns that label into a short, concrete
        // instruction instead of leaving the model to pick from eighteen types
        // with no guidance — which is how every lesson ended up as four bullet
        // lists and a multiple-choice question.
        const KIND_PLAYBOOK = {
            geometry: 'shape (draw the figure, and give real "sides" so it is drawn to scale), formula, hotspot questions on the figure, numeric answers, and a slider when one measurement drives another.',
            quantity: 'formula with every symbol explained, equation worked line by line, slider to show what depends on what, numberline for thresholds and ranges, plot/bar/pie for magnitudes — and numeric questions, not multiple choice.',
            process: 'flow for a one-way sequence, cycle when it returns to its start, and order questions.',
            timeline: 'timeline, plus order questions over the same events.',
            comparison: 'compare or venn, a table of the differing fields, and categorize questions.',
            classification: 'hierarchy, venn or grid, and categorize questions.',
            definition: 'reveal cards so the learner recalls before reading, hierarchy for the parts of the definition, match and blank questions.',
            text: 'table of the terms and what they mean, reveal cards, match and mistake questions.',
        };

        /**
         * How the learner has actually been doing, as one line to the model.
         *
         * Every lesson in a course was pitched identically no matter what
         * happened in the previous nine — someone scoring 100% got the same
         * gentleness as someone scoring 45%. This is the cheapest possible fix
         * for that: no extra call, no extra tokens worth counting, one
         * sentence in a prompt that is already being sent.
         *
         * It says nothing in the middle of the range, where "keep doing what
         * you are doing" is not an instruction, and nothing at all until two
         * lessons are done, because one score is a mood rather than a level.
         */
        function calibrationNote() {
            const done = Object.values(progress)
                .filter(p => p?.completed && typeof p.accuracy === 'number');
            if (done.length < 2) return '';
            const avg = done.reduce((sum, p) => sum + p.accuracy, 0) / done.length;
            if (avg >= 90) return `\nThis learner is scoring near the top of this course. Pitch harder: fewer questions that restate a fact, more that take two steps.\n`;
            if (avg <= 60) return `\nThis learner is struggling in this course. Go slower: one idea per question, and distractors clearly wrong once the idea has landed.\n`;
            return '';
        }

        // The three pieces below are the parts of the lesson prompt that do not
        // depend on the concept: `lessonPrinciplesAndVisuals` and
        // `lessonQuestionTypes` are identical for every lesson, of any domain,
        // in any course, for any user; `lessonDomainToolkit` depends only on
        // the concept's domain. `buildLessonPrompt` still assembles all three
        // inline, byte-for-byte as before, for Trial and Basic — Haiku's cache
        // minimum is 4,096 tokens and none of this clears it on its own, so
        // there is nothing to gain there and the single-block prompt stays
        // exactly what it always was. Pro and Max send these three as their
        // own cache blocks instead (see `generateLesson`), which is the only
        // reason `buildLessonPrompt` now takes a `standalone` flag: false
        // leaves this content out because it is arriving separately, already
        // cached, in front of it.
        function lessonPrinciplesAndVisuals() {
            return `Principles:
- Never a wall of text. Each card = ONE idea, 2-3 sentences.
- Assume no prior knowledge. Open with curiosity, not a definition.
- SHOW, don't only tell. If an idea has a shape, a quantity, a sequence or a
  comparison in it, draw it. Prose describing a figure the app could have drawn
  is the worst thing this lesson can contain.
- Distractors must be mistakes a real learner would make.
- Vary the position of the correct answer. Never always first.
- Explanations must match the arithmetic shown, not a rule that merely
  sounds right — check any sign, sum or size claim against those numbers.

VISUALS — attach one to a card, worked example, summary or question in its
"visual" field; omit it where a diagram adds nothing. Never invent a type not on
this list — it is discarded.

${visualCatalogue()}

Rules: labels under 6 words, 2-5 items each. Numbers in a "shape", "slider" or
"gematria" are drawn exactly as given — a wrong number is a wrong picture.`;
        }

        function lessonQuestionTypes() {
            return `QUESTION TYPES — each needs "type", "text" and "explanation", and may carry a
"visual" it asks about.

${questionCatalogue()}`;
        }

        // Only this subject's shelf of templates is offered, and only if the
        // subject has one. A concept with no domain gets the primitives and
        // nothing else — which is the format exactly as it was.
        function lessonDomainToolkit(domain) {
            const templates = templateCatalogue(domain);
            if (!templates) return '';
            return `TEMPLATES — prefer these over writing a spec yourself. In "visual" write
{ "template": "<id>", "params": { … } } and the app builds the figure and every
calculation in it. Give the numbers the SOURCE MATERIAL uses, never the results
— working those out is the app's job. One template may produce several figures.

${templates}`;
        }

        // The domain-independent half of the toolkit, as one block: sent ahead
        // of everything else on Pro/Max (see `generateLesson`) so it can cache
        // at the widest possible scope — this text never changes, not between
        // concepts, not between courses, not between accounts.
        function lessonToolkitGlobal() {
            return `${lessonPrinciplesAndVisuals()}

${lessonQuestionTypes()}`;
        }

        // Built as its own function so its size can be measured. The server
        // clamps this block to `excerptChars + TEMPLATE_ALLOWANCE`, and a prompt
        // that overruns is truncated silently — from the tail, which is where
        // the JSON schema and the quantity rules are. `tests/lesson-visuals.js`
        // asserts the template still fits on every tier — with the calibration
        // line above included, since that is the prompt a real learner gets.
        //
        // `standalone` (default true) inlines the toolkit pieces above, giving
        // the exact single string every tier sent before caching split it up.
        // `generateLesson` passes false on Pro/Max, where those pieces are sent
        // as their own cached blocks ahead of this one instead of inside it.
        function buildLessonPrompt(concept, excerpt, standalone = true) {
            // A course planned by an older build has no kind, and a model can
            // still hand back a stray capital or a plural. Neither is worth
            // failing over — the playbook line is simply left out.
            const kindKey = String(concept.kind || '').trim().toLowerCase();
            const kind = KIND_PLAYBOOK[kindKey] ? kindKey : null;
            const domain = String(concept.domain || '').trim().toLowerCase();
            const toolkit = standalone ? lessonDomainToolkit(domain) : '';

            return `You are an excellent teacher building an interactive lesson in the style of Duolingo and Brilliant, about: "${concept.name}"

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
${standalone ? `
${lessonPrinciplesAndVisuals()}
` : ''}${kind ? `\nThis concept is a ${kind} concept. For that kind, what usually works best is: ${KIND_PLAYBOOK[kind]}\n` : ''}${calibrationNote()}${toolkit ? `
${toolkit}
` : ''}
${standalone ? `${lessonQuestionTypes()}

` : ''}Return valid JSON only (no markdown, no surrounding prose):

{
  "title": "${concept.name}",
  "estimatedMinutes": 6,
  "hook": { "text": "A surprising fact or question. 1-2 sentences. Not a definition." },
  "prediction": { "question": "A guess before we explain. Not graded.", "options": ["A","B","C"] },
  "explore": {
    "instruction": "What to DO — drag it, tap it, uncover it",
    "visual": { "…": "a touchable spec: slider, reveal, or a figure with parts" },
    "insight": "What they should notice. Shown after they touch it."
  },
  "cards": [ { "idea": "Heading", "text": "2-3 sentences, ONE idea", "analogy": "An everyday one, or null", "visual": null } ],
  "workedExample": {
    "problem": "A concrete problem", "answer": "The final answer", "visual": null,
    "steps": [ { "action": "What you do", "why": "Why it is correct" } ]
  },
  "practice": {
    "problem": "A similar one they solve alone", "hint": "Revealed on request",
    "options": ["A","B","C","D"], "correct": 0,
    "feedback": { "correct": "Why this is right", "incorrect": "The common mistake, and why" }
  },
  "quiz": [ { "type":"choice", "text":"…", "options":["A","B","C","D"], "correct":0,
              "hint":"One short nudge for a second try. Must NOT give the answer away.",
              "whyWrong":["the mistake behind this option","","",""],
              "explanation":"…" } ],
  "challenge": { "type":"choice", "text":"One larger problem combining several ideas",
    "options":["A","B","C","D"], "correct":0, "explanation":"The full solution" },
  "summary": { "mainIdea": "The central idea in one sentence", "keyFacts": ["1","2","3"],
    "commonMistake": "The most common mistake", "realWorld": "Where it shows up", "visual": null },
  "memoryCheck": { "prompt": "Explain this concept as if teaching a friend." }
}

Quantities: 3-5 cards. 3-4 steps in workedExample. 4-5 quiz questions.
Required: at least TWO visuals of TWO different types, one of them interactive
(slider, reveal, or a shape with a hotspot question); at least THREE question
types across the quiz, never the same twice in a row; and a numeric question
wherever the material is quantitative. "correct" is a 0-based index.

"explore" comes BEFORE the explanation and matters most: the learner does
something, sees what happens, and is told why afterwards. Its "visual" must be
touchable — a slider that moves a result, reveal cards, a figure with parts to
tap. One they can only look at is a card; write it as a card and omit this.
Omit it rather than invent an interaction the material does not support.

"hint" is shown only after a wrong answer, for a second try: point at the
mistake, never give the answer.

"whyWrong" (choice, blank and mistake questions): one short line per option
naming the specific misunderstanding that leads to it, "" for the right one.
The learner is shown the line for the option they picked, so write it to them:
what they must have thought, not that they were wrong.

Two quiz questions must test the SAME idea in different clothes — other numbers,
another context, another representation — so memorising one answer is not enough.

Keep every explanation, whyWrong line and hint to ONE short sentence — this is
read on a phone mid-lesson, not a textbook footnote. Say what is true, not
everything that is true about it.
${languageRule()}`;
        }

        /**
         * Whether a lesson call may use the four-block cache split.
         *
         * This is the one change in this app that is NOT safe to deploy in
         * either order, and the flag exists to make it so. An `ai-proxy` from
         * before `prepareLessonBlocks` treats any lesson call with two or more
         * blocks as `[context, ...prompt]`: it clamps block 0 to
         * `contextChars` and gives every remaining block one shared
         * `excerptChars + TEMPLATE_ALLOWANCE` budget. Send it four blocks and
         * the course digest alone exhausts that budget — the domain shelf and
         * then the lesson prompt itself are both clamped to zero characters,
         * so the model is handed a toolkit and a truncated digest with no
         * instructions and no JSON schema, and the lesson silently fails to
         * build. It is not a degraded lesson; it is no lesson.
         *
         * So the split stayed off until the function that understands it was
         * live. `ai-proxy` v9 carries `prepareLessonBlocks`, verified against
         * the deployed source rather than assumed, so it is on.
         *
         * Turning it back off is always safe and is the first thing to try if
         * lessons start failing to build: off, `generateLesson` sends exactly
         * the two blocks it always sent, which every deployed version of the
         * function has ever handled. Rolling `ai-proxy` back below v9 without
         * also setting this to `false` is the one combination that breaks.
         */
        const LESSON_CACHE_SPLIT = true;

        // `quiet` is set when nobody is waiting on this lesson — a prefetch —
        // so a failure goes to the console instead of onto a screen showing
        // something else entirely.
        //
        // `onPartial` is called at most once, the moment enough of the lesson
        // has streamed in to open it on its first steps (see `openingLesson`).
        // A prefetch that nobody has asked to watch yet passes it too now
        // (see `prefetchLesson`'s own `onPartial`, gated on `watchingIndex`) —
        // it just stays a no-op until someone actually taps that lesson.
        async function generateLesson(concept, { quiet = false, onPartial = null } = {}) {
            // Ground the lesson in the actual document, not the model's priors.
            const excerpt = retrieveExcerpt(concept, getSourceText(), getStructure());
            const domain = String(concept.domain || '').trim().toLowerCase();
            // Trial and Basic never cache (contextBudget() is 0 there — Haiku's
            // cache minimum is higher than any of these pieces clears alone), so
            // they still send the one flat, single-block prompt they always did.
            // Pro and Max split it into four: the toolkit is cached for the
            // whole app, the course digest for this course, the domain's
            // template shelf for this course's concepts of this domain — only
            // the last block, the concept itself, is never cached.
            const cached = LESSON_CACHE_SPLIT && contextBudget() > 0;
            const prompt = buildLessonPrompt(concept, excerpt, !cached);
            const report = msg => { if (!quiet) showError(msg); };

            // Content blocks in one message are concatenated with no separator
            // of their own, so each cached piece below carries its own trailing
            // blank line — courseContext() is left untouched since it is memoized
            // and reused as-is.
            const message = cached
                ? [lessonToolkitGlobal() + '\n\n', courseContext() + '\n\n', lessonDomainToolkit(domain) + '\n\n', prompt]
                : [courseContext(), prompt];

            // Watch the stream for the moment the opening is complete enough to
            // put on screen. `extractJSON` already closes off a truncated
            // object, so a half-written lesson parses into whatever finished
            // arriving — which for the opening fields is all this needs.
            // Parsing every chunk would be wasteful on a 6,000-token answer, so
            // it only starts looking once the field *after* the opening has
            // begun, which is the marker that the opening itself is done.
            let firedPartial = false;
            const watchForOpening = onPartial ? (text) => {
                if (firedPartial || !text.includes('"cards"')) return;
                const draft = extractJSON(text);
                if (!draft || !openingIsWorthShowing(draft)) return;
                firedPartial = true;
                try {
                    onPartial(normaliseLesson(openingLesson(draft), concept));
                } catch (err) {
                    // An opening that will not render is not worth losing the
                    // lesson over — the full one is still on its way.
                    console.warn('Could not open the lesson early:', err);
                }
            } : null;

            // `quiet` used to gate this off entirely, back when a prefetch
            // never watched its own stream at all. Once `prefetchLesson`
            // started passing `onPartial` (see above), that made the watcher
            // dead code — the one thing that would ever call it was switched
            // off for exactly the calls it was added for, so a lesson
            // someone tapped mid-prefetch sat on a bare "Almost ready…" for
            // the rest of the generation instead of opening on its hook the
            // way a fresh, unprefetched lesson already did. `lessonProgress`
            // (the screen's progress line) still only runs when not quiet —
            // there is no such screen to update yet.
            const result = await callAI(message, '', {
                maxTokens: MAX_TOKENS.lesson, task: 'lesson', quiet,
                stream: true,
                onProgress: (!quiet || watchForOpening) ? (text) => {
                    if (!quiet) lessonProgress(text);
                    if (watchForOpening) watchForOpening(text);
                } : null,
            });

            // callAI returns null when it already reported an error, and '' when
            // the model replied with nothing usable. The empty case used to fall
            // through in silence — the spinner vanished and nothing happened.
            if (result === null) return null;
            if (!result.trim()) {
                console.error('Model returned no text for this lesson.');
                report("The model returned an empty response. Try again.");
                return null;
            }

            const lesson = extractJSON(result);
            if (!lesson) {
                console.error('Could not parse lesson. Truncated:', lastCallTruncated, result);
                report(lastCallTruncated
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
                report(lastCallTruncated
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
            // Any question may carry a figure — the triangle the question is
            // about, the formula it applies. An unusable one is dropped and the
            // question still stands.
            // `hint` is what the learner is shown between the two attempts, so
            // it has to survive normalisation like the explanation does — a
            // question that arrives without one still gets a second try, just a
            // blunter nudge.
            const base = { text: String(q.text), explanation: q.explanation || '',
                           hint: q.hint ? String(q.hint) : '',
                           visual: validVisual(q.visual) };

            switch (type) {
                case 'choice':
                case 'blank':
                case 'mistake': {
                    const options = arr(q.options).filter(o => o != null).map(String);
                    if (options.length < 2) return null;
                    // One line per option, saying what picking it means. Padded
                    // and trimmed to the options it belongs to: a whyWrong that
                    // is one short would otherwise answer for the wrong option
                    // once the list is reshuffled for a second look.
                    const why = arr(q.whyWrong);
                    return { ...base, type, options,
                             correct: clamp(q.correct, options.length),
                             whyWrong: options.map((_, i) => why[i] ? String(why[i]) : '') };
                }
                case 'boolean': {
                    if (typeof q.answer !== 'boolean') return null;
                    return { ...base, type, answer: q.answer };
                }
                case 'order': {
                    const items = arr(q.items).filter(o => o != null).map(String);
                    if (items.length < 2) return null;
                    return { ...base, type, items };   // stored in correct order
                }
                case 'categorize': {
                    const buckets = arr(q.buckets).filter(o => o != null).map(String);
                    const items = arr(q.items)
                        .filter(it => it && it.text != null && buckets.includes(it.bucket))
                        .map(it => ({ text: String(it.text), bucket: String(it.bucket) }));
                    if (buckets.length < 2 || items.length < 2) return null;
                    return { ...base, type, buckets, items };
                }
                case 'match': {
                    const pairs = arr(q.pairs)
                        .filter(p => p && p.left != null && p.right != null)
                        .map(p => ({ left: String(p.left), right: String(p.right) }));
                    if (pairs.length < 2) return null;
                    return { ...base, type, pairs };
                }
                case 'numeric': {
                    // A typed number, graded against a tolerance. Without a
                    // finite answer there is nothing to grade against, so the
                    // question is dropped rather than marked wrong forever.
                    const answer = num(q.answer, NaN);
                    if (!isFinite(answer)) return null;
                    const tolerance = Math.abs(num(q.tolerance, 0));
                    return { ...base, type, answer, tolerance,
                             unit: q.unit ? String(q.unit) : '' };
                }
                case 'hotspot': {
                    // Tap the named part of a figure. Only a shape has parts, and
                    // the target has to name one that exists.
                    const visual = validVisual(q.visual);
                    if (!visual || visual.type !== 'shape') return null;
                    const target = String(q.target || '');
                    const m = /^(side|vertex|angle):(\d+)$/.exec(target);
                    if (!m) return null;
                    const geo = shapeGeometry(visual);
                    const parts = geo?.kind === 'circle' ? 1 : (geo?.points?.length || 0);
                    if (!parts || Number(m[2]) >= parts) return null;
                    return { ...base, type, visual, target };
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
        // The check lives in the VISUALS registry beside the renderer that
        // depends on it, so a type can never be validated by one rule and drawn
        // by another. A check that throws on a hostile spec fails closed.
        function validVisual(v) {
            if (!v || typeof v !== 'object') return null;
            // A template call is expanded into a real spec here, once, and it is
            // the expansion that gets stored and drawn. A template that cannot
            // build — sides that do not close, a formula that does not parse —
            // returns nothing, exactly like a malformed spec.
            if (v.template && !v.type) return expandTemplate(v);
            if (!v.type) return null;
            const def = VISUALS[v.type];
            if (!def) return null;
            try { return def.check(v) ? v : null; } catch (_) { return null; }
        }

        // Models drift from the schema. Fill gaps so the step engine never crashes.
        function normaliseLesson(l, concept) {
            const arr = v => Array.isArray(v) ? v : [];
            const clampIdx = (i, len) => (Number.isInteger(i) && i >= 0 && i < len) ? i : 0;

            l.title = l.title || concept.name;
            l.estimatedMinutes = l.estimatedMinutes || 6;
            l.hook = l.hook?.text ? l.hook : null;
            l.prediction = (l.prediction?.question && arr(l.prediction.options).length) ? l.prediction : null;
            // An explore step with no figure to touch is a card with extra
            // steps, and one whose figure failed validation would be an
            // instruction to drag something that is not on the screen.
            l.explore = (l.explore?.instruction && validVisual(l.explore.visual))
                ? { ...l.explore, visual: validVisual(l.explore.visual) }
                : null;
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
            showStages(null);
            showProgress(null);
        }

        /**
         * The streamed half of the wait, reported honestly.
         *
         * `fraction` is only ever a count of things that have actually arrived
         * over the number the format calls for — nine parts of a lesson, or
         * the concepts a tier's course holds. It is not a timer and it is not
         * an easing curve pretending to be one. Pass null to put both away.
         */
        function showProgress(detail, fraction = null) {
            const line = document.getElementById('loadingDetail');
            const bar = document.getElementById('loadingBar');
            const fill = document.getElementById('loadingBarFill');
            if (!line || !bar || !fill) return;

            if (detail === null) {
                line.hidden = true; line.textContent = '';
                bar.hidden = true; fill.style.width = '0';
                return;
            }
            line.hidden = false;
            line.textContent = detail;
            if (fraction === null) { bar.hidden = true; return; }
            bar.hidden = false;
            // Never 100%: the last chunk is still in flight, and a full bar
            // over a screen that has not changed yet reads as stuck.
            fill.style.width = `${Math.round(Math.min(0.97, Math.max(0.02, fraction)) * 100)}%`;
        }

        /**
         * What the model is writing, read out of the JSON it is halfway
         * through writing.
         *
         * The lesson arrives key by key in the order the prompt asks for them,
         * so the last top-level key to appear is the part being written now.
         * This is a guess about a partial document and it is allowed to be
         * one — every answer it gives is a key that has genuinely arrived, and
         * the worst case is a label that lags a second behind the truth.
         */
        const LESSON_PARTS = [
            ['"hook"', 'Writing the opening'],
            ['"prediction"', 'Setting up the first guess'],
            ['"explore"', 'Building something to try'],
            ['"cards"', 'Writing the explanation'],
            ['"workedExample"', 'Working through an example'],
            ['"practice"', 'Writing a practice problem'],
            ['"quiz"', 'Writing the questions'],
            ['"challenge"', 'Setting the final challenge'],
            ['"summary"', 'Summing it up'],
        ];

        function lessonProgress(text) {
            let at = -1;
            for (let i = 0; i < LESSON_PARTS.length; i++) {
                if (text.includes(LESSON_PARTS[i][0])) at = i;
            }
            if (at < 0) return showProgress('Reading your material', 0.02);
            showProgress(LESSON_PARTS[at][1], (at + 1) / (LESSON_PARTS.length + 1));
        }

        // The course plan is a list, so its progress is a count: concepts are
        // the one thing being produced and the tier says how many are coming.
        function pathProgress(text) {
            const found = (text.match(/"name"\s*:/g) || []).length;
            const target = planLessonCount();
            if (!found) return showProgress('Reading the whole document', 0.02);
            showProgress(found === 1 ? 'Found 1 concept' : `Found ${found} concepts`, found / target);
        }

        // Building a course is four distinct pieces of work and the better part
        // of a minute. One line of text for all of it answers "is it stuck?"
        // with a shrug, so the stages are named and ticked off as they finish.
        //
        // No percentage: the model call is the long one and it does not report
        // progress, so any number here would be a number we made up. Which
        // stage we are on is true, and it is enough.
        const BUILD_STAGES = [
            ['read',   'Reading your material'],
            ['check',  'Checking it can be taught'],
            ['plan',   'Finding the concepts'],
            ['save',   'Building your path'],
        ];

        function showStages(stages, activeKey) {
            const list = document.getElementById('loadingStages');
            if (!list) return;
            if (!stages) { list.hidden = true; list.innerHTML = ''; return; }

            const at = stages.findIndex(([key]) => key === activeKey);
            list.hidden = false;
            list.innerHTML = stages.map(([key, label], i) => {
                const state = i < at ? 'is-done' : (i === at ? 'is-now' : '');
                const mark = i < at ? ICONS.check : '';
                return `<li class="${state}"><span class="stage-mark" aria-hidden="true">${mark}</span>${esc(label)}</li>`;
            }).join('');
        }

        // One call site's worth of sugar, so a stage change reads as one line.
        function buildStage(key, message) {
            showMessage(message);
            showStages(BUILD_STAGES, key);
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

        // Everything inside #lessonPath except the persistent connector line —
        // banners and nodes get rebuilt on every render, but the <svg> stays put
        // so drawLessonPathLine() always has somewhere to draw into.
        function clearLessonPathNodes() {
            const container = document.getElementById('lessonPath');
            if (!container) return;
            [...container.children].forEach(el => {
                if (el.id !== 'lessonPathLine') el.remove();
            });
        }

        // The connector used to be a straight dotted line down the centre while
        // the circles themselves zig-zagged left and right — on screen that read
        // as circles drifting off a line, not a path. This traces the nodes'
        // actual centres instead, so the line is the wave: it moves exactly where
        // the circles move, lesson to lesson, banners included since the gap
        // above a banner is just as real a distance as the gap between two
        // lessons. Reused for the skeleton state too — skeleton nodes carry the
        // same .lesson-node/.lesson-circle classes, so the same measurement works
        // before the real content has even arrived.
        function drawLessonPathLine() {
            const container = document.getElementById('lessonPath');
            const svg = document.getElementById('lessonPathLine');
            const linePath = document.getElementById('lessonPathLinePath');
            if (!container || !svg || !linePath) return;

            const nodes = [...container.querySelectorAll('.lesson-node')];
            const containerRect = container.getBoundingClientRect();
            svg.setAttribute('viewBox', `0 0 ${containerRect.width} ${containerRect.height}`);

            if (nodes.length < 2 || containerRect.width === 0) {
                linePath.setAttribute('d', '');
                return;
            }

            const points = nodes.map(node => {
                const circle = node.querySelector('.lesson-circle') || node;
                const r = circle.getBoundingClientRect();
                return {
                    x: r.left + r.width / 2 - containerRect.left,
                    y: r.top + r.height / 2 - containerRect.top,
                };
            });

            // A smooth curve through every point: each segment is a quadratic
            // bezier ending at the midpoint between it and the next node, which
            // keeps the line rounded through each turn instead of kinking at
            // every circle the way straight segments would.
            let d = `M ${points[0].x} ${points[0].y}`;
            for (let i = 1; i < points.length - 1; i++) {
                const midX = (points[i].x + points[i + 1].x) / 2;
                const midY = (points[i].y + points[i + 1].y) / 2;
                d += ` Q ${points[i].x} ${points[i].y} ${midX} ${midY}`;
            }
            d += ` L ${points[points.length - 1].x} ${points[points.length - 1].y}`;
            linePath.setAttribute('d', d);
        }

        let pathLineResizeTimer = null;
        window.addEventListener('resize', () => {
            clearTimeout(pathLineResizeTimer);
            pathLineResizeTimer = setTimeout(drawLessonPathLine, 150);
        });

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
            // A destructive confirm gets a red confirm button, not an outlined one:
            // the button that does the damage should look like it.
            confirmBtn.classList.toggle('button-danger', danger);
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
        // One loading state for every button that kicks off async work, instead of
        // each call site swapping textContent and hoping to restore it. The label
        // stays in the DOM (masked by the spinner) so the width doesn't jump and
        // the accessible name survives.
        function setButtonBusy(btn, busy) {
            if (!btn) return;
            btn.classList.toggle('is-loading', busy);
            btn.disabled = busy;
            btn.setAttribute('aria-busy', String(busy));
        }

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

        // A bundle written by `tools/pdf_prep`: the document's Markdown and the
        // structure that indexes it, in one file.
        //
        // That tool reads a PDF the way this app cannot — it has font sizes,
        // table grids and OCR for pages that are scans — and hands back an
        // outline with real page numbers instead of one guessed from the text.
        // Everything here still works without it; this is the better input, not
        // the required one.
        function readBundle(raw) {
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch {
                throw new Error('BUNDLE_INVALID');
            }
            if (!String(parsed?.schema || '').startsWith('pdf-prep/')
                || typeof parsed.markdown !== 'string'
                || parsed.markdown.trim().length < 100) {
                throw new Error('BUNDLE_INVALID');
            }
            const text = parsed.markdown.slice(0, MAX_SOURCE_CHARS);
            return { text, structure: bundleStructure(parsed.manifest || {}) };
        }

        // Keep the parts of the manifest this app reads, and nothing else. The
        // manifest also carries tables as data, figure boxes and per-chunk
        // terms; storing all of that in every course row would be paying to
        // carry what nothing here looks at. The outline is what the planner
        // needs, and its page numbers are what the text alone cannot give.
        function bundleStructure(manifest) {
            const sections = [];
            const walk = (nodes, depth) => {
                (nodes || []).forEach(node => {
                    const title = String(node?.title || '').trim();
                    if (title) {
                        sections.push({
                            title,
                            level: depth,
                            pageStart: Number(node.page_start) || 0,
                            pageEnd: Number(node.page_end) || 0,
                        });
                    }
                    walk(node?.children, depth + 1);
                });
            };
            walk(manifest.outline, 1);
            if (sections.length < 2) return null;
            return {
                source: 'pdf-prep',
                pages: Number(manifest.document?.page_count) || 0,
                sections,
            };
        }

        // Read whatever was dropped on the upload box. Three kinds: a PDF, a
        // prepared bundle, or plain text — and plain text really is plain text,
        // which it was not before: a .txt file went through the PDF reader and
        // came back as "make sure it's a valid PDF".
        async function readUpload(file, onProgress) {
            const name = String(file.name || '').toLowerCase();
            if (name.endsWith('.json')) return readBundle(await file.text());
            if (name.endsWith('.pdf') || file.type === 'application/pdf') {
                return { text: await extractConceptsFromPDF(file, onProgress), structure: null };
            }
            const text = await file.text();
            return { text: text.slice(0, MAX_SOURCE_CHARS), structure: null };
        }

        // Worksheet mode: the upload screen's one toggle, read by both submit
        // paths below and by the resume-after-signup replay (see pendingAction).
        // Reset on every fresh visit to the upload screen (see showNewCourse) so
        // it never carries over from a previous course by accident.
        let worksheetMode = false;

        function setWorksheetMode(on) {
            worksheetMode = on;
            const btn = document.getElementById('worksheetModeToggle');
            if (btn) btn.setAttribute('aria-checked', String(on));
        }

        async function handleFileUpload(file) {
            // Name the file being read. "Reading PDF..." after picking the wrong one
            // from a list of near-identical names gives you nothing to check against.
            buildStage('read', `Reading ${file.name}`);
            let text, structure;
            try {
                ({ text, structure } = await readUpload(file, (page, total) => {
                    // A long document takes tens of seconds to read. Without a
                    // moving count that is indistinguishable from a hung tab.
                    // A real count, because this one is genuinely known.
                    if (total > 8) buildStage('read', `Reading ${file.name} — page ${page} of ${total}`);
                }));
            } catch (err) {
                console.error('upload read error:', err);
                hideMessage();
                if (err.message === 'PDF_READER_UNAVAILABLE') {
                    showError("The PDF reader didn't load. Check your connection and try again, or paste the text instead.");
                } else if (err.message === 'BUNDLE_INVALID') {
                    showError("That .json file isn't a document bundle. Run tools/pdf_prep with --bundle to make one, or upload the PDF itself.");
                } else {
                    showError("Couldn't read that file. Upload a PDF, a .txt file, or a bundle from tools/pdf_prep.");
                }
                return;
            }
            if (!text || text.trim().length < 100) {
                hideMessage();
                showError("No text found in that file. It may be a scanned PDF with no text layer — tools/pdf_prep can read one with OCR.");
                return;
            }
            await processLearningMaterial(text, file.name.replace(/\.[^/.]+$/, ''), requestedCourseName(), structure, worksheetMode);
        }


        // ============= Is this worth building a course from? =============
        // A course costs a real API call, and the call is worth nothing if the
        // material could never carry ten concepts: a bank statement, a
        // timetable, a scanned page that came back as forty characters of
        // noise. Refusing those before the call is the difference between a
        // wasted build and a sentence of explanation.
        //
        // Every check here is arithmetic over the text. Nothing about this is a
        // judgement of the subject — a document about anything at all passes as
        // long as it is prose with enough of it to teach.

        const MATERIAL_MIN_CHARS = 600;      // under this there is no course to build
        const MATERIAL_MIN_WORDS = 100;

        function materialStats(text) {
            const source = String(text || '').trim();
            const letters = (source.match(/\p{L}/gu) || []).length;
            const digits = (source.match(/\p{Nd}/gu) || []).length;
            const words = source.split(/\s+/).filter(Boolean);
            const real = words.filter(w => /\p{L}{3,}/u.test(w));
            const sentences = (source.match(/[.!?׃।。！？]+(\s|$)/gu) || []).length;
            const distinct = new Set(real.map(w => w.toLowerCase().replace(/\p{P}/gu, ''))).size;
            return {
                chars: source.length,
                words: words.length,
                realWords: real.length,
                letterShare: source.length ? letters / source.length : 0,
                digitShare: source.length ? digits / source.length : 0,
                sentences,
                // No sentence enders at all is not "infinitely long sentences",
                // it is "no sentences" — the mistake that let a whole code file
                // through the gate with a perfect score.
                wordsPerSentence: sentences ? real.length / sentences : 0,
                vocabulary: real.length ? distinct / real.length : 0,
            };
        }

        // Returns null when the material is fine, or the reason it is not.
        // Each reason names what was seen, because "this file is not suitable"
        // is not something a person can act on.
        function assessMaterial(text) {
            const st = materialStats(text);

            // Shape before size, deliberately. A 3,000-character bank statement
            // is not short — it is numbers — and being told "there isn't enough
            // here" would send the learner off to find a longer statement.

            // A page of figures: a price list, a statement, a timetable. There
            // is nothing to explain in a column of numbers.
            if (st.digitShare > 0.2 && st.realWords < st.words * 0.4) {
                return {
                    code: 'mostly-numbers',
                    title: 'This looks like a table of numbers',
                    detail: `About ${Math.round(st.digitShare * 100)}% of it is digits, with very few `
                        + 'words between them. A course explains ideas, and a spreadsheet does not hold any.',
                    fix: 'Upload the document that explains these numbers, if there is one.',
                    stats: st,
                };
            }

            // Not prose: a code file, a log, a bibliography, a page of headings
            // with nothing under them. Letters are there; sentences are not.
            // Each clause carries its own "enough to judge by" floor. Without
            // them a two-line scrap is refused for not being prose, when what
            // is actually wrong with it is that there are two lines of it.
            if ((st.sentences === 0 && st.realWords >= 60)
                || (st.letterShare < 0.55 && st.chars >= 300)
                || (st.sentences > 0 && st.wordsPerSentence < 5 && st.realWords >= MATERIAL_MIN_WORDS)) {
                return {
                    code: 'not-prose',
                    title: "This doesn't read like study material",
                    detail: 'It has almost no full sentences — it looks more like a list, a form or '
                        + 'a page of code than something written to be understood.',
                    fix: 'A chapter, an article or a set of notes works best.',
                    stats: st,
                };
            }

            if (st.chars < MATERIAL_MIN_CHARS || st.realWords < MATERIAL_MIN_WORDS) {
                return {
                    code: 'too-short',
                    title: "There isn't enough here to teach",
                    detail: `This has about ${st.realWords} words. A course needs 10-20 concepts, `
                        + `and they have to come from somewhere — a few hundred words at minimum.`,
                    fix: 'Try a fuller document, or paste more of the text.',
                    stats: st,
                };
            }

            // The same line, over and over: a log, a template, a scan whose OCR
            // repeated one row down the page.
            if (st.realWords > 400 && st.vocabulary < 0.12) {
                return {
                    code: 'repetitive',
                    title: 'This repeats itself',
                    detail: `Only about ${Math.round(st.vocabulary * 100)}% of the words are different ones. `
                        + 'A document that says the same thing on every line has one idea in it, not ten.',
                    fix: 'Try a document with more to say.',
                    stats: st,
                };
            }

            return null;
        }

        // The gate for worksheet mode (see generateLessonPath) is deliberately
        // lighter than assessMaterial. Every "mostly-numbers" and "not-prose"
        // check above assumes the document is narrative prose with a shape to
        // judge — which is exactly what a worksheet is not, by design: "1. Solve
        // 2x+5=13" is almost all digits and symbols, three real words, no
        // sentence at all, and would fail every one of those checks despite
        // being precisely what this mode exists to teach from. What still needs
        // guarding against is the same as ever — nothing pasted, or the same
        // line repeated down the page — so those two checks are kept and the
        // shape-of-prose ones are dropped.
        const WORKSHEET_MIN_CHARS = 150;

        function assessWorksheetMaterial(text) {
            const st = materialStats(text);

            if (st.chars < WORKSHEET_MIN_CHARS) {
                return {
                    code: 'too-short',
                    title: "There isn't enough here to teach",
                    detail: `This has about ${st.chars} characters. Paste the whole worksheet, or a fuller page of it.`,
                    fix: 'Paste more of the worksheet.',
                    stats: st,
                };
            }

            if (st.realWords > 400 && st.vocabulary < 0.12) {
                return {
                    code: 'repetitive',
                    title: 'This repeats itself',
                    detail: `Only about ${Math.round(st.vocabulary * 100)}% of the words are different ones. `
                        + 'A worksheet whose lines just repeat has nothing new in it to build exercises from.',
                    fix: 'Try a document with more to say.',
                    stats: st,
                };
            }

            return null;
        }

        // The learner may overrule us — we are guessing from arithmetic, and a
        // strange-looking document can still be exactly what they want to
        // learn. What the override must not become is a button that spends
        // money every time it is pressed, so it is bounded twice: once per
        // document, and a few per day.
        //
        // Neither bound is a security boundary — localStorage is the learner's
        // own. The real limit on spend is the monthly course quota the Edge
        // Function enforces, which an overridden build counts against exactly
        // like any other. This only stops the accidental loop: refuse, click,
        // refuse, click.
        const OVERRIDE_STORAGE = 'material-overrides';
        const OVERRIDES_PER_DAY = 3;

        function materialFingerprint(text) {
            const s = String(text || '');
            let h = 2166136261;
            for (let i = 0; i < s.length; i++) {
                h ^= s.charCodeAt(i);
                h = Math.imul(h, 16777619);
            }
            return (h >>> 0).toString(36) + ':' + s.length;
        }

        function readOverrides() {
            try {
                const raw = JSON.parse(localStorage.getItem(OVERRIDE_STORAGE) || '{}');
                const today = new Date().toISOString().slice(0, 10);
                return (raw && raw.day === today) ? raw : { day: today, ids: [] };
            } catch {
                return { day: new Date().toISOString().slice(0, 10), ids: [] };
            }
        }

        function overrideState(text) {
            const record = readOverrides();
            const id = materialFingerprint(text);
            return {
                id,
                already: record.ids.includes(id),        // this exact document, already allowed
                left: Math.max(0, OVERRIDES_PER_DAY - record.ids.length),
                record,
            };
        }

        function recordOverride(text) {
            const { id, record } = overrideState(text);
            if (!record.ids.includes(id)) record.ids.push(id);
            try { localStorage.setItem(OVERRIDE_STORAGE, JSON.stringify(record)); } catch { /* private mode */ }
        }

        // Show what we think is wrong and let the learner overrule it. Returns
        // true if the build should go ahead.
        //
        // Two ways out, and the one that disagrees with us also tells us so.
        // The check is arithmetic guessing at intent; when it guesses wrong the
        // learner is the only one who knows, and a refusal nobody can report is
        // a threshold nobody can fix.
        async function confirmUnsuitable(verdict, text) {
            hideMessage();          // never ask a question over a spinner
            const { already, left } = overrideState(text);
            // Already waved through once — do not ask the same question twice
            // about the same document.
            if (already) return true;

            if (left <= 0) {
                await uiAlert(
                    `${verdict.detail}\n\n${verdict.fix}\n\n`
                    + "You've told us we were wrong a few times today already, so this one is not being "
                    + 'built. Those reports are logged and the check will be adjusted — try again '
                    + 'tomorrow, or start from a different document.',
                    verdict.title);
                return false;
            }

            const ok = await uiConfirm(
                verdict.title,
                `${verdict.detail}\n\n${verdict.fix}\n\n`
                + 'If this really is study material, tell us — we will log that the check got it wrong, '
                + 'and build the course anyway. It uses one course from your monthly quota, the same as '
                + `any other. (${left} left today.)`,
                { confirmText: "You've got this wrong — build it", cancelText: 'Use a different document' });

            if (ok) {
                recordOverride(text);
                reportMisjudged(verdict);
            }
            return ok;
        }

        // The report: which rule fired, and the measurements it fired on. Never
        // the document — the check itself only ever looked at the shape of the
        // text, so the shape is all that has to travel, and nobody reporting a
        // bad refusal should have to hand over their bank statement to do it.
        //
        // Queued when signed out, because the gate deliberately runs before the
        // sign-up wall and a report has to belong to someone. The queue is
        // flushed on the way back in.
        const REPORT_QUEUE = 'material-reports-pending';

        function reportMisjudged(verdict) {
            const row = {
                code: verdict.code,
                stats: {
                    chars: verdict.stats.chars,
                    words: verdict.stats.realWords,
                    letterShare: Math.round(verdict.stats.letterShare * 100) / 100,
                    digitShare: Math.round(verdict.stats.digitShare * 100) / 100,
                    sentences: verdict.stats.sentences,
                    wordsPerSentence: Math.round(verdict.stats.wordsPerSentence * 10) / 10,
                    vocabulary: Math.round(verdict.stats.vocabulary * 100) / 100,
                },
                source: activeStructure ? 'bundle' : 'upload',
            };
            if (!currentUser) { queueReport(row); return Promise.resolve(); }
            return sendReports([row]);
        }

        function queueReport(row) {
            try {
                const queued = JSON.parse(localStorage.getItem(REPORT_QUEUE) || '[]');
                queued.push(row);
                // A queue is a courtesy, not a database: keep the last few.
                localStorage.setItem(REPORT_QUEUE, JSON.stringify(queued.slice(-5)));
            } catch { /* private mode: the report is simply lost */ }
        }

        async function sendReports(rows) {
            if (!currentUser || !rows.length) return;
            const { error } = await supabaseClient.from('material_reports')
                .insert(rows.map(r => ({ ...r, user_id: currentUser.id })));
            // A failed report is not the learner's problem and must never
            // interrupt the build they asked for.
            if (error) console.warn('material report not sent:', error.message);
        }

        async function flushReports() {
            let queued = [];
            try { queued = JSON.parse(localStorage.getItem(REPORT_QUEUE) || '[]'); } catch { return; }
            if (!queued.length) return;
            try { localStorage.removeItem(REPORT_QUEUE); } catch { /* ignore */ }
            await sendReports(queued);
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
        async function processLearningMaterial(text, title = '', chosenName = requestedCourseName(), structure = null, worksheet = false) {
            // The gate first, before the sign-up wall. Judging the material
            // costs nothing, and being asked to create an account and only then
            // told the document was never going to work is the worst order
            // these two could happen in. Worksheet mode uses a lighter gate —
            // see assessWorksheetMaterial — since a page of terse exercises
            // fails every shape-of-prose check assessMaterial runs.
            buildStage('check', 'Checking your material');
            const verdict = worksheet ? assessWorksheetMaterial(text) : assessMaterial(text);
            if (verdict && !(await confirmUnsuitable(verdict, text))) {
                resetToUpload();
                return;
            }

            // The point of need: building a course is the first thing that
            // actually requires an account. Resume automatically after sign-up.
            // The gate runs again on the way back through and passes in
            // silence — the override was recorded against this document.
            if (!currentUser) {
                pendingAction = { type: 'buildCourse', text, title, chosenName, structure, worksheet };
                showAuthModal('signup');
                return;
            }

            buildStage('plan', worksheet ? 'Finding the exercises in your worksheet' : 'Finding the concepts in your material');

            // Lesson 1 is written alongside the plan rather than after it (see
            // `firstPlannedConcept`), and `generateLesson` reads the document
            // it is grounding in off the same globals a open course uses. They
            // are pointed at this document before planning starts and put back
            // if the build never produces a course, so a failed build cannot
            // leave the previously open course reading someone else's source.
            const restore = {
                courseData, activeSourceText, activeStructure, progress,
            };

            // Set the instant `onFirstConcept` fires, and never after: it is
            // what tells the rest of this function whether the learner is
            // already standing on the path (early-started) or still watching
            // the loading overlay (never got that far, or the plan came back
            // in one piece with no chance to fire early). Everything below
            // that touches the screen or `progress` branches on it, because
            // the two cases need opposite handling — one has state on screen
            // worth keeping and protecting, the other has nothing to lose.
            let earlyStartFired = false;

            try {
                const course = await generateLessonPath(text, structure, worksheet, {
                    onFirstConcept: ({ language, concept }) => {
                        activeSourceText = text;
                        activeStructure = structure;
                        // A provisional course, holding the one concept being
                        // written and the language every string in the lesson
                        // has to be in.
                        courseData = { language, concepts: [concept] };
                        // Nobody has answered anything in a course that does not
                        // exist yet; the previous course's scores must not pitch
                        // this one's first lesson.
                        progress = {};
                        currentLessonIndex = 0;
                        prefetching.clear();
                        earlyStartFired = true;
                        prefetchLesson(0);
                        // The overlay was the only thing standing between the
                        // learner and a course that, from here, is real enough
                        // to stand on: lesson 1 is already being written
                        // in the background and opens the moment it is tapped.
                        hideMessage();
                        document.getElementById('sourcePicker').hidden = true;
                        document.getElementById('libraryScreen').hidden = true;
                        document.getElementById('learningPath').classList.add('active');
                        displayLearningPathInProgress();
                    },
                    onConcepts: ({ concepts }) => {
                        if (!courseData) return;
                        courseData.concepts = concepts;
                        displayLearningPathInProgress();
                    },
                });
                if (!course) {
                    ({ courseData, activeSourceText, activeStructure, progress } = restore);
                    prefetching.clear();
                    resetToUpload();   // error already surfaced; give them a way back
                    return;
                }

                course.courseName = chosenName
                    || cleanTitle(course.courseName)
                    || cleanTitle(title)
                    || 'Untitled course';
                // Already on the path with lesson 1 in hand: saving is a
                // background detail now, not something worth blocking the
                // overlay back over what the learner is already reading.
                if (!earlyStartFired) buildStage('save', 'Building your learning path');
                const id = await saveCourse(course, text, structure);
                if (!id) {
                    ({ courseData, activeSourceText, activeStructure, progress } = restore);
                    prefetching.clear();
                    if (earlyStartFired) resetToUpload();   // was already on screen; leave it in a clean state
                    return;
                }

                const nameInput = document.getElementById('courseNameInput');
                if (nameInput) nameInput.value = '';   // don't reuse it for the next course

                courseData = course;
                activeCourseId = id;
                activeSourceText = text;
                activeStructure = structure;
                // Reset only if nothing has used `progress` yet. Early-started,
                // it has been live since `onFirstConcept` — the one place a
                // fresh course actually needs the wipe — and by now may hold
                // real answers from a lesson 1 the learner already started
                // while the rest of the plan was still writing itself.
                if (!earlyStartFired) progress = {};
                localStorage.setItem(ACTIVE_STORAGE, id);

                applyContentDirection();
                document.getElementById('sourcePicker').hidden = true;
                document.getElementById('libraryScreen').hidden = true;
                document.getElementById('learningPath').classList.add('active');
                // Early-started, this only reconciles the on-screen path with
                // the finished course (final order, any concept the plan
                // dropped) — it does not pull the learner out of a lesson
                // already open; `displayLearningPath` never touches that
                // overlay. Not early-started, it's what lands them on the
                // path for the first time, same as before.
                displayLearningPath();
            } finally {
                hideMessage();
            }
        }

        // Concepts are grouped into fixed-size units purely for the path's visual
        // rhythm (a banner every N nodes, a star node ending each unit) — the
        // underlying course/progress data has no notion of units.
        const UNIT_SIZE = 5;

        function unitNumber(index) {
            return Math.floor(index / UNIT_SIZE) + 1;
        }

        // Shown the instant a course is opened, before either of openCourse()'s two
        // fetches (the course row, then its progress) resolves. Without this,
        // tapping a library card produced a silent pause — the tap registered, but
        // nothing on screen said so until both round trips finished — and if a
        // second course had been open before, its name and path stayed on screen
        // as if they belonged to the one just tapped.
        function showCoursePathSkeleton() {
            setScreen('path');

            const title = document.getElementById('courseTitle');
            title.innerHTML = `<span class="skel" style="display:inline-block;width:9em;max-width:55vw;height:1.1em;border-radius:6px;vertical-align:middle"></span>`;
            const renameBtn = document.getElementById('courseRenameBtn');
            if (renameBtn) renameBtn.disabled = true;

            document.getElementById('progressBar').style.width = '0%';
            // Hiding the whole line, not blanking the three numbers inside it —
            // those numbers sit between static words ("of", "lessons"), and
            // clearing only the numbers left the words stranded around empty gaps.
            const meta = document.querySelector('.course-progress-meta');
            if (meta) meta.hidden = true;

            // Same .lesson-node class the real path uses, so the wavy left/right
            // rhythm applies for free — this is a placeholder for that shape, not
            // a different one the eye has to reconcile once the real path lands.
            const pathContainer = document.getElementById('lessonPath');
            clearLessonPathNodes();
            // Every real node carries a label under its circle — a bare row
            // of circles reads as a different, sparser thing than the path
            // that is about to replace it.
            pathContainer.insertAdjacentHTML('beforeend', Array.from({ length: 6 }, () => `
                <div class="lesson-node" aria-hidden="true" style="pointer-events:none">
                    <div class="lesson-circle skel"></div>
                    <span class="skel" style="display:block;width:64px;height:0.85em;margin-top:var(--sp-3);border-radius:5px"></span>
                </div>`).join(''));
            requestAnimationFrame(drawLessonPathLine);
        }

        function displayLearningPath() {
            setScreen('path');

            // Update stats
            document.getElementById('courseTitle').textContent = courseData.courseName || 'Learning Path';
            document.getElementById('courseRenameBtn').disabled = false;
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
            const hadNodes = pathContainer.children.length > 1; // the persistent line svg is always one
            clearLessonPathNodes();

            courseData.concepts.forEach((concept, index) => {
                if (index % UNIT_SIZE === 0) {
                    const unitNum = unitNumber(index);
                    const banner = document.createElement('div');
                    banner.className = 'unit-banner';
                    banner.innerHTML = `
                        <div class="unit-banner-label">Unit ${unitNum}</div>
                        <div class="unit-banner-title">${esc(concept.name)}</div>`;
                    pathContainer.appendChild(banner);
                }

                const isCheckpoint = (index + 1) % UNIT_SIZE === 0 || index === courseData.concepts.length - 1;

                // A real <button>: the path is the app's main navigation and every
                // node in it used to be a <div> that only a mouse could reach.
                const node = document.createElement('button');
                node.type = 'button';
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

                // The circle carries an icon, not a number, so the accessible name
                // has to spell out which lesson this is and what state it is in.
                const state = node.classList.contains('completed') ? 'completed'
                    : node.classList.contains('current') ? 'start here'
                    : 'not started yet';
                node.setAttribute('aria-label',
                    `Lesson ${index + 1}: ${concept.name} — ${state}${dueNow ? ', due for review' : ''}`);

                node.innerHTML = `
                    <span class="lesson-circle" aria-hidden="true">
                        <span>${icon}</span>
                        ${dueNow ? '<span class="due-dot"></span>' : ''}
                    </span>
                    <span class="lesson-label" aria-hidden="true">${esc(concept.name)}</span>
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
            requestAnimationFrame(() => { drawLessonPathLine(); scrollToCurrentNode(); });
        }

        // The same path, plus one soft node at the tail saying the plan is
        // still being written. Used while a course is building: real nodes
        // land as `onConcepts` reports them, so this is what the learner sees
        // between "lesson 1 exists" and "the whole course does" — the one
        // gap `displayLearningPath` alone has no way to show, since it takes
        // the concept list as finished.
        function displayLearningPathInProgress() {
            displayLearningPath();
            document.getElementById('lessonPath').insertAdjacentHTML('beforeend', `
                <div class="lesson-node" aria-hidden="true" style="pointer-events:none">
                    <div class="lesson-circle skel"></div>
                </div>`);
            requestAnimationFrame(drawLessonPathLine);
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

        /**
         * One question from an earlier lesson, asked before this one starts.
         *
         * The course already knew how to test what you learned last week — it
         * just kept it behind a banner on the path and a tab of its own, which
         * is a place you go when you have decided to revise. Almost nobody
         * decides to revise. Putting one question at the front of the lesson
         * they had already decided to open costs the learner twenty seconds
         * and costs the account nothing: the question was written, paid for
         * and cached when that earlier lesson was built.
         *
         * The oldest thing they know is what comes back — furthest past its
         * due date first, then simply the longest ago — because the material
         * closest to being forgotten is the material worth one question.
         */
        function pickWarmUp(currentIndex) {
            if (!courseData) return null;
            const candidates = courseData.concepts
                .map((_, i) => i)
                .filter(i => i !== currentIndex && progress[i]?.completed && progress[i]?.lesson)
                .map(i => {
                    const lesson = progress[i].lesson;
                    const pool = [...(lesson.quiz || [])];
                    if (lesson.challenge) pool.push(lesson.challenge);
                    return { index: i, pool, srs: progress[i].srs };
                })
                .filter(c => c.pool.length);
            if (!candidates.length) return null;

            // A lesson never reviewed is treated as due now, so a course
            // without a single review behind it still warms up.
            const staleness = c => Date.now() - (c.srs?.dueAt ?? c.srs?.lastReviewed ?? 0);
            candidates.sort((a, b) => staleness(b) - staleness(a));
            const pick = candidates[0];
            return {
                lessonIndex: pick.index,
                question: shuffle([...pick.pool])[0],
            };
        }

        /**
         * A missed warm-up brings that lesson's review forward, but no further
         * than tomorrow, and leaves the ease factor alone.
         *
         * One question is evidence that something is shaky; it is not a review
         * session, and letting it rewrite the SM-2 state would let a single
         * unlucky question undo weeks of correctly-earned interval.
         */
        function nudgeReviewSooner(index) {
            const srs = progress[index]?.srs;
            if (!srs) return;
            const tomorrow = Date.now() + 86400000;
            if (srs.dueAt > tomorrow) {
                srs.dueAt = tomorrow;
                saveProgress();
            }
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
                startedAt: Date.now(),
                attempts: {},
                review: { items, byLesson: {}, practice },
                result: null,
            };

            document.getElementById('lessonXpBadge').textContent = `${items.length} questions`;
            document.getElementById('lessonMeta').innerHTML = practice
                ? `<span class="meta-chip">${ICONS.refresh} Extra practice</span>`
                : `<span class="meta-chip">${ICONS.refresh} Spaced repetition</span>`;
            applyContentDirection();
            buildStepSegments(steps.length);
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
            // `dueOverview` starts `null` and `renderReview()` reads an empty
            // array the same way it would read a real account with nothing
            // due — so on a true first load it told someone with five
            // courses "Build a course first" for the half-second before the
            // real fetch landed. Only that case gets a skeleton; a revisit
            // already has `dueOverview` from earlier this session and paints
            // it immediately, same as the library tab.
            if (currentUser && dueOverview === null) renderReviewSkeleton();
            else renderReview();          // paint what we already know, then refresh
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

        // Shaped like renderReview()'s real cards — the summary hero plus a
        // couple of course rows, same classes so nothing shifts size when
        // the real content lands — but with no claim about what those
        // numbers are yet. Two rows is a guess, same as the library
        // skeleton's three cards: neither pretends to be an exact count.
        function renderReviewSkeleton() {
            const body = document.getElementById('reviewBody');
            const sub = document.getElementById('reviewSubtitle');
            if (!body) return;
            sub.textContent = '';
            body.innerHTML = `
                <div class="review-summary" aria-hidden="true">
                    <span class="skel" style="width:44px;height:2.2em;border-radius:8px"></span>
                    <div class="review-summary-text">
                        <span class="skel" style="width:9em;height:1em;border-radius:6px"></span>
                        <span class="skel" style="width:14em;max-width:60vw;height:0.85em;border-radius:6px"></span>
                    </div>
                </div>
                <div class="review-list">
                    ${Array.from({ length: 2 }, () => `
                        <div class="review-course" aria-hidden="true">
                            <div class="review-course-main">
                                <span class="skel" style="display:block;width:60%;height:1.05em;border-radius:6px;margin-bottom:8px"></span>
                                <span class="skel" style="display:block;width:40%;height:0.85em;border-radius:6px"></span>
                            </div>
                            <span class="skel" style="width:7em;height:2.4em;border-radius:var(--r-md)"></span>
                        </div>`).join('')}
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
                                ${c.due ? `<button class="button" data-review="${escAttr(c.id)}">Review now</button>` : ''}
                                ${!c.due && canPractise ? `<button class="button button-secondary" data-practise="${escAttr(c.id)}">Practise early</button>` : ''}
                                ${!canPractise ? `<button class="button button-secondary" data-open="${escAttr(c.id)}">Open course</button>` : ''}
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

        // ============= The HUD: streak and XP =============
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

        // Two numbers that move on their own. "Gems" was XP divided by twenty — the
        // same fact twice, dressed as a third stat, so it's gone. The HUD itself is
        // hidden until there is something in it, rather than showing a row of zeroes
        // to someone who hasn't started.
        function renderHud() {
            const streakEl = document.getElementById('hudStreak');
            if (!streakEl) return;
            const xp = totalXp();
            const streak = getStreak();
            streakEl.textContent = streak;
            document.getElementById('hudXp').textContent = xp;

            const hud = document.getElementById('duoHud');
            if (hud) hud.hidden = !currentUser || (!streak && !xp);
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

        // ============= Usage & cost tracking =============
        // Haiku 4.5 pricing: $1 per 1M input tokens, $5 per 1M output tokens.
        const PRICE_IN = 1 / 1_000_000;
        const PRICE_OUT = 5 / 1_000_000;

        // The Edge Function increments ai_usage server-side on every real call —
        // the client just reflects it. "cached" (this app's own lesson cache, not
        // an API call at all) is session-only, there's nothing server-side to sync.
        let usage = { calls: 0, inputTokens: 0, outputTokens: 0, cached: 0,
                      coursesMonth: 0, lessonsMonth: 0, monthResetAt: null, loaded: false };

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
            // Set even when `data` came back empty (a brand new account with no
            // usage row yet) — "loaded" means the fetch happened, not that it
            // found something, and the zeros above are the correct real answer
            // for that account, not a placeholder waiting to be replaced.
            usage.loaded = true;
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
            // `depth` is what the tier gives the learner, not which model gives
            // it to them. Naming the models here made the plan picker a promise
            // about implementation: it pinned a row of `PLANS` in the Edge
            // Function that should be free to move for speed or cost, it meant
            // nothing to anyone who does not follow model releases, and it goes
            // stale every time one is renamed or retired. Which models actually
            // process the material is a fact about where the text goes, so it
            // lives in privacy.html, next to everything else of that kind.
            trial: { label: 'Free trial', courses: 1, lessonsPerCourse: 10, depth: 'short, straightforward lessons', readChars: 5000,   excerptChars: 2400,  contextChars: 0 },
            basic: { label: 'Basic',      courses: 3, lessonsPerCourse: 10, depth: 'short, straightforward lessons', readChars: 5000,   excerptChars: 2400,  contextChars: 0 },
            pro:   { label: 'Pro',        courses: 5, lessonsPerCourse: 12, depth: 'more detailed lessons',          readChars: 40000,  excerptChars: 8000,  contextChars: 24000 },
            max:   { label: 'Max',        courses: 8, lessonsPerCourse: 15, depth: 'the most detailed lessons',      readChars: 120000, excerptChars: 16000, contextChars: 48000 },
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

        // Shared between the signed-out and signed-in renders of the Account
        // screen: the theme is a device preference, not account data, so it
        // shouldn't need a sign-in just to change.
        function appearanceSectionHTML() {
            return `
                <section class="account-card">
                    <div class="account-card-head"><h3>Appearance</h3></div>
                    <button class="account-row" id="acctAppearance">
                        <span class="account-row-icon">${ICONS.moon}</span>
                        <span class="account-row-text">
                            <strong>Theme</strong>
                            <span id="acctAppearanceValue"></span>
                        </span>
                    </button>
                </section>`;
        }

        function wireAppearanceRow() {
            const btn = document.getElementById('acctAppearance');
            const valueEl = document.getElementById('acctAppearanceValue');
            if (!btn || !valueEl) return;
            const describe = () => {
                const pref = themePref();
                valueEl.textContent = pref === 'light' ? 'Light — tap to switch to dark'
                    : pref === 'dark' ? 'Dark — tap to match your device'
                    : `Matches your device, currently ${effectiveTheme()} — tap for light`;
            };
            describe();
            btn.onclick = () => {
                const pref = themePref();
                setThemePref(pref === 'light' ? 'dark' : pref === 'dark' ? null : 'light');
                describe();
            };
        }

        async function showAccount() {
            setScreen('account');
            renderAccount();
            if (!currentUser) return;
            await Promise.all([loadEntitlement(), refreshUsage(), loadLibrary()]);
            renderAccount();
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
                }) + appearanceSectionHTML();
                document.getElementById('acctSignIn').onclick = () => showAuthModal('signin');
                document.getElementById('acctSignUp').onclick = () => showAuthModal('signup');
                wireAppearanceRow();
                return;
            }

            const email = currentUser.email || 'Signed in';
            const initial = (email[0] || '?').toUpperCase();
            const joined = currentUser.created_at
                ? new Date(currentUser.created_at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
                : null;

            const ent = entitlement;
            // Neither has resolved yet on a first visit this session — entitlement
            // and usage load in parallel in showAccount(). Rather than render real
            // section shells around numbers that are still whatever they defaulted
            // to (a brand new account's "0 / 1" trial numbers, shown as if they
            // were this account's real plan before the real one is known), every
            // figure that would otherwise flip from a wrong number to a right one
            // renders as a shimmer instead, in the same spot the real text lands.
            const loading = !ent || !usage.loaded;
            const field = (real, width = '2.4em') => loading
                ? `<span class="skel" style="display:inline-block;width:${width};height:0.9em;border-radius:5px;vertical-align:-0.1em"></span>`
                : real;

            const limits = PLAN_LIMITS[ent?.planKey || 'trial'];

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
                        <h3>${field(esc(limits.label), '7em')}</h3>
                        <span class="plan-status ${planTone}">${field(esc(planLine), '6em')}</span>
                    </div>
                    <p class="account-card-note">
                        ${loading ? field('', '85%') : `${limits.courses} course${limits.courses === 1 ? '' : 's'} a month —
                        ${esc(limits.depth)}, up to ${limits.lessonsPerCourse} each.`}
                    </p>
                    <p class="account-card-note">
                        ${loading ? '' : `${resets ? `Resets ${esc(resets)}. ` : ''}Replaying a lesson you already have is free, any time — it's already yours.`}
                    </p>
                    <button class="button button-secondary" id="acctPlans" ${loading ? 'disabled' : ''}>${loading ? field('', '5em') : (ent?.active ? 'Change plan' : 'See plans')}</button>
                </section>

                <section class="account-card">
                    <div class="account-card-head"><h3>Your learning</h3></div>
                    <div class="account-stats">
                        <div class="astat"><div class="astat-val">${field(getStreak())}</div><div class="astat-lbl">Day streak</div></div>
                        <div class="astat"><div class="astat-val">${field(totalXp())}</div><div class="astat-lbl">Total XP</div></div>
                        <div class="astat"><div class="astat-val">${field(library.length)}</div><div class="astat-lbl">Courses</div></div>
                        <div class="astat"><div class="astat-val">${field(lessonsDone)}</div><div class="astat-lbl">Lessons done</div></div>
                    </div>
                    ${!loading && dueNow ? `<button class="button button-secondary" id="acctReview">${dueNow} lesson${dueNow === 1 ? '' : 's'} due — review now</button>` : ''}
                </section>

                <section class="account-card">
                    <div class="account-card-head"><h3>AI spend</h3></div>
                    <p class="account-card-note">
                        What your generations have cost so far. Included in your plan — shown because
                        every lesson here is a real model call, not a canned one.
                    </p>
                    <div class="account-stats">
                        <div class="astat"><div class="astat-val">${field(`$${totalCost().toFixed(4)}`)}</div><div class="astat-lbl">Total</div></div>
                        <div class="astat"><div class="astat-val">${field(usage.calls)}</div><div class="astat-lbl">Model calls</div></div>
                        <div class="astat"><div class="astat-val">${field(usage.cached)}</div><div class="astat-lbl">Cached this session</div></div>
                    </div>
                </section>

                ${appearanceSectionHTML()}

                <section class="account-card">
                    <div class="account-card-head"><h3>Settings</h3></div>
                    <button class="account-row" id="acctIntro">
                        <span class="account-row-icon">${ICONS.star}</span>
                        <span class="account-row-text">
                            <strong>What you're interested in</strong>
                            <span>${esc(interestSummary())}</span>
                        </span>
                    </button>
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
                    <button class="account-row is-danger" id="acctDeleteAccount">
                        <span class="account-row-icon">${ICONS.trash}</span>
                        <span class="account-row-text">
                            <strong>Delete account</strong>
                            <span>Removes the account itself, ${esc(email)} included. Can't be undone.</span>
                        </span>
                    </button>
                </section>

                <p class="account-legal-footer">
                    <a href="terms.html" target="_blank" rel="noopener">Terms</a>
                    <span aria-hidden="true">·</span>
                    <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a>
                </p>`;

            document.getElementById('acctPlans').onclick = () => showUpgradePrompt();
            // This row is only ever about interests — replaying the whole
            // "what the app does" tour to change one answer was the getting-
            // to-know-you screens standing between someone and the one thing
            // they actually came here to edit.
            document.getElementById('acctIntro').onclick = () => startOnboarding({ replay: true, steps: ['interests'] });
            const reviewBtn = document.getElementById('acctReview');
            if (reviewBtn) reviewBtn.onclick = () => showReview();
            wireAppearanceRow();

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
                activeCourseId = null; courseData = null; progress = {};
                activeSourceText = ''; activeStructure = null;
                localStorage.removeItem(ACTIVE_STORAGE);
                dueOverview = [];
                renderHud();
                renderReviewBanner();
                renderAccount();
                toast('All courses deleted');
            };

            // delete_own_account() (a SECURITY DEFINER function, like debug_set_plan)
            // deletes the auth.users row for the caller only; every table's user_id
            // foreign key cascades from there, so this one RPC is the whole account.
            // The session it was called with stops being valid the instant it
            // succeeds, which is why nothing here signs out explicitly.
            document.getElementById('acctDeleteAccount').onclick = async () => {
                const ok = await uiConfirm(
                    'Delete your account?',
                    `${email} and everything on it — every course, all your progress, your subscription — are permanently removed. You'd need to sign up again to come back.`,
                    { confirmText: 'Delete my account', danger: true });
                if (!ok) return;
                const { error } = await supabaseClient.rpc('delete_own_account');
                if (error) {
                    console.error('delete_own_account failed:', error);
                    showError('Could not delete your account: ' + error.message);
                    return;
                }
                localStorage.clear();
                location.reload();
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
        // The model never draws. It returns a structured spec — "a right triangle
        // with these side labels", "these quantities compare like this", "this
        // word breaks into these letters" — and the app draws it: deterministic,
        // no image generation, no second API call, and a spec the app cannot draw
        // is dropped rather than shown broken.
        //
        // Every type lives in one entry of VISUALS (defined below the renderers),
        // which is the single source of truth for three things that used to be
        // written out separately and drifted apart: what the model is told it may
        // return (`use` + `spec`, which build the prompt catalogue), what survives
        // validation (`check`), and what is drawn (`draw`). Adding a type is one
        // entry, and the prompt updates itself.
        function renderVisual(v, opts = {}) {
            if (!v || !v.type) return '';
            const def = VISUALS[v.type];
            if (!def) return '';
            try {
                const inner = drawSpec(v, opts);
                return inner ? `<figure class="visual visual-${escAttr(v.type)}">${inner}</figure>` : '';
            } catch (err) {
                console.warn('Visual render failed:', v.type, err);
                return '';   // a broken diagram must never break the lesson
            }
        }

        // Draw one spec and its caption. Every type may carry a caption — it is
        // where a template puts the number it computed — so it is written here
        // once rather than in each renderer, and a figure inside a group gets
        // one on the same terms as a figure on its own.
        function drawSpec(v, opts) {
            const inner = VISUALS[v.type].draw(v, opts);
            if (!inner) return '';
            return inner + (v.caption ? `<div class="vis-caption">${esc(v.caption)}</div>` : '');
        }

        // Interactive visuals are drawn as strings like every other one, so they
        // arrive in the DOM inert. This gives them their behaviour, once, after
        // whatever inserted them has finished — a step body, a question, a
        // preview. A widget that throws while wiring stays a static picture
        // instead of taking the lesson down with it.
        function wireVisuals(root) {
            const scope = root || document;
            scope.querySelectorAll('[data-vis-interactive]').forEach(el => {
                if (el.dataset.visWired) return;
                el.dataset.visWired = '1';
                const wirer = { slider: wireSlider, reveal: wireReveal, gematria: wireGematria }[el.dataset.visInteractive];
                if (!wirer) return;
                try { wirer(el); } catch (err) {
                    console.warn('Visual wiring failed:', el.dataset.visInteractive, err);
                }
            });
        }

        // esc() is for text nodes; an attribute value also has to survive quotes.
        function escAttr(s) {
            return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        // Interactive widgets need an id to tie a label to its control, and the
        // same lesson can hold several of them.
        let visualSeq = 0;

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

        // ---- A safe arithmetic evaluator ----------------------------------
        // Interactive visuals recompute a formula as the learner drags a slider,
        // and the formula comes from the model. `eval` on model output is a
        // code-execution hole, so this parses a fixed grammar instead: numbers,
        // named variables, + - * / % ^, parentheses and a closed list of
        // functions. Anything outside that throws, and the widget degrades to
        // showing the formula rather than a wrong number.
        const EXPR_FUNCS = {
            sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor,
            ceil: Math.ceil, min: Math.min, max: Math.max, pow: Math.pow,
            sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log,
            ln: Math.log, log10: Math.log10, exp: Math.exp,
        };
        const EXPR_CONSTS = { pi: Math.PI, e: Math.E };

        function evalExpr(src, vars = {}) {
            // Models write maths with typographic operators. Normalise them once
            // here so the parser below only ever sees ASCII.
            // A thousands separator is dropped, an argument separator is not:
            // "1,000" is one number, `max(1, 5)` is two. Only a comma wedged
            // between a digit and three more digits is treated as punctuation.
            const s = String(src == null ? '' : src)
                .replace(/[−–—]/g, '-').replace(/[×·∙]/g, '*').replace(/[÷]/g, '/')
                .replace(/(\d),(?=\d{3}(\D|$))/g, '$1');
            let i = 0;

            const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
            const eat = tok => { ws(); if (s.startsWith(tok, i)) { i += tok.length; return true; } return false; };

            function parseExpr() {
                let left = parseTerm();
                for (;;) {
                    if (eat('+')) left += parseTerm();
                    else if (eat('-')) left -= parseTerm();
                    else return left;
                }
            }
            function parseTerm() {
                let left = parseUnary();
                for (;;) {
                    // `**` before `*`, or `x**2` eats the first star and then
                    // trips over the second.
                    if (eat('**')) left = Math.pow(left, parseUnary());
                    else if (eat('*')) left *= parseUnary();
                    else if (eat('/')) left /= parseUnary();
                    else if (eat('%')) left %= parseUnary();
                    else return left;
                }
            }
            function parseUnary() {
                if (eat('-')) return -parseUnary();
                if (eat('+')) return parseUnary();
                return parsePower();
            }
            function parsePower() {
                const base = parseAtom();
                if (eat('^')) return Math.pow(base, parseUnary());   // right-associative
                return base;
            }
            function parseAtom() {
                ws();
                if (eat('(')) {
                    const value = parseExpr();
                    if (!eat(')')) throw new Error('unbalanced parenthesis');
                    return value;
                }
                const rest = s.slice(i);
                const number = /^\d+(\.\d+)?/.exec(rest);
                if (number) { i += number[0].length; return Number(number[0]); }

                const ident = /^[A-Za-z_][A-Za-z_0-9]*/.exec(rest);
                if (!ident) throw new Error('unexpected character: ' + (s[i] || 'end of input'));
                const name = ident[0];
                i += name.length;

                if (eat('(')) {
                    const fn = EXPR_FUNCS[name.toLowerCase()];
                    if (!fn) throw new Error('unknown function: ' + name);
                    const args = [];
                    if (!eat(')')) {
                        do { args.push(parseExpr()); } while (eat(','));
                        if (!eat(')')) throw new Error('unbalanced call');
                    }
                    return fn(...args);
                }
                if (Object.prototype.hasOwnProperty.call(vars, name)) return Number(vars[name]);
                const lower = name.toLowerCase();
                if (Object.prototype.hasOwnProperty.call(vars, lower)) return Number(vars[lower]);
                if (lower in EXPR_CONSTS) return EXPR_CONSTS[lower];
                throw new Error('unknown name: ' + name);
            }

            const value = parseExpr();
            ws();
            if (i < s.length) throw new Error('trailing input: ' + s.slice(i));
            if (typeof value !== 'number' || !isFinite(value)) throw new Error('not a finite number');
            return value;
        }

        // The same evaluator where failure is an answer rather than an exception.
        function tryExpr(src, vars) {
            try { return evalExpr(src, vars); } catch (_) { return null; }
        }

        const num = (v, fallback = 0) => {
            const n = typeof v === 'string' ? Number(v) : v;
            return typeof n === 'number' && isFinite(n) ? n : fallback;
        };

        // Numbers a learner reads, not numbers a float produces: 2.5 stays 2.5,
        // 2.4999999999 becomes 2.5, and 6.0 becomes 6.
        function fmtNum(n, decimals = 2) {
            if (typeof n !== 'number' || !isFinite(n)) return '';
            const rounded = Number(n.toFixed(Math.max(0, Math.min(6, decimals))));
            // JS prints a negative number with a plain hyphen, but every formula
            // and equation string around it (`polynomial()`, "b² − 4ac", the
            // solve-linear steps) is hand-written with the real minus sign — a
            // hyphen sitting next to it in the same line of maths is what a
            // "-7" next to a "−4ac" looks like it is: a typo, not a value.
            return String(rounded).replace(/-/g, '−');
        }

        // ---- Geometry ------------------------------------------------------
        // A shape is drawn from its own measurements wherever the model supplies
        // them: given sides 3, 4, 5 the app draws a 3-4-5 triangle, so the right
        // angle the learner is being asked to find is a right angle on screen and
        // the longest side really is the longest one. Without usable lengths it
        // falls back to a regular figure of the right family — still a truthful
        // picture of "a triangle", just not to scale.
        const SHAPE_W = 320, SHAPE_H = 230, SHAPE_PAD = 42;

        function regularPolygon(n) {
            const pts = [];
            for (let k = 0; k < n; k++) {
                // The half-step rotation is what puts a flat side at the bottom
                // instead of standing a square on its corner.
                const t = Math.PI / 2 + Math.PI / n + (k * 2 * Math.PI) / n;
                pts.push([Math.cos(t), Math.sin(t)]);
            }
            return pts;
        }

        // Sides are the drawn edges in order: edge 0 joins vertex 0 to vertex 1,
        // edge 1 joins 1 to 2, edge 2 joins 2 back to 0. Three lengths that
        // cannot close into a triangle return null rather than a bent picture.
        function triangleFromSides(sides) {
            const [a, b, c] = sides.map(Number);
            if (![a, b, c].every(x => isFinite(x) && x > 0)) return null;
            if (a + b <= c || b + c <= a || a + c <= b) return null;
            const x = (c * c - b * b + a * a) / (2 * a);
            const y2 = c * c - x * x;
            if (!(y2 > 0)) return null;
            return [[0, 0], [a, 0], [x, Math.sqrt(y2)]];
        }

        function shapeGeometry(v) {
            const kind = String(v.shape || 'triangle').toLowerCase().replace(/\s+/g, '-');
            const sides = Array.isArray(v.sides) ? v.sides.map(Number) : [];

            if (kind === 'circle') return { kind: 'circle' };
            if (kind === 'triangle' || kind === 'right-triangle') {
                const measured = sides.length === 3 ? triangleFromSides(sides) : null;
                if (measured) return { kind: 'polygon', points: measured };
                return { kind: 'polygon', points: kind === 'right-triangle'
                    ? [[0, 0], [1.6, 0], [0, 1.2]]        // right angle at vertex 0
                    : [[0, 0], [2, 0], [0.75, 1.4]] };
            }
            if (kind === 'square') {
                const s = sides[0] > 0 ? sides[0] : 1;
                return { kind: 'polygon', points: [[0, 0], [s, 0], [s, s], [0, s]] };
            }
            if (kind === 'rectangle') {
                const w = num(v.width, sides[0] > 0 ? sides[0] : 2);
                const h = num(v.height, sides[1] > 0 ? sides[1] : 1.2);
                return { kind: 'polygon', points: [[0, 0], [w, 0], [w, h], [0, h]] };
            }
            if (kind === 'polygon') {
                const n = Math.round(num(v.n, (v.vertices || []).length || 5));
                return { kind: 'polygon', points: regularPolygon(Math.min(12, Math.max(3, n))) };
            }
            return null;
        }

        // Scale to the drawing box and flip: the geometry above is written with y
        // growing upward, SVG's y grows downward.
        function fitPoints(points) {
            const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minY = Math.min(...ys), maxY = Math.max(...ys);
            const spanX = Math.max(maxX - minX, 1e-6), spanY = Math.max(maxY - minY, 1e-6);
            const scale = Math.min((SHAPE_W - SHAPE_PAD * 2) / spanX, (SHAPE_H - SHAPE_PAD * 2) / spanY);
            const offX = (SHAPE_W - spanX * scale) / 2, offY = (SHAPE_H - spanY * scale) / 2;
            return points.map(([x, y]) => [
                offX + (x - minX) * scale,
                SHAPE_H - offY - (y - minY) * scale,
            ]);
        }

        const unit = ([x, y]) => { const m = Math.hypot(x, y) || 1; return [x / m, y / m]; };

        function vertexAngles(pts) {
            return pts.map((p, i) => {
                const prev = pts[(i - 1 + pts.length) % pts.length];
                const next = pts[(i + 1) % pts.length];
                const u = [prev[0] - p[0], prev[1] - p[1]];
                const w = [next[0] - p[0], next[1] - p[1]];
                const mag = Math.hypot(...u) * Math.hypot(...w);
                if (!mag) return 0;
                const cos = Math.max(-1, Math.min(1, (u[0] * w[0] + u[1] * w[1]) / mag));
                return (Math.acos(cos) * 180) / Math.PI;
            });
        }

        // `opts.interactive` turns the parts into targets a hotspot question can
        // be answered by tapping. Nothing else changes — the same figure is used
        // to explain and to test.
        function visShape(v, opts = {}) {
            const geo = shapeGeometry(v);
            if (!geo) return '';

            const hot = !!opts.interactive;
            const highlight = String(v.highlight || '');
            const partAttrs = id =>
                `data-part="${escAttr(id)}"${hot ? ' tabindex="0" role="button"' : ''}` +
                (highlight === id ? ' class="is-highlight"' : '');

            const label = (x, y, text, cls) =>
                `<text class="geo-label ${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}">${esc(text)}</text>`;

            let body = '';

            if (geo.kind === 'circle') {
                const cx = SHAPE_W / 2, cy = SHAPE_H / 2;
                const r = Math.min(SHAPE_W, SHAPE_H) / 2 - SHAPE_PAD;
                const radiusLabel = v.radiusLabel || (v.sideLabels || [])[0] || '';
                body = `
                    <circle class="geo-face geo-outline" cx="${cx}" cy="${cy}" r="${r}"></circle>
                    <g class="geo-part${hot ? ' is-hot' : ''}" ${partAttrs('side:0')}>
                        <line class="geo-edge" x1="${cx}" y1="${cy}" x2="${cx + r}" y2="${cy}"></line>
                    </g>
                    <circle class="geo-vertex" cx="${cx}" cy="${cy}" r="3.5"></circle>
                    ${radiusLabel ? label(cx + r / 2, cy - 10, radiusLabel, 'geo-side-label') : ''}
                    ${(v.vertices || [])[0] ? label(cx, cy + 20, v.vertices[0], 'geo-vertex-label') : ''}`;
            } else {
                const pts = fitPoints(geo.points);
                const centre = pts.reduce((acc, p) => [acc[0] + p[0] / pts.length, acc[1] + p[1] / pts.length], [0, 0]);
                const angles = vertexAngles(pts);
                const sideLabels = Array.isArray(v.sideLabels) ? v.sideLabels
                    : (Array.isArray(v.sides) ? v.sides.map(String) : []);
                const angleLabels = Array.isArray(v.angles) ? v.angles : [];
                const vertexLabels = Array.isArray(v.vertices) ? v.vertices : [];

                const edges = pts.map((p, i) => {
                    const q = pts[(i + 1) % pts.length];
                    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
                    const out = unit([mid[0] - centre[0], mid[1] - centre[1]]);
                    const text = sideLabels[i];
                    return `<g class="geo-part${hot ? ' is-hot' : ''}" ${partAttrs('side:' + i)}>
                        <line class="geo-edge" x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${q[0].toFixed(1)}" y2="${q[1].toFixed(1)}"></line>
                        ${hot ? `<line class="geo-edge-hit" x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${q[0].toFixed(1)}" y2="${q[1].toFixed(1)}"></line>` : ''}
                        ${text ? label(mid[0] + out[0] * 16, mid[1] + out[1] * 16 + 4, text, 'geo-side-label') : ''}
                    </g>`;
                }).join('');

                const corners = pts.map((p, i) => {
                    const prev = pts[(i - 1 + pts.length) % pts.length];
                    const next = pts[(i + 1) % pts.length];
                    const u = unit([prev[0] - p[0], prev[1] - p[1]]);
                    const w = unit([next[0] - p[0], next[1] - p[1]]);
                    const bis = unit([u[0] + w[0], u[1] + w[1]]);
                    const away = unit([p[0] - centre[0], p[1] - centre[1]]);
                    // A right angle gets the square that marks it as one, drawn
                    // from the two edges rather than assumed to point any way.
                    const square = Math.abs(angles[i] - 90) < 0.6
                        ? `<polyline class="geo-right-angle" points="${
                            [[p[0] + u[0] * 13, p[1] + u[1] * 13],
                             [p[0] + (u[0] + w[0]) * 13, p[1] + (u[1] + w[1]) * 13],
                             [p[0] + w[0] * 13, p[1] + w[1] * 13]]
                                .map(pt => pt.map(n => n.toFixed(1)).join(',')).join(' ')}"></polyline>`
                        : '';
                    const angleText = angleLabels[i];
                    return `<g class="geo-part${hot ? ' is-hot' : ''}" ${partAttrs('vertex:' + i)}>
                        <circle class="geo-vertex" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${hot ? 11 : 3.5}"></circle>
                        ${square}
                        ${vertexLabels[i] ? label(p[0] + away[0] * 17, p[1] + away[1] * 17 + 4, vertexLabels[i], 'geo-vertex-label') : ''}
                    </g>
                    ${angleText ? `<g class="geo-part${hot ? ' is-hot' : ''}" ${partAttrs('angle:' + i)}>
                        ${label(p[0] + bis[0] * 27, p[1] + bis[1] * 27 + 4, angleText, 'geo-angle-label')}
                    </g>` : ''}`;
                }).join('');

                body = `<polygon class="geo-face" points="${pts.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')}"></polygon>
                        ${edges}${corners}`;
            }

            return `<svg class="vis-shape" viewBox="0 0 ${SHAPE_W} ${SHAPE_H}" role="img"
                         aria-label="${escAttr(v.caption || v.shape || 'diagram')}">${body}</svg>
`;
        }

        // ---- Formulas and derivations --------------------------------------
        function visFormula(v) {
            if (!v.expression) return '';
            const where = (v.where || []).filter(w => w && w.symbol && w.meaning);
            return `<div class="vis-formula">
                <div class="formula-expr">${esc(v.expression)}</div>
                ${where.length ? `<dl class="formula-where">${where.map(w =>
                    `<div class="formula-term"><dt>${esc(w.symbol)}</dt><dd>${esc(w.meaning)}</dd></div>`).join('')}</dl>` : ''}
                ${v.note ? `<div class="vis-note">${esc(v.note)}</div>` : ''}
            </div>`;
        }

        function visEquation(v) {
            const lines = (v.lines || []).filter(l => l && l.expr);
            if (lines.length < 2) return '';
            return `<ol class="vis-equation">${lines.map(l => `
                <li class="eq-line">
                    <span class="eq-expr">${esc(l.expr)}</span>
                    ${l.note ? `<span class="eq-note">${esc(l.note)}</span>` : ''}
                </li>`).join('')}</ol>`;
        }

        // ---- Quantities -----------------------------------------------------
        function visNumberline(v) {
            const min = num(v.min, 0), max = num(v.max, 10);
            if (!(max > min)) return '';
            const ranges = (v.ranges || []).filter(r => r && isFinite(num(r.from, NaN)) && isFinite(num(r.to, NaN)));
            // Two ranges around the same centre — ±1σ and ±2σ — put their labels
            // on the same spot. Every second one drops a line, and the drawing
            // grows to make room for it.
            const rows = Math.min(2, Math.max(1, ranges.filter(r => r.label).length));
            const W = 320, H = 82 + rows * 14, PAD = 28, AXIS = 58;
            const at = t => PAD + ((Math.max(min, Math.min(max, t)) - min) / (max - min)) * (W - PAD * 2);

            // Enough ticks to read the scale, never so many they collide.
            let step = num(v.step, 0);
            if (!(step > 0) || (max - min) / step > 20) step = (max - min) / 5;
            const ticks = [];
            for (let t = min; t <= max + step / 1000 && ticks.length <= 21; t += step) ticks.push(t);

            const rangeSvg = ranges.map((r, i) => {
                const x1 = at(Math.min(num(r.from), num(r.to))), x2 = at(Math.max(num(r.from), num(r.to)));
                return `<rect class="nl-range" x="${x1.toFixed(1)}" y="${AXIS - 7}" width="${Math.max(2, x2 - x1).toFixed(1)}" height="14" rx="4"></rect>
                        ${r.label ? `<text class="nl-range-label" x="${((x1 + x2) / 2).toFixed(1)}" y="${AXIS + 30 + (i % 2) * 14}">${esc(r.label)}</text>` : ''}`;
            }).join('');

            const points = (v.points || []).filter(p => p && isFinite(num(p.value, NaN))).map(p => {
                const x = at(num(p.value));
                return `<circle class="nl-point" cx="${x.toFixed(1)}" cy="${AXIS}" r="6"></circle>
                        ${p.label ? `<text class="nl-point-label" x="${x.toFixed(1)}" y="${AXIS - 16}">${esc(p.label)}</text>` : ''}`;
            }).join('');

            return `<svg class="vis-numberline" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escAttr(v.caption || 'number line')}">
                <line class="nl-axis" x1="${PAD}" y1="${AXIS}" x2="${W - PAD}" y2="${AXIS}"></line>
                ${rangeSvg}
                ${ticks.map(t => `<g><line class="nl-tick" x1="${at(t).toFixed(1)}" y1="${AXIS - 5}" x2="${at(t).toFixed(1)}" y2="${AXIS + 5}"></line>
                    <text class="nl-tick-label" x="${at(t).toFixed(1)}" y="${AXIS + 19}">${esc(fmtNum(t, 2))}</text></g>`).join('')}
                ${points}
            </svg>
`;
        }

        const plotPoints = s => (s.points || [])
            .map(p => Array.isArray(p) ? [num(p[0], NaN), num(p[1], NaN)] : [num(p?.x, NaN), num(p?.y, NaN)])
            .filter(p => isFinite(p[0]) && isFinite(p[1]));

        function visPlot(v) {
            const series = (v.series || []).filter(s => s && plotPoints(s).length >= 2).slice(0, 2);
            if (!series.length) return '';
            const W = 320, H = 220, L = 44, R = 14, T = 16, B = 40;
            const all = series.flatMap(plotPoints);
            const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minY = Math.min(0, ...ys), maxY = Math.max(...ys);
            const sx = x => L + ((x - minX) / Math.max(maxX - minX, 1e-6)) * (W - L - R);
            const sy = y => H - B - ((y - minY) / Math.max(maxY - minY, 1e-6)) * (H - T - B);

            const lines = series.map((s, i) => {
                const pts = plotPoints(s).sort((a, b) => a[0] - b[0]);
                const path = pts.map(p => `${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ');
                return `<polyline class="plot-line plot-line-${i}" points="${path}"></polyline>
                        ${pts.map(p => `<circle class="plot-dot plot-dot-${i}" cx="${sx(p[0]).toFixed(1)}" cy="${sy(p[1]).toFixed(1)}" r="3.5"></circle>`).join('')}`;
            }).join('');

            const legend = series.some(s => s.label)
                ? `<div class="plot-legend">${series.map((s, i) =>
                    `<span class="plot-key"><span class="plot-swatch plot-swatch-${i}"></span>${esc(s.label || `Series ${i + 1}`)}</span>`).join('')}</div>`
                : '';

            return `<svg class="vis-plot" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escAttr(v.caption || 'plot')}">
                <line class="plot-axis" x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"></line>
                <line class="plot-axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"></line>
                <text class="plot-tick" x="${L - 6}" y="${H - B + 4}" text-anchor="end">${esc(fmtNum(minY, 1))}</text>
                <text class="plot-tick" x="${L - 6}" y="${T + 10}" text-anchor="end">${esc(fmtNum(maxY, 1))}</text>
                <text class="plot-tick" x="${L}" y="${H - B + 18}">${esc(fmtNum(minX, 1))}</text>
                <text class="plot-tick" x="${W - R}" y="${H - B + 18}" text-anchor="end">${esc(fmtNum(maxX, 1))}</text>
                ${v.xLabel ? `<text class="plot-axis-label" x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">${esc(v.xLabel)}</text>` : ''}
                ${v.yLabel ? `<text class="plot-axis-label" x="${-(T + H - B) / 2}" y="14" transform="rotate(-90)" text-anchor="middle">${esc(v.yLabel)}</text>` : ''}
                ${lines}
            </svg>${legend}`;
        }

        function visPie(v) {
            const slices = (v.slices || []).filter(s => s && num(s.value, -1) > 0).slice(0, 6);
            const total = slices.reduce((t, s) => t + num(s.value), 0);
            if (slices.length < 2 || !(total > 0)) return '';
            const R = 78, C = 90;
            const point = deg => {
                const rad = ((deg - 90) * Math.PI) / 180;
                return [C + R * Math.cos(rad), C + R * Math.sin(rad)];
            };
            let angle = 0;
            const paths = slices.map((s, i) => {
                const sweep = (num(s.value) / total) * 360;
                const [x1, y1] = point(angle);
                const [x2, y2] = point(angle + sweep);
                angle += sweep;
                const large = sweep > 180 ? 1 : 0;
                return `<path class="pie-slice pie-slice-${i}" d="M ${C} ${C} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z"></path>`;
            }).join('');

            // A slice's own value and "share of the total" are the same fact
            // twice whenever the value is already a percentage — the prompt's
            // own example spec hands the model unit:"%" with slices that sum to
            // 100, and every legend row came out "96% · 96%". Only a slice given
            // in some other unit ($, students, kg) makes the share worth stating
            // as a second, different number.
            const val = s => v.unit === '%'
                ? `${esc(fmtNum(num(s.value), 1))}%`
                : `${esc(fmtNum(num(s.value), 1))}${esc(v.unit || '')} · ${Math.round((num(s.value) / total) * 100)}%`;
            return `<div class="vis-pie">
                <svg viewBox="0 0 ${C * 2} ${C * 2}" role="img" aria-label="${escAttr(v.caption || 'proportions')}">${paths}</svg>
                <ul class="pie-legend">${slices.map((s, i) => `
                    <li><span class="pie-swatch pie-slice-${i}"></span>
                        <span class="pie-key">${esc(s.label || '')}</span>
                        <span class="pie-val">${val(s)}</span>
                    </li>`).join('')}</ul>
            </div>`;
        }

        // ---- Sets, cycles, grids -------------------------------------------
        function visVenn(v) {
            if (!v.left || !v.right) return '';
            const region = (r, cls) => {
                const pts = (r?.points || []).filter(Boolean);
                if (!r?.title && !pts.length) return '';
                return `<div class="venn-region ${cls}">
                    <div class="venn-region-title">${esc(r.title || '')}</div>
                    ${pts.length ? `<ul>${pts.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
                </div>`;
            };
            return `<div class="vis-venn">
                <svg viewBox="0 0 300 150" role="img" aria-label="${escAttr(v.caption || 'overlapping sets')}">
                    <circle class="venn-circle" cx="115" cy="75" r="62"></circle>
                    <circle class="venn-circle" cx="185" cy="75" r="62"></circle>
                    <text class="venn-label" x="78" y="80">${esc((v.left.title || '').slice(0, 14))}</text>
                    <text class="venn-label venn-label-both" x="150" y="80">${esc((v.overlap?.title || 'both').slice(0, 10))}</text>
                    <text class="venn-label" x="222" y="80">${esc((v.right.title || '').slice(0, 14))}</text>
                </svg>
                <div class="venn-regions">
                    ${region(v.left, 'venn-a')}
                    ${region(v.overlap, 'venn-both')}
                    ${region(v.right, 'venn-b')}
                </div>
            </div>`;
        }

        // A loop drawn as a ring puts every label at a different angle and makes
        // the longest one unreadable. The same information reads better as the
        // flow it is, with the return arrow made explicit at the end.
        function visCycle(v) {
            const steps = (v.steps || []).filter(Boolean);
            if (steps.length < 2) return '';
            return `<div class="vis-cycle">
                <div class="cycle-ring">${steps.map((s, i) => `
                    <div class="cycle-node"><span class="cycle-index">${i + 1}</span>${esc(s)}</div>
                    <div class="cycle-arrow" aria-hidden="true">→</div>`).join('')}
                    <div class="cycle-node cycle-restart">${esc(steps[0])}</div>
                </div>
                <div class="cycle-note">${v.note ? esc(v.note) : 'and round again'}</div>
            </div>`;
        }

        function visGrid(v) {
            const rows = (v.cells || []).filter(r => Array.isArray(r));
            if (!rows.length) return '';
            const cols = v.colHeaders || [];
            const rowHeads = v.rowHeaders || [];
            const marked = new Set((v.highlight || [])
                .filter(h => Array.isArray(h) && h.length === 2).map(h => `${h[0]}:${h[1]}`));
            return `<div class="vis-table-wrap"><table class="vis-table vis-grid">
                ${cols.length ? `<thead><tr>${rowHeads.length ? '<th></th>' : ''}${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>` : ''}
                <tbody>${rows.map((row, r) => `<tr>
                    ${rowHeads.length ? `<th scope="row">${esc(rowHeads[r] || '')}</th>` : ''}
                    ${row.map((cell, c) => `<td class="${marked.has(`${r}:${c}`) ? 'is-highlight' : ''}">${esc(cell)}</td>`).join('')}
                </tr>`).join('')}</tbody>
            </table></div>
`;
        }

        // ---- Gematria --------------------------------------------------------
        // The numeric value of Hebrew letters is a fixed table, so the app
        // computes it rather than trusting the model's arithmetic: a lesson on
        // gematria that adds up wrong is worse than no lesson. The model supplies
        // the words and what they mean; the sums are ours.
        const GEMATRIA_LETTERS = [
            ['א', 1], ['ב', 2], ['ג', 3], ['ד', 4], ['ה', 5], ['ו', 6], ['ז', 7], ['ח', 8], ['ט', 9],
            ['י', 10], ['כ', 20], ['ל', 30], ['מ', 40], ['נ', 50], ['ס', 60], ['ע', 70], ['פ', 80], ['צ', 90],
            ['ק', 100], ['ר', 200], ['ש', 300], ['ת', 400],
        ];
        // Final forms carry their base value in the standard reckoning; only
        // mispar gadol gives them 500-900.
        const GEMATRIA_FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
        const GEMATRIA_FINAL_HIGH = { 'ך': 500, 'ם': 600, 'ן': 700, 'ף': 800, 'ץ': 900 };
        const GEMATRIA_BASE = Object.fromEntries(GEMATRIA_LETTERS);
        const GEMATRIA_ORDINAL = Object.fromEntries(GEMATRIA_LETTERS.map(([ch], i) => [ch, i + 1]));

        function gematriaValue(ch, method = 'standard') {
            const base = GEMATRIA_FINALS[ch] || ch;
            if (!(base in GEMATRIA_BASE)) return null;
            if (method === 'gadol' && ch in GEMATRIA_FINAL_HIGH) return GEMATRIA_FINAL_HIGH[ch];
            if (method === 'ordinal') return GEMATRIA_ORDINAL[base];
            if (method === 'katan') {
                // Trailing zeros dropped: ת(400) → 4, כ(20) → 2, ז(7) → 7.
                let n = GEMATRIA_BASE[base];
                while (n >= 10 && n % 10 === 0) n /= 10;
                return n;
            }
            return GEMATRIA_BASE[base];
        }

        function gematriaBreakdown(word, method = 'standard') {
            const letters = [];
            let total = 0;
            for (const ch of String(word || '')) {
                const value = gematriaValue(ch, method);
                if (value == null) continue;          // vowels, spaces, punctuation
                letters.push({ letter: ch, value });
                total += value;
            }
            return { letters, total };
        }

        const GEMATRIA_METHOD_NAMES = {
            standard: 'מספר הכרחי', gadol: 'מספר גדול',
            ordinal: 'מספר סידורי', katan: 'מספר קטן',
        };

        function gematriaTiles(word, method) {
            const { letters, total } = gematriaBreakdown(word, method);
            if (!letters.length) return '';
            return `<div class="gem-row" dir="rtl">
                ${letters.map(l => `<span class="gem-tile"><span class="gem-letter">${esc(l.letter)}</span><span class="gem-value">${l.value}</span></span>`).join('<span class="gem-plus" aria-hidden="true">+</span>')}
                <span class="gem-equals" aria-hidden="true">=</span>
                <span class="gem-total">${total}</span>
            </div>`;
        }

        function visGematria(v) {
            const method = ['standard', 'gadol', 'ordinal', 'katan'].includes(v.method) ? v.method : 'standard';
            const words = (v.words || []).filter(w => w && w.word && gematriaBreakdown(w.word, method).letters.length);
            if (!words.length) return '';
            return `<div class="vis-gematria" data-vis-interactive="gematria" data-method="${escAttr(method)}">
                <div class="gem-method">${esc(GEMATRIA_METHOD_NAMES[method])}</div>
                ${words.map(w => `<div class="gem-word">
                    ${gematriaTiles(w.word, method)}
                    ${w.note ? `<div class="gem-note">${esc(w.note)}</div>` : ''}
                </div>`).join('')}
                <div class="gem-try">
                    <label class="gem-try-label" for="${'gemTry' + (++visualSeq)}">Try a word</label>
                    <input class="text-input gem-input" id="${'gemTry' + visualSeq}" dir="rtl" autocomplete="off" placeholder="…">
                    <div class="gem-out" aria-live="polite"></div>
                </div>
            </div>`;
        }

        function wireGematria(el) {
            const input = el.querySelector('.gem-input');
            const out = el.querySelector('.gem-out');
            if (!input || !out) return;
            const method = el.dataset.method || 'standard';
            input.oninput = () => { out.innerHTML = gematriaTiles(input.value.trim(), method); };
        }

        // ---- Tap to reveal ---------------------------------------------------
        function visReveal(v) {
            const items = (v.items || []).filter(i => i && i.label && i.text);
            if (items.length < 2) return '';
            return `<div class="vis-reveal" data-vis-interactive="reveal">
                ${items.map(it => `
                    <button type="button" class="reveal-card" aria-expanded="false">
                        <span class="reveal-label">${esc(it.label)}</span>
                        <span class="reveal-hint">Tap to reveal</span>
                        <span class="reveal-text" hidden>${esc(it.text)}</span>
                    </button>`).join('')}
            </div>`;
        }

        function wireReveal(el) {
            el.querySelectorAll('.reveal-card').forEach(card => {
                card.onclick = () => {
                    const text = card.querySelector('.reveal-text');
                    const hint = card.querySelector('.reveal-hint');
                    const open = text.hidden;
                    text.hidden = !open;
                    if (hint) hint.hidden = open;
                    card.classList.toggle('is-open', open);
                    card.setAttribute('aria-expanded', String(open));
                };
            });
        }

        // ---- Drag a value, watch the numbers move ---------------------------
        // The one thing a static diagram cannot do: show that a quantity depends
        // on another one. The model supplies the range and the formulas; the app
        // evaluates them, so the arithmetic on screen is always right even when
        // the model's own arithmetic would not have been.
        function sliderSpec(v) {
            const min = num(v.min, 0);
            const max = num(v.max, min + 10);
            if (!(max > min)) return null;
            const step = num(v.step, 0) > 0 ? num(v.step) : Number(((max - min) / 20).toPrecision(2));
            const value = Math.min(max, Math.max(min, num(v.value, (min + max) / 2)));
            const variable = /^[A-Za-z_][A-Za-z_0-9]*$/.test(String(v.variable || '')) ? String(v.variable) : 'x';
            const constants = {};
            if (v.constants && typeof v.constants === 'object') {
                for (const [k, val] of Object.entries(v.constants)) {
                    if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(k) && isFinite(num(val, NaN))) constants[k] = num(val);
                }
            }
            const outputs = (v.outputs || [])
                .filter(o => o && o.expr && tryExpr(o.expr, { ...constants, [variable]: value }) !== null)
                .slice(0, 3)
                .map(o => ({ label: String(o.label || ''), expr: String(o.expr),
                             unit: o.unit ? String(o.unit) : '', decimals: Math.max(0, Math.min(4, num(o.decimals, 2))) }));
            if (!outputs.length) return null;   // nothing computable: not a slider
            return { variable, label: String(v.label || variable), min, max, step, value,
                     unit: v.unit ? String(v.unit) : '', constants, outputs, note: v.note ? String(v.note) : '' };
        }

        function visSlider(v) {
            const spec = sliderSpec(v);
            if (!spec) return '';
            const id = 'slider' + (++visualSeq);
            return `<div class="vis-slider" data-vis-interactive="slider" data-spec="${escAttr(JSON.stringify(spec))}">
                <div class="slider-head">
                    <label class="slider-label" for="${id}">${esc(spec.label)}</label>
                    <output class="slider-value" data-slider-out>${esc(fmtNum(spec.value, 2))}${esc(spec.unit)}</output>
                </div>
                <input class="slider-input" id="${id}" type="range"
                       min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${spec.value}">
                <div class="slider-outputs">${spec.outputs.map((o, i) => `
                    <div class="slider-out">
                        <span class="slider-out-label">${esc(o.label)}</span>
                        <span class="slider-out-value" data-out="${i}"></span>
                    </div>`).join('')}</div>
                ${spec.note ? `<div class="vis-note">${esc(spec.note)}</div>` : ''}
            </div>`;
        }

        function wireSlider(el) {
            const spec = JSON.parse(el.dataset.spec);
            const input = el.querySelector('.slider-input');
            const readout = el.querySelector('[data-slider-out]');
            if (!input) return;

            const update = () => {
                const value = Number(input.value);
                if (readout) readout.textContent = fmtNum(value, 2) + spec.unit;
                spec.outputs.forEach((o, i) => {
                    const cell = el.querySelector(`[data-out="${i}"]`);
                    if (!cell) return;
                    const result = tryExpr(o.expr, { ...spec.constants, [spec.variable]: value });
                    cell.textContent = result === null ? '—' : fmtNum(result, o.decimals) + o.unit;
                });
            };
            input.oninput = update;
            update();
        }

        // ---- The registry ----------------------------------------------------
        // `use` and `spec` are what the model is shown; `check` is what a spec
        // must survive to be drawn; `draw` draws it. One entry per type, so the
        // catalogue in the prompt can never describe a type the app cannot draw.
        const VISUALS = {
            flow: {
                use: 'a process or sequence of steps',
                spec: '{"type":"flow","steps":["Step one","Step two","Step three"]}',
                check: v => Array.isArray(v.steps) && v.steps.filter(Boolean).length >= 2,
                draw: visFlow,
            },
            cycle: {
                use: 'a process that returns to its start (a loop, a repeating cycle)',
                spec: '{"type":"cycle","steps":["Stage one","Stage two","Stage three"],"note":"optional"}',
                check: v => Array.isArray(v.steps) && v.steps.filter(Boolean).length >= 2,
                draw: visCycle,
            },
            compare: {
                use: 'two things side by side',
                spec: '{"type":"compare","left":{"title":"A","points":["…"]},"right":{"title":"B","points":["…"]}}',
                check: v => v.left && v.right && Array.isArray(v.left.points) && Array.isArray(v.right.points),
                draw: visCompare,
            },
            venn: {
                use: 'two categories that overlap, and what belongs to both',
                spec: '{"type":"venn","left":{"title":"A","points":["…"]},"right":{"title":"B","points":["…"]},"overlap":{"title":"both","points":["…"]}}',
                check: v => v.left?.title && v.right?.title,
                draw: visVenn,
            },
            hierarchy: {
                use: 'a whole and its parts',
                spec: '{"type":"hierarchy","root":"Main idea","children":["Part one","Part two"]}',
                check: v => v.root && Array.isArray(v.children) && v.children.filter(Boolean).length >= 1,
                draw: visHierarchy,
            },
            timeline: {
                use: 'events in chronological order',
                spec: '{"type":"timeline","events":[{"label":"1990","text":"What happened"}]}',
                check: v => Array.isArray(v.events) && v.events.some(e => e && (e.label || e.text)),
                draw: visTimeline,
            },
            table: {
                use: 'structured facts with the same fields repeated',
                spec: '{"type":"table","headers":["Col A","Col B"],"rows":[["a1","b1"],["a2","b2"]]}',
                check: v => Array.isArray(v.headers) && v.headers.length
                            && Array.isArray(v.rows) && v.rows.some(r => Array.isArray(r) && r.length),
                draw: visTable,
            },
            grid: {
                use: 'a labelled grid — times table, case matrix, Punnett square. "highlight" marks [row,col] cells',
                spec: '{"type":"grid","rowHeaders":["r1","r2"],"colHeaders":["c1","c2"],"cells":[["a","b"],["c","d"]],"highlight":[[0,1]]}',
                check: v => Array.isArray(v.cells) && v.cells.some(r => Array.isArray(r) && r.length),
                draw: visGrid,
            },
            bar: {
                use: 'comparing quantities of the same kind',
                spec: '{"type":"bar","unit":"%","bars":[{"label":"X","value":40},{"label":"Y","value":75}]}',
                check: v => Array.isArray(v.bars) && v.bars.some(b => b && typeof b.value === 'number' && isFinite(b.value)),
                draw: visBar,
            },
            pie: {
                use: 'parts of one whole (percentages of a total, a budget split)',
                spec: '{"type":"pie","unit":"%","slices":[{"label":"A","value":40},{"label":"B","value":60}]}',
                check: v => Array.isArray(v.slices) && v.slices.filter(s => s && num(s.value, -1) > 0).length >= 2,
                draw: visPie,
            },
            shape: {
                use: 'geometry: triangle | right-triangle | square | rectangle | circle | polygon. "sides" are the real lengths of edge 0 (vertices 0→1), edge 1 (1→2), edge 2 (2→0) — give them and it is drawn to scale. sideLabels / angles / vertices label those same parts, in that order',
                spec: '{"type":"shape","shape":"right-triangle","sides":[3,4,5],"sideLabels":["a = 3","b = 4","c = 5"],"angles":["","90°",""],"vertices":["A","B","C"],"caption":"optional"}',
                check: v => !!shapeGeometry(v),
                draw: visShape,
            },
            formula: {
                use: 'a rule or formula, with every symbol in it explained',
                spec: '{"type":"formula","expression":"A = (b × h) / 2","where":[{"symbol":"b","meaning":"base"},{"symbol":"h","meaning":"height"}],"note":"optional"}',
                check: v => !!v.expression,
                draw: visFormula,
            },
            equation: {
                use: 'a calculation worked line by line, each line saying what changed',
                spec: '{"type":"equation","lines":[{"expr":"2x + 4 = 10","note":"start"},{"expr":"2x = 6","note":"subtract 4"},{"expr":"x = 3","note":"divide by 2"}]}',
                check: v => Array.isArray(v.lines) && v.lines.filter(l => l && l.expr).length >= 2,
                draw: visEquation,
            },
            numberline: {
                use: 'where values sit on a scale — a threshold, a bracket, a range',
                spec: '{"type":"numberline","min":0,"max":100,"step":20,"points":[{"value":65,"label":"pass"}],"ranges":[{"from":65,"to":100,"label":"passing"}]}',
                check: v => num(v.max, 0) > num(v.min, 0),
                draw: visNumberline,
            },
            plot: {
                use: 'how one quantity changes with another (at most two series)',
                spec: '{"type":"plot","xLabel":"years","yLabel":"₪","series":[{"label":"balance","points":[[0,1000],[1,1050],[2,1102]]}]}',
                check: v => Array.isArray(v.series) && v.series.some(s => s && plotPoints(s).length >= 2),
                draw: visPlot,
            },
            gematria: {
                use: 'Hebrew letters as numbers. Give the words and their meaning; the app computes every value and total. method: standard | gadol | ordinal | katan',
                spec: '{"type":"gematria","method":"standard","words":[{"word":"אמת","note":"what the source says about it"}]}',
                check: v => Array.isArray(v.words) && v.words.some(w => w && w.word && gematriaBreakdown(w.word, v.method).letters.length),
                draw: visGematria,
            },
            reveal: {
                use: 'INTERACTIVE. Cards tapped to uncover — a term to recall before reading it',
                spec: '{"type":"reveal","items":[{"label":"Term","text":"What it means"},{"label":"Term 2","text":"…"}]}',
                check: v => Array.isArray(v.items) && v.items.filter(i => i && i.label && i.text).length >= 2,
                draw: visReveal,
            },
            slider: {
                use: 'INTERACTIVE. A quantity the learner drags while dependent values recompute. "outputs" are formulas in the variable and any "constants". Use it whenever one number depends on another',
                spec: '{"type":"slider","variable":"b","label":"Base (cm)","min":1,"max":12,"step":1,"value":4,"unit":" cm","constants":{"h":6},"outputs":[{"label":"Area","expr":"b * h / 2","unit":" cm²","decimals":1}]}',
                check: v => !!sliderSpec(v),
                draw: visSlider,
            },
            // Not offered to the model — a template produces it when one idea
            // needs more than one figure: the formula *and* the graph, the
            // triangle *and* the working. One level deep only, so a group can
            // never contain a group.
            group: {
                internal: true,
                use: 'several figures shown together',
                spec: '{"type":"group","items":[]}',
                check: v => Array.isArray(v.items)
                            && v.items.filter(i => i && i.type !== 'group' && VISUALS[i.type]).length >= 1,
                draw: (v, opts) => (v.items || [])
                    .filter(i => i && i.type !== 'group' && VISUALS[i.type])
                    .map(i => `<div class="vis-group-item">${drawSpec(i, opts)}</div>`)
                    .join(''),
            },
        };

        // What the model is allowed to return, written out of the registry so the
        // prompt and the renderer can never disagree.
        function visualCatalogue() {
            return Object.entries(VISUALS)
                .filter(([, def]) => !def.internal)
                .map(([name, def]) => `  "${name}" — ${def.use}\n      ${def.spec}`)
                .join('\n');
        }

        // ============= Templates =============
        // The model is a bad draughtsman and a worse calculator, but it knows
        // what a lesson is about. So it stops specifying figures and starts
        // *choosing* them: "this is a right triangle, the legs are 6 and 8" —
        // and the app builds the picture, computes the hypotenuse, and writes
        // the numbers in. Everything that can be got wrong is done here.
        //
        // A template is not a new kind of figure. Every one of them composes the
        // primitives above, so a template can be added without touching the
        // renderer, and a lesson stores the *expanded* spec — which means a
        // cached lesson keeps working even if its template is later changed or
        // withdrawn.
        //
        // `domains` decides which shelf a lesson is shown: the course plan
        // labels every concept with its subject, and only that subject's
        // templates reach the prompt. That is what keeps a library this size
        // affordable to offer, and it is why the model picks well — eight
        // candidates that all fit, not thirty that mostly don't.

        // Read a number the model sent: coerced, defaulted, and clamped to a
        // range the renderer can actually draw. A template never sees a string,
        // a NaN, or a request for a 900-sided polygon.
        function tNum(params, key, fallback, min = -1e9, max = 1e9) {
            const raw = params ? params[key] : undefined;
            const n = typeof raw === 'string' ? Number(raw.replace(/[^\d.\-]/g, '')) : raw;
            const value = (typeof n === 'number' && isFinite(n)) ? n : fallback;
            return Math.min(max, Math.max(min, value));
        }
        function tStr(params, key, fallback = '') {
            const raw = params ? params[key] : undefined;
            return raw == null ? fallback : String(raw).slice(0, 60);
        }
        // A list of numbers, however the model chose to write it.
        function tList(params, key, fallback = [], max = 12) {
            let raw = params ? params[key] : undefined;
            if (typeof raw === 'string') raw = raw.split(/[,;\s]+/);
            if (!Array.isArray(raw)) return fallback;
            const out = raw.map(Number).filter(n => isFinite(n));
            return out.length ? out.slice(0, max) : fallback;
        }
        function tWords(params, key, fallback = [], max = 12) {
            let raw = params ? params[key] : undefined;
            if (typeof raw === 'string') raw = raw.split(/[,;]+/);
            if (!Array.isArray(raw)) return fallback;
            const out = raw.map(w => String(w).trim().slice(0, 40)).filter(Boolean);
            return out.length ? out.slice(0, max) : fallback;
        }
        const withUnit = (n, unit, decimals = 2) => fmtNum(n, decimals) + (unit ? ' ' + unit : '');

        // "y = 1x² + -2x + -3" is what naive string-building produces and no
        // textbook has ever printed. Terms are given as [coefficient, symbol].
        function polynomial(terms) {
            let out = '';
            for (const [coefficient, symbol] of terms) {
                if (!coefficient) continue;
                const mag = Math.abs(coefficient);
                const shown = (mag === 1 && symbol) ? '' : fmtNum(mag);
                if (!out) out = (coefficient < 0 ? '−' : '') + shown + symbol;
                else out += (coefficient < 0 ? ' − ' : ' + ') + shown + symbol;
            }
            return out || '0';
        }

        // Sample a function across a range for `plot`. The app evaluates; the
        // model never hands over a list of points it worked out itself.
        function samplePoints(from, to, steps, fn) {
            const pts = [];
            const n = Math.max(2, Math.min(60, Math.round(steps)));
            for (let i = 0; i <= n; i++) {
                const x = from + ((to - from) * i) / n;
                const y = fn(x);
                if (isFinite(y)) pts.push([x, y]);
            }
            return pts;
        }

        // ---- Boolean logic, for truth tables --------------------------------
        // Its own parser rather than the arithmetic one: the operators are
        // different, and a truth table computed by a language model is a truth
        // table with a wrong row in it.
        function evalBool(src, vars) {
            const s = String(src || '')
                .replace(/[¬~]/g, '!').replace(/[∧&]+/g, ' and ').replace(/[∨|]+/g, ' or ')
                .replace(/[⊕]/g, ' xor ').replace(/(<->|↔|≡)/g, ' iff ').replace(/(->|→|⇒)/g, ' then ');
            let i = 0;
            const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
            const word = w => {
                ws();
                if (!s.slice(i).toLowerCase().startsWith(w)) return false;
                const after = s[i + w.length];
                if (after && /[A-Za-z0-9_]/.test(after)) return false;   // "android" is not "and"
                i += w.length;
                return true;
            };
            const sym = c => { ws(); if (s[i] === c) { i++; return true; } return false; };

            function parseIff() {
                let left = parseThen();
                while (word('iff')) { const r = parseThen(); left = left === r; }
                return left;
            }
            function parseThen() {
                const left = parseOr();
                if (!word('then')) return left;
                // The right side is parsed before the verdict, not inside it:
                // `||` would short-circuit and leave "B" unread, and the parser
                // would then reject the whole expression as trailing input.
                const right = parseThen();                        // right-associative
                return !left || right;
            }
            function parseOr() {
                let left = parseXor();
                while (word('or')) left = parseXor() || left;
                return left;
            }
            function parseXor() {
                let left = parseAnd();
                while (word('xor')) left = parseAnd() !== left;
                return left;
            }
            function parseAnd() {
                let left = parseNot();
                while (word('and')) left = parseNot() && left;
                return left;
            }
            function parseNot() {
                if (sym('!') || word('not')) return !parseNot();
                return parseAtom();
            }
            function parseAtom() {
                if (sym('(')) {
                    const value = parseIff();
                    if (!sym(')')) throw new Error('unbalanced');
                    return value;
                }
                ws();
                const m = /^[A-Za-z_][A-Za-z_0-9]*/.exec(s.slice(i));
                if (!m) throw new Error('unexpected input');
                i += m[0].length;
                const name = m[0];
                if (/^(true|t|1)$/i.test(name)) return true;
                if (/^(false|f|0)$/i.test(name)) return false;
                if (!(name in vars)) throw new Error('unknown variable: ' + name);
                return !!vars[name];
            }

            const out = parseIff();
            ws();
            if (i < s.length) throw new Error('trailing input');
            return out;
        }

        const TEMPLATES = {
            // ---- Mathematics ------------------------------------------------
            'right-triangle': {
                domains: ['math'],
                use: 'a right triangle from its two legs — hypotenuse computed, drawn to scale, right angle marked',
                params: 'a, b (the legs), unit',
                build: p => {
                    const a = tNum(p, 'a', 3, 0.1, 1000), b = tNum(p, 'b', 4, 0.1, 1000);
                    const c = Math.hypot(a, b);
                    const u = tStr(p, 'unit');
                    return [
                        { type: 'shape', shape: 'right-triangle', sides: [a, b, c],
                          sideLabels: [withUnit(a, u), withUnit(b, u), withUnit(c, u)],
                          angles: ['', '90°', ''], vertices: ['A', 'B', 'C'] },
                        { type: 'formula', expression: `${fmtNum(a)}² + ${fmtNum(b)}² = ${fmtNum(c * c)}`,
                          note: `c = √${fmtNum(c * c)} = ${withUnit(c, u, 3)}` },
                    ];
                },
            },
            'triangle': {
                domains: ['math'],
                use: 'any triangle from its three sides — drawn to scale, every angle computed',
                params: 'a, b, c (sides), unit',
                build: p => {
                    const sides = [tNum(p, 'a', 5, 0.1, 1000), tNum(p, 'b', 6, 0.1, 1000), tNum(p, 'c', 7, 0.1, 1000)];
                    const pts = triangleFromSides(sides);
                    if (!pts) return null;                       // no such triangle: no figure
                    const u = tStr(p, 'unit');
                    const angles = vertexAngles(pts).map(a => `${fmtNum(a, 1)}°`);
                    return { type: 'shape', shape: 'triangle', sides,
                             sideLabels: sides.map(s => withUnit(s, u)), angles,
                             vertices: ['A', 'B', 'C'],
                             caption: `Angles add to ${fmtNum(vertexAngles(pts).reduce((t, a) => t + a, 0), 0)}°` };
                },
            },
            'rectangle': {
                domains: ['math'],
                use: 'a rectangle or square, with area and perimeter computed',
                params: 'width, height, unit',
                build: p => {
                    const w = tNum(p, 'width', 4, 0.1, 1000), h = tNum(p, 'height', 3, 0.1, 1000);
                    const u = tStr(p, 'unit');
                    return [
                        { type: 'shape', shape: 'rectangle', width: w, height: h,
                          sideLabels: [withUnit(w, u), withUnit(h, u), '', ''] },
                        { type: 'formula', expression: `A = ${fmtNum(w)} × ${fmtNum(h)} = ${fmtNum(w * h)}`,
                          note: `Perimeter = 2 × (${fmtNum(w)} + ${fmtNum(h)}) = ${fmtNum(2 * (w + h))}` },
                    ];
                },
            },
            'circle': {
                domains: ['math'],
                use: 'a circle, with circumference and area computed from the radius',
                params: 'r, unit',
                build: p => {
                    const r = tNum(p, 'r', 4, 0.1, 1000), u = tStr(p, 'unit');
                    return [
                        { type: 'shape', shape: 'circle', radiusLabel: `r = ${withUnit(r, u)}`, vertices: ['O'] },
                        { type: 'formula', expression: `C = 2πr = ${fmtNum(2 * Math.PI * r)}`,
                          note: `A = πr² = ${fmtNum(Math.PI * r * r)}` },
                    ];
                },
            },
            'polygon-angles': {
                domains: ['math'],
                use: 'a regular polygon, with its interior and exterior angles computed',
                params: 'n (3-12)',
                build: p => {
                    const n = Math.round(tNum(p, 'n', 5, 3, 12));
                    const interior = ((n - 2) * 180) / n;
                    return { type: 'shape', shape: 'polygon', n,
                             angles: Array(n).fill(`${fmtNum(interior, 1)}°`),
                             caption: `${n} sides · interior angles total ${(n - 2) * 180}° · each is ${fmtNum(interior, 1)}°` };
                },
            },
            'solve-linear': {
                domains: ['math'],
                use: 'solving ax + b = c step by step — the app does the algebra, line by line',
                params: 'a, b, c',
                build: p => {
                    const a = tNum(p, 'a', 2, -1000, 1000), b = tNum(p, 'b', 4, -1000, 1000), c = tNum(p, 'c', 10, -1000, 1000);
                    if (a === 0) return null;
                    // b === 0 skips the "subtract b" step below, so the problem
                    // line has to skip showing it too — "2x + 0 = 10" is not
                    // how anyone would actually write ax = c.
                    const sign = b < 0 ? '−' : '+';
                    const opening = b === 0 ? `${fmtNum(a)}x = ${fmtNum(c)}` : `${fmtNum(a)}x ${sign} ${fmtNum(Math.abs(b))} = ${fmtNum(c)}`;
                    const lines = [{ expr: opening, note: 'start' }];
                    if (b !== 0) lines.push({ expr: `${fmtNum(a)}x = ${fmtNum(c - b)}`,
                                              note: `${b < 0 ? 'add' : 'subtract'} ${fmtNum(Math.abs(b))}` });
                    lines.push({ expr: `x = ${fmtNum((c - b) / a, 3)}`, note: `divide by ${fmtNum(a)}` });
                    return { type: 'equation', lines };
                },
            },
            'quadratic': {
                domains: ['math'],
                use: 'a parabola y = ax² + bx + c, plotted, with roots, factoring and vertex computed',
                params: 'a, b, c',
                build: p => {
                    const a = tNum(p, 'a', 1, -100, 100), b = tNum(p, 'b', -2, -100, 100), c = tNum(p, 'c', -3, -100, 100);
                    if (a === 0) return null;
                    const vx = -b / (2 * a), disc = b * b - 4 * a * c;
                    const span = Math.max(4, Math.abs(vx) + 4);
                    // The factored form is the same fact as the roots, not a second
                    // one to get right: a(x − r1)(x − r2) is exactly ax² + bx + c
                    // once r1, r2 are the roots, so it costs nothing the app has not
                    // already computed — which is the whole point of putting it
                    // here instead of leaving the model to write its own factoring
                    // steps by hand, freeform, in an equation spec of its own.
                    const coeff = a === 1 ? '' : a === -1 ? '−' : fmtNum(a);
                    const term = r => r === 0 ? 'x' : `x ${r > 0 ? '−' : '+'} ${fmtNum(Math.abs(r), 3)}`;
                    let roots;
                    if (disc > 0) {
                        const r1 = (-b - Math.sqrt(disc)) / (2 * a), r2 = (-b + Math.sqrt(disc)) / (2 * a);
                        roots = `roots at x = ${fmtNum(r1, 2)} and x = ${fmtNum(r2, 2)} → ${coeff}(${term(r1)})(${term(r2)})`;
                    } else if (disc === 0) {
                        roots = `one root at x = ${fmtNum(vx, 2)} → ${coeff}(${term(vx)})²`;
                    } else {
                        roots = 'no real roots';
                    }
                    return [
                        { type: 'plot', xLabel: 'x', yLabel: 'y',
                          series: [{ label: `y = ${polynomial([[a, 'x²'], [b, 'x'], [c, '']])}`,
                                     points: samplePoints(vx - span / 2, vx + span / 2, 24, x => a * x * x + b * x + c) }] },
                        { type: 'formula', expression: `x = (−b ± √(b² − 4ac)) / 2a`,
                          note: `b² − 4ac = ${fmtNum(disc)} → ${roots}. Vertex at x = ${fmtNum(vx, 2)}.` },
                    ];
                },
            },
            'linear-function': {
                domains: ['math'],
                use: 'a straight line y = mx + b, plotted with its slope and intercept named',
                params: 'm, b',
                build: p => {
                    const m = tNum(p, 'm', 2, -1000, 1000), b = tNum(p, 'b', 1, -1000, 1000);
                    return [
                        { type: 'plot', xLabel: 'x', yLabel: 'y',
                          series: [{ label: `y = ${polynomial([[m, 'x'], [b, '']])}`,
                                     points: samplePoints(0, 10, 10, x => m * x + b) }] },
                        { type: 'slider', variable: 'x', label: 'x', min: 0, max: 10, step: 1, value: 3,
                          constants: { m, b }, outputs: [{ label: 'y', expr: 'm * x + b', decimals: 2 }] },
                    ];
                },
            },
            'fraction': {
                domains: ['math'],
                use: 'a fraction or share of a whole, drawn with the percentage computed',
                params: 'part, whole, label',
                build: p => {
                    const part = tNum(p, 'part', 1, 0, 1e9), whole = tNum(p, 'whole', 4, 0.0001, 1e9);
                    if (part > whole) return null;
                    const label = tStr(p, 'label', 'this part');
                    return { type: 'pie', unit: '',
                             slices: [{ label, value: part }, { label: 'the rest', value: Math.max(whole - part, 0.0001) }],
                             caption: `${fmtNum(part)}/${fmtNum(whole)} = ${fmtNum((part / whole) * 100, 1)}%` };
                },
            },

            // ---- Physics ----------------------------------------------------
            'ohms-law': {
                domains: ['physics'],
                use: 'Ohm\'s law as something to drag: change the voltage and watch current and power recompute',
                params: 'volts, ohms',
                build: p => {
                    const v = tNum(p, 'volts', 12, 0.1, 1e6), r = tNum(p, 'ohms', 4, 0.01, 1e6);
                    return [
                        { type: 'formula', expression: 'I = V / R',
                          where: [{ symbol: 'V', meaning: 'voltage (volts)' }, { symbol: 'R', meaning: 'resistance (ohms)' },
                                  { symbol: 'I', meaning: 'current (amps)' }] },
                        { type: 'slider', variable: 'V', label: 'Voltage (V)', min: 0, max: Math.max(v * 2, 1),
                          step: Math.max(v * 2, 1) / 20, value: v, unit: ' V', constants: { R: r },
                          outputs: [{ label: 'Current', expr: 'V / R', unit: ' A', decimals: 2 },
                                    { label: 'Power', expr: 'V * V / R', unit: ' W', decimals: 2 }] },
                    ];
                },
            },
            'resistors': {
                domains: ['physics'],
                use: 'resistors in series or in parallel, with the total computed',
                params: 'values (list of ohms), mode (series | parallel)',
                build: p => {
                    const values = tList(p, 'values', [100, 220, 330], 6);
                    const parallel = /parallel/i.test(tStr(p, 'mode', 'series'));
                    const total = parallel
                        ? 1 / values.reduce((t, r) => t + (r > 0 ? 1 / r : 0), 0)
                        : values.reduce((t, r) => t + r, 0);
                    if (!isFinite(total)) return null;
                    return [
                        { type: 'bar', unit: ' Ω', bars: values.map((r, i) => ({ label: `R${i + 1}`, value: r })) },
                        { type: 'formula',
                          expression: parallel
                            ? `1/R = ${values.map(r => `1/${fmtNum(r)}`).join(' + ')}`
                            : `R = ${values.map(r => fmtNum(r)).join(' + ')}`,
                          note: `Total: ${fmtNum(total, 2)} Ω — ${parallel ? 'less than the smallest one' : 'more than any one of them'}` },
                    ];
                },
            },
            'motion': {
                domains: ['physics'],
                use: 'motion under constant acceleration — speed against time, with the distance computed',
                params: 'v0 (start speed), a (acceleration), t (seconds)',
                build: p => {
                    const v0 = tNum(p, 'v0', 0, -1000, 1000), a = tNum(p, 'a', 2, -100, 100), t = tNum(p, 't', 10, 0.1, 1000);
                    return [
                        { type: 'plot', xLabel: 'time (s)', yLabel: 'speed (m/s)',
                          series: [{ label: 'v = v₀ + at', points: samplePoints(0, t, 10, x => v0 + a * x) }] },
                        { type: 'formula', expression: 's = v₀t + ½at²',
                          note: `After ${fmtNum(t)} s: speed ${fmtNum(v0 + a * t, 1)} m/s, distance ${fmtNum(v0 * t + 0.5 * a * t * t, 1)} m` },
                    ];
                },
            },
            'projectile': {
                domains: ['physics'],
                use: 'a projectile\'s arc, with range and greatest height computed',
                params: 'speed (m/s), angle (degrees)',
                build: p => {
                    const v = tNum(p, 'speed', 20, 0.1, 1000), deg = tNum(p, 'angle', 45, 1, 89);
                    const rad = (deg * Math.PI) / 180, g = 9.81;
                    const range = (v * v * Math.sin(2 * rad)) / g;
                    const peak = (v * v * Math.sin(rad) ** 2) / (2 * g);
                    return [
                        { type: 'plot', xLabel: 'distance (m)', yLabel: 'height (m)',
                          series: [{ label: `${fmtNum(v)} m/s at ${fmtNum(deg)}°`,
                                     points: samplePoints(0, range, 20, x => x * Math.tan(rad) - (g * x * x) / (2 * v * v * Math.cos(rad) ** 2)) }] },
                        { type: 'formula', expression: 'range = v² sin(2θ) / g',
                          note: `Range ${fmtNum(range, 1)} m, highest point ${fmtNum(peak, 1)} m` },
                    ];
                },
            },
            'wave': {
                domains: ['physics'],
                use: 'a wave drawn from its amplitude and wavelength, with frequency computed from the speed',
                params: 'amplitude, wavelength, speed',
                build: p => {
                    const amp = tNum(p, 'amplitude', 1, 0.01, 1000), len = tNum(p, 'wavelength', 4, 0.01, 1000);
                    const speed = tNum(p, 'speed', 340, 0.01, 3e8);
                    return [
                        { type: 'plot', xLabel: 'distance', yLabel: 'displacement',
                          series: [{ label: `λ = ${fmtNum(len)}`,
                                     points: samplePoints(0, len * 2, 48, x => amp * Math.sin((2 * Math.PI * x) / len)) }] },
                        { type: 'formula', expression: 'v = f λ',
                          note: `f = ${fmtNum(speed)} / ${fmtNum(len)} = ${fmtNum(speed / len, 2)} Hz` },
                    ];
                },
            },
            'pendulum': {
                domains: ['physics'],
                use: 'a pendulum whose period the learner changes by dragging its length',
                params: 'length (metres)',
                build: p => {
                    const l = tNum(p, 'length', 1, 0.05, 100);
                    return { type: 'slider', variable: 'L', label: 'Length (m)', min: 0.1, max: Math.max(l * 2, 2),
                             step: 0.1, value: l, unit: ' m', constants: { g: 9.81 },
                             outputs: [{ label: 'Period', expr: '2 * pi * sqrt(L / g)', unit: ' s', decimals: 2 },
                                       { label: 'Swings per minute', expr: '60 / (2 * pi * sqrt(L / g))', decimals: 1 }],
                             note: 'The period depends on length alone — not on the mass, and not on how far it swings.' };
                },
            },
            'half-life': {
                domains: ['physics', 'science'],
                use: 'radioactive or any exponential decay: how much is left after each half-life',
                params: 'halfLife, unit, periods',
                build: p => {
                    const hl = tNum(p, 'halfLife', 5, 0.001, 1e9);
                    const u = tStr(p, 'unit', 'years');
                    const periods = Math.round(tNum(p, 'periods', 5, 1, 10));
                    return [
                        { type: 'plot', xLabel: u, yLabel: '% left',
                          series: [{ label: 'remaining', points: samplePoints(0, hl * periods, 30, t => 100 * Math.pow(0.5, t / hl)) }] },
                        { type: 'table', headers: [`After (${u})`, 'Left'],
                          rows: Array.from({ length: periods + 1 }, (_, i) =>
                              [fmtNum(i * hl), `${fmtNum(100 * Math.pow(0.5, i), 2)}%`]) },
                    ];
                },
            },

            // ---- Life & Earth science ---------------------------------------
            // The one shelf every other domain quietly shares from: `science`
            // covers biology, chemistry, ecology and earth science, and until
            // now it had exactly one template (half-life, borrowed from
            // physics). A course built from a biology or chemistry chapter —
            // which is most of what a real upload actually is — got the
            // primitives (shape, table, reveal…) and nothing that computes for
            // it the way `quadratic` computes for algebra.
            'punnett-square': {
                domains: ['science'],
                use: 'a monohybrid genetic cross (Punnett square) — genotype and phenotype ratios worked out from the two parents\' own genotypes, not guessed',
                params: 'parent1, parent2 (each two letters of the same gene, e.g. "Aa"), dominant, recessive (what each allele shows)',
                build: p => {
                    const clean = g => String(g || '').replace(/[^A-Za-z]/g, '').slice(0, 2);
                    const p1 = clean(tStr(p, 'parent1', 'Aa'));
                    const p2 = clean(tStr(p, 'parent2', 'Aa'));
                    if (p1.length !== 2 || p2.length !== 2) return null;
                    const letter = p1[0].toLowerCase();
                    // A cross needs both parents carrying the same gene — mixing
                    // two different letters is not a monohybrid cross.
                    if ([...p1, ...p2].some(c => c.toLowerCase() !== letter)) return null;
                    const dominant = tStr(p, 'dominant', 'dominant trait');
                    const recessive = tStr(p, 'recessive', 'recessive trait');
                    // Dominant allele written first, so "aA" and "Aa" are one
                    // genotype rather than two different-looking ones.
                    const canon = (a, b) => [a, b].sort((x, y) =>
                        (x === x.toUpperCase() ? 0 : 1) - (y === y.toUpperCase() ? 0 : 1)).join('');
                    const cells = [], counts = new Map();
                    for (let r = 0; r < 2; r++) {
                        const row = [];
                        for (let c = 0; c < 2; c++) {
                            const g = canon(p2[r], p1[c]);
                            row.push(g);
                            counts.set(g, (counts.get(g) || 0) + 1);
                        }
                        cells.push(row);
                    }
                    const flat = cells.flat();
                    const domCount = flat.filter(g => /[A-Z]/.test(g)).length;
                    const recCount = flat.length - domCount;
                    const genotypeRatio = [...counts.entries()].map(([g, n]) => `${n} ${g}`).join(' : ');
                    return {
                        type: 'grid', colHeaders: [p1[0], p1[1]], rowHeaders: [p2[0], p2[1]], cells,
                        highlight: cells.flatMap((row, r) => row
                            .map((g, c) => (/[A-Z]/.test(g) ? null : [r, c])).filter(Boolean)),
                        caption: `Genotypes: ${genotypeRatio}. Phenotypes: ${domCount} ${dominant} : ${recCount} ${recessive}.`,
                    };
                },
            },
            'ph-scale': {
                domains: ['science'],
                use: 'pH computed from a hydrogen-ion concentration, and where it falls on the acid-base scale',
                params: 'concentration (mol/L of H+), label',
                build: p => {
                    const c = tNum(p, 'concentration', 1e-7, 1e-14, 1);
                    const label = tStr(p, 'label', '');
                    const ph = -Math.log10(c);
                    const cls = ph < 6.5 ? 'acidic' : ph > 7.5 ? 'basic' : 'neutral';
                    return {
                        type: 'numberline', min: 0, max: 14, step: 2,
                        points: [{ value: ph, label: `pH ${fmtNum(ph, 1)}` }],
                        caption: `${label ? label + ': ' : ''}[H+] = ${c.toExponential(1)} mol/L -> pH ${fmtNum(ph, 2)} (${cls})`,
                    };
                },
            },
            'population-growth': {
                domains: ['science'],
                use: 'exponential population growth from a starting size and a doubling time — the population plotted and computed at each interval',
                params: 'initial, doublingTime, unit, periods',
                build: p => {
                    const n0 = tNum(p, 'initial', 100, 0.0001, 1e12);
                    const dt = tNum(p, 'doublingTime', 1, 0.001, 1e6);
                    const u = tStr(p, 'unit', 'generations');
                    const periods = Math.round(tNum(p, 'periods', 5, 1, 10));
                    return [
                        { type: 'plot', xLabel: u, yLabel: 'population',
                          series: [{ label: 'population', points: samplePoints(0, dt * periods, 30, t => n0 * Math.pow(2, t / dt)) }] },
                        { type: 'table', headers: [`After (${u})`, 'Population'],
                          rows: Array.from({ length: periods + 1 }, (_, i) =>
                              [fmtNum(i * dt), fmtNum(n0 * Math.pow(2, i), 0)]) },
                    ];
                },
            },
            'energy-pyramid': {
                domains: ['science'],
                use: 'energy transfer up a food chain (the 10% rule) — how much of the energy at one trophic level reaches the next, computed at every level',
                params: 'levels (list, e.g. "producers,herbivores,carnivores"), startEnergy, unit, efficiencyPercent',
                build: p => {
                    const levels = tWords(p, 'levels',
                        ['producers', 'primary consumers', 'secondary consumers', 'tertiary consumers'], 6);
                    if (levels.length < 2) return null;
                    const start = tNum(p, 'startEnergy', 10000, 1, 1e12);
                    const unit = tStr(p, 'unit', 'kcal');
                    const eff = tNum(p, 'efficiencyPercent', 10, 0.1, 100) / 100;
                    const bars = levels.map((label, i) => ({ label, value: Math.round(start * Math.pow(eff, i)) }));
                    return {
                        type: 'bar', unit: ` ${unit}`, bars,
                        caption: `${fmtNum(eff * 100, 0)}% of each level's energy reaches the next. By ${levels.at(-1)}, `
                            + `only ${fmtNum(bars.at(-1).value)} ${unit} is left of the original ${fmtNum(start)} ${unit}.`,
                    };
                },
            },
            'density': {
                domains: ['science'],
                use: 'density (mass over volume) as something to drag — change the volume and watch density recompute',
                params: 'mass, volume, unit',
                build: p => {
                    const m = tNum(p, 'mass', 100, 0.01, 1e9), v = tNum(p, 'volume', 20, 0.01, 1e9);
                    const u = tStr(p, 'unit', 'g/cm\u00b3');
                    return [
                        { type: 'formula', expression: 'density = mass / volume',
                          where: [{ symbol: 'mass', meaning: 'grams' }, { symbol: 'volume', meaning: 'cm\u00b3' },
                                  { symbol: 'density', meaning: u }] },
                        { type: 'slider', variable: 'volume', label: 'Volume (cm\u00b3)',
                          min: Math.max(0.1, v / 4), max: v * 4, step: Math.max(0.1, v / 20), value: v,
                          unit: ' cm\u00b3', constants: { mass: m },
                          outputs: [{ label: 'Density', expr: 'mass / volume', unit: ` ${u}`, decimals: 2 }] },
                    ];
                },
            },

            // ---- Computing and logic ----------------------------------------
            'binary-number': {
                domains: ['cs'],
                use: 'a number in binary, with the place values laid out and the conversion computed',
                params: 'value (0-255)',
                build: p => {
                    const n = Math.round(tNum(p, 'value', 42, 0, 255));
                    const bits = n.toString(2).padStart(8, '0').split('');
                    const places = [128, 64, 32, 16, 8, 4, 2, 1];
                    return { type: 'grid', colHeaders: places.map(String),
                             rowHeaders: ['bit'], cells: [bits],
                             highlight: bits.map((b, i) => b === '1' ? [0, i] : null).filter(Boolean),
                             caption: `${n} = ${places.filter((_, i) => bits[i] === '1').join(' + ') || '0'} = ${bits.join('')}₂` };
                },
            },
            'binary-search': {
                domains: ['cs'],
                use: 'a binary search traced step by step over a sorted list — the app runs the search',
                params: 'values (sorted list), target',
                build: p => {
                    const values = tList(p, 'values', [2, 5, 8, 12, 16, 23, 38, 56, 72, 91]).sort((a, b) => a - b);
                    const target = tNum(p, 'target', values[Math.floor(values.length / 2)] ?? 0);
                    const lines = [];
                    let lo = 0, hi = values.length - 1;
                    while (lo <= hi && lines.length < 8) {
                        const mid = Math.floor((lo + hi) / 2);
                        const v = values[mid];
                        const verdict = v === target ? 'found it' : (v < target ? 'too small — look right' : 'too big — look left');
                        lines.push({ expr: `[${lo}…${hi}] middle = ${fmtNum(v)}`, note: verdict });
                        if (v === target) break;
                        if (v < target) lo = mid + 1; else hi = mid - 1;
                    }
                    if (lo > hi) lines.push({ expr: 'range is empty', note: `${fmtNum(target)} is not in the list` });
                    return [
                        { type: 'table', headers: values.map((_, i) => String(i)), rows: [values.map(String)] },
                        { type: 'equation', lines },
                    ];
                },
            },
            'big-o': {
                domains: ['cs'],
                use: 'two growth rates plotted against each other, so the difference is seen rather than asserted',
                params: 'a, b (each one of: 1, logn, n, nlogn, n2, 2n), maxN',
                build: p => {
                    const curves = {
                        '1': ['O(1)', () => 1], 'logn': ['O(log n)', n => Math.log2(Math.max(n, 1))],
                        'n': ['O(n)', n => n], 'nlogn': ['O(n log n)', n => n * Math.log2(Math.max(n, 2))],
                        'n2': ['O(n²)', n => n * n], '2n': ['O(2ⁿ)', n => Math.pow(2, Math.min(n, 20))],
                    };
                    const pick = key => curves[String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '')] || null;
                    const first = pick(tStr(p, 'a', 'n')) || curves.n;
                    const second = pick(tStr(p, 'b', 'n2')) || curves.n2;
                    const maxN = Math.round(tNum(p, 'maxN', 20, 4, 200));
                    return { type: 'plot', xLabel: 'input size n', yLabel: 'steps',
                             series: [first, second].map(([label, fn]) =>
                                 ({ label, points: samplePoints(1, maxN, 20, fn) })) };
                },
            },
            'truth-table': {
                domains: ['cs', 'logic'],
                use: 'a truth table computed by the app from a boolean expression. Write it with and / or / not / xor / then (implication) / iff, over single-letter variables',
                params: 'expression, variables (e.g. "A,B")',
                build: p => {
                    const vars = tWords(p, 'variables', ['A', 'B'], 3)
                        .map(v => v.replace(/[^A-Za-z_]/g, '').slice(0, 3)).filter(Boolean);
                    const expr = tStr(p, 'expression', 'A and B');
                    if (!vars.length) return null;
                    const rows = [];
                    for (let mask = 0; mask < (1 << vars.length); mask++) {
                        const env = {};
                        vars.forEach((v, i) => { env[v] = !!(mask & (1 << (vars.length - 1 - i))); });
                        let out;
                        try { out = evalBool(expr, env); } catch (_) { return null; }   // unparseable: no table
                        rows.push([...vars.map(v => (env[v] ? 'T' : 'F')), out ? 'T' : 'F']);
                    }
                    return { type: 'grid', colHeaders: [...vars, expr],
                             cells: rows,
                             highlight: rows.map((r, i) => r[r.length - 1] === 'T' ? [i, vars.length] : null).filter(Boolean),
                             caption: `${rows.filter(r => r[r.length - 1] === 'T').length} of ${rows.length} rows come out true` };
                },
            },
            'set-operations': {
                domains: ['logic', 'math'],
                use: 'two sets, with union, intersection and differences computed from the members',
                params: 'A (list), B (list), titleA, titleB',
                build: p => {
                    const A = tWords(p, 'A', ['2', '4', '6', '8']), B = tWords(p, 'B', ['3', '6', '9']);
                    const inBoth = A.filter(x => B.includes(x));
                    return { type: 'venn',
                             left: { title: tStr(p, 'titleA', 'A'), points: A.filter(x => !B.includes(x)) },
                             right: { title: tStr(p, 'titleB', 'B'), points: B.filter(x => !A.includes(x)) },
                             overlap: { title: 'in both', points: inBoth },
                             caption: `Union has ${new Set([...A, ...B]).size}; intersection has ${inBoth.length}` };
                },
            },

            // ---- Data and statistics ----------------------------------------
            'summary-stats': {
                // A dataset is a dataset whether it counts survey responses or
                // casualties in a battle — nothing here is data-specific.
                domains: ['data', 'other'],
                use: 'a set of numbers with mean, median, range and spread computed and drawn',
                params: 'values (list), label',
                build: p => {
                    const values = tList(p, 'values', [4, 8, 15, 16, 23, 42]);
                    const sorted = [...values].sort((a, b) => a - b);
                    const mean = values.reduce((t, v) => t + v, 0) / values.length;
                    const mid = Math.floor(sorted.length / 2);
                    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
                    const sd = Math.sqrt(values.reduce((t, v) => t + (v - mean) ** 2, 0) / values.length);
                    return [
                        { type: 'bar', bars: values.map((v, i) => ({ label: tStr(p, 'label', 'x') + (i + 1), value: v })) },
                        { type: 'numberline', min: sorted[0], max: sorted[sorted.length - 1],
                          points: [{ value: mean, label: `mean ${fmtNum(mean, 2)}` }, { value: median, label: `median ${fmtNum(median, 2)}` }] },
                        { type: 'formula', expression: `mean = ${fmtNum(mean, 2)}`,
                          note: `median ${fmtNum(median, 2)} · range ${fmtNum(sorted[sorted.length - 1] - sorted[0], 2)} · standard deviation ${fmtNum(sd, 2)}` },
                    ];
                },
            },
            'histogram': {
                domains: ['data'],
                use: 'raw numbers counted into bins by the app and drawn as a distribution',
                params: 'values (list), bins',
                build: p => {
                    const values = tList(p, 'values', [1, 2, 2, 3, 3, 3, 4, 4, 5], 60);
                    const bins = Math.round(tNum(p, 'bins', 5, 2, 10));
                    const lo = Math.min(...values), hi = Math.max(...values);
                    const width = (hi - lo) / bins || 1;
                    const counts = Array(bins).fill(0);
                    values.forEach(v => { counts[Math.min(bins - 1, Math.floor((v - lo) / width))]++; });
                    return { type: 'bar', unit: '',
                             bars: counts.map((n, i) => ({ label: `${fmtNum(lo + i * width, 1)}–${fmtNum(lo + (i + 1) * width, 1)}`, value: n })),
                             caption: `${values.length} values in ${bins} bins` };
                },
            },
            'normal-curve': {
                domains: ['data'],
                use: 'a bell curve from a mean and a standard deviation, with the 68/95 bands marked',
                params: 'mean, sd',
                build: p => {
                    const mean = tNum(p, 'mean', 100, -1e6, 1e6), sd = tNum(p, 'sd', 15, 0.001, 1e6);
                    return [
                        { type: 'plot', xLabel: 'value', yLabel: 'likelihood',
                          series: [{ label: `mean ${fmtNum(mean)}, sd ${fmtNum(sd)}`,
                                     points: samplePoints(mean - 3 * sd, mean + 3 * sd, 36,
                                        x => Math.exp(-((x - mean) ** 2) / (2 * sd * sd))) }] },
                        { type: 'numberline', min: mean - 3 * sd, max: mean + 3 * sd, step: sd,
                          ranges: [{ from: mean - sd, to: mean + sd, label: '68% of values' },
                                   { from: mean - 2 * sd, to: mean + 2 * sd, label: '95%' }],
                          points: [{ value: mean, label: 'mean' }] },
                    ];
                },
            },
            'dice-sums': {
                domains: ['data', 'math'],
                use: 'every outcome of two dice, counted — why some totals are commoner',
                params: 'faces (default 6)',
                build: p => {
                    const faces = Math.round(tNum(p, 'faces', 6, 2, 10));
                    const rows = Array.from({ length: faces }, (_, i) =>
                        Array.from({ length: faces }, (_, j) => String(i + j + 2)));
                    const counts = {};
                    rows.flat().forEach(s => { counts[s] = (counts[s] || 0) + 1; });
                    const total = faces * faces;
                    return [
                        { type: 'grid', rowHeaders: Array.from({ length: faces }, (_, i) => `⚀${i + 1}`),
                          colHeaders: Array.from({ length: faces }, (_, i) => `⚀${i + 1}`), cells: rows },
                        { type: 'bar', unit: `/${total}`,
                          bars: Object.entries(counts).sort((a, b) => Number(a[0]) - Number(b[0]))
                              .map(([sum, n]) => ({ label: sum, value: n })) },
                    ];
                },
            },

            // ---- Money -------------------------------------------------------
            'compound-interest': {
                domains: ['finance'],
                use: 'money growing at a rate, plotted year by year, with simple interest alongside it for contrast',
                params: 'principal, ratePercent, years',
                build: p => {
                    const principal = tNum(p, 'principal', 1000, 1, 1e9);
                    const rate = tNum(p, 'ratePercent', 5, -50, 200) / 100;
                    const years = Math.round(tNum(p, 'years', 10, 1, 60));
                    const final = principal * Math.pow(1 + rate, years);
                    return [
                        { type: 'plot', xLabel: 'years', yLabel: 'balance',
                          series: [
                            { label: 'compound', points: samplePoints(0, years, Math.min(years, 20), t => principal * Math.pow(1 + rate, t)) },
                            { label: 'simple', points: samplePoints(0, years, Math.min(years, 20), t => principal * (1 + rate * t)) },
                          ] },
                        { type: 'slider', variable: 'y', label: 'Years', min: 1, max: Math.max(years * 2, 5), step: 1, value: years,
                          constants: { P: principal, r: rate },
                          outputs: [{ label: 'Compound', expr: 'P * (1 + r) ^ y', decimals: 0 },
                                    { label: 'Simple', expr: 'P * (1 + r * y)', decimals: 0 }] },
                        { type: 'formula', expression: 'A = P(1 + r)ⁿ',
                          note: `${fmtNum(principal)} at ${fmtNum(rate * 100, 2)}% for ${years} years → ${fmtNum(final, 0)}` },
                    ];
                },
            },
            'loan-payment': {
                domains: ['finance'],
                use: 'what a loan actually costs: the monthly payment and the total interest, computed',
                params: 'principal, annualRatePercent, months',
                build: p => {
                    const principal = tNum(p, 'principal', 100000, 1, 1e9);
                    const monthly = tNum(p, 'annualRatePercent', 6, 0, 100) / 100 / 12;
                    const months = Math.round(tNum(p, 'months', 240, 1, 600));
                    const payment = monthly === 0 ? principal / months
                        : (principal * monthly) / (1 - Math.pow(1 + monthly, -months));
                    const paid = payment * months;
                    return [
                        { type: 'formula', expression: 'payment = P · i / (1 − (1 + i)⁻ⁿ)',
                          where: [{ symbol: 'i', meaning: 'monthly rate' }, { symbol: 'n', meaning: 'number of payments' }],
                          note: `${fmtNum(payment, 2)} a month for ${months} months` },
                        { type: 'pie', slices: [{ label: 'the loan', value: principal },
                                                { label: 'interest', value: Math.max(paid - principal, 0.01) }],
                          caption: `Paid in total: ${fmtNum(paid, 0)} — of which ${fmtNum(paid - principal, 0)} is interest` },
                    ];
                },
            },
            'percent-change': {
                // A population, a body count, a print run, a vote share: `other`
                // is full of numbers that changed between two points, and the
                // arithmetic that describes the change is not finance-specific.
                domains: ['finance', 'math', 'other'],
                use: 'the percentage change between two figures, computed both ways round',
                params: 'from, to, unit',
                build: p => {
                    const from = tNum(p, 'from', 200, -1e12, 1e12), to = tNum(p, 'to', 250, -1e12, 1e12);
                    if (from === 0) return null;
                    const change = ((to - from) / Math.abs(from)) * 100;
                    const back = to === 0 ? null : ((from - to) / Math.abs(to)) * 100;
                    const u = tStr(p, 'unit');
                    return [
                        { type: 'bar', unit: u ? ' ' + u : '',
                          bars: [{ label: 'before', value: from }, { label: 'after', value: to }] },
                        { type: 'formula', expression: `(${fmtNum(to)} − ${fmtNum(from)}) / ${fmtNum(Math.abs(from))} = ${fmtNum(change, 1)}%`,
                          note: back === null ? '' : `Going back the other way is ${fmtNum(back, 1)}% — the two are not the same number.` },
                    ];
                },
            },

            // ---- General purpose (`other`) -----------------------------------
            // `other` is history, law, literature, medicine, business — anything
            // with no shelf of its own, and by design it is offered no template
            // that assumes a subject. What it can be offered, without pretending
            // to know the subject, is arithmetic and ordering that any of them
            // might need: dates that have to come out in the true order
            // regardless of how the model listed them, and numbers that have to
            // be ranked and scaled correctly rather than approximated. Two new
            // ones here; `summary-stats` and `percent-change` above are widened
            // to reach `other` too, for the same reason — a body count and a
            // survey response are both just a list of numbers.
            'chronology': {
                domains: ['other'],
                use: 'events placed in their true chronological order regardless of the order given, with the span and the gaps between them computed — for a sequence of dated events in any subject',
                params: 'events (list of {label, year}), unit (e.g. "CE", "BCE", or blank)',
                build: p => {
                    // Generic placeholders, not a claimed fact — the same role
                    // `set-operations`' default lists or `compound-interest`'s
                    // default principal play: something to draw when nothing
                    // was supplied, not a real event dressed up as one.
                    const fallback = [{ label: 'Event A', year: 1900 }, { label: 'Event B', year: 1950 },
                                       { label: 'Event C', year: 2000 }];
                    const raw = (Array.isArray(p?.events) && p.events.length) ? p.events : fallback;
                    const events = raw.map(e => {
                        if (!e) return null;
                        // Model output is not to be trusted with shape either: a
                        // plain "label:year" string is accepted alongside the
                        // documented {label, year} object.
                        if (typeof e === 'string') {
                            const m = /^(.*?)[:|]\s*(-?\d+)\s*$/.exec(e);
                            return m ? { label: m[1].trim().slice(0, 60), year: Number(m[2]) } : null;
                        }
                        const year = Number(e.year);
                        return (e.label && isFinite(year)) ? { label: String(e.label).slice(0, 60), year } : null;
                    }).filter(Boolean).slice(0, 12);
                    if (events.length < 2) return null;
                    const sorted = [...events].sort((a, b) => a.year - b.year);
                    const unit = tStr(p, 'unit', '');
                    const gaps = sorted.slice(1).map((e, i) => e.year - sorted[i].year);
                    const span = sorted.at(-1).year - sorted[0].year;
                    const biggest = Math.max(...gaps), smallest = Math.min(...gaps);
                    const yr = n => `${n}${unit ? ' ' + unit : ''}`;
                    return {
                        type: 'timeline',
                        events: sorted.map(e => ({ label: yr(e.year), text: e.label })),
                        caption: `${sorted.length} events span ${fmtNum(span)} year${span === 1 ? '' : 's'} — `
                            + `closest two are ${fmtNum(smallest)} year${smallest === 1 ? '' : 's'} apart, `
                            + `furthest ${fmtNum(biggest)} year${biggest === 1 ? '' : 's'}.`,
                    };
                },
            },
            'ranked-comparison': {
                domains: ['other'],
                use: 'several things ranked by one number — sorted correctly and drawn to scale, for a set of figures in any subject (deaths in a battle, copies sold, a body of work by length)',
                params: 'items (list of {label, value}), unit',
                build: p => {
                    const fallback = [{ label: 'A', value: 40 }, { label: 'B', value: 75 }, { label: 'C', value: 25 }];
                    const raw = (Array.isArray(p?.items) && p.items.length) ? p.items : fallback;
                    const items = raw.map(it => {
                        if (!it) return null;
                        if (typeof it === 'string') {
                            const m = /^(.*?)[:|]\s*(-?[\d.]+)\s*$/.exec(it);
                            return m ? { label: m[1].trim().slice(0, 60), value: Number(m[2]) } : null;
                        }
                        const value = Number(it.value);
                        return (it.label && isFinite(value)) ? { label: String(it.label).slice(0, 60), value } : null;
                    }).filter(Boolean).slice(0, 10);
                    if (items.length < 2) return null;
                    const sorted = [...items].sort((a, b) => b.value - a.value);
                    const unit = tStr(p, 'unit', '');
                    const withUnitStr = n => `${fmtNum(n)}${unit ? ' ' + unit : ''}`;
                    return {
                        type: 'bar', unit: unit ? ` ${unit}` : '',
                        bars: sorted.map(it => ({ label: it.label, value: it.value })),
                        caption: `Ranked largest to smallest: ${sorted[0].label} (${withUnitStr(sorted[0].value)}) `
                            + `down to ${sorted.at(-1).label} (${withUnitStr(sorted.at(-1).value)}).`,
                    };
                },
            },
        };

        // Expand a template into the spec the renderer already knows how to
        // draw. The lesson stores the result, not the template call: a cached
        // lesson then survives a template being changed or withdrawn, which a
        // stored `{template: …}` would not.
        function expandTemplate(v) {
            const def = TEMPLATES[v.template];
            if (!def) return null;
            let built;
            try { built = def.build(v.params && typeof v.params === 'object' ? v.params : {}); }
            catch (err) { console.warn('Template failed:', v.template, err); return null; }
            if (!built) return null;

            const items = (Array.isArray(built) ? built : [built])
                .map(spec => (spec && VISUALS[spec.type] && VISUALS[spec.type].check(spec)) ? spec : null)
                .filter(Boolean);
            if (!items.length) return null;
            return items.length === 1 ? items[0] : { type: 'group', items };
        }

        // Only the shelf for this subject. Thirty candidates the model has to
        // rank is how you get a bar chart on a geometry lesson; eight that all
        // fit is how you get a triangle.
        function templateCatalogue(domain) {
            return Object.entries(TEMPLATES)
                .filter(([, def]) => def.domains.includes(domain))
                .map(([id, def]) => `  "${id}" — ${def.use}. params: ${def.params}`)
                .join('\n');
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
        // How many courses this tier may keep at once — the same figure PLAN_LIMITS
        // already uses for the monthly build quota, since the two were chosen to
        // match. Falls back to the largest tier's number rather than the smallest,
        // same as the budgets above.
        function maxCourses() {
            return (entitlement && PLAN_LIMITS[entitlement.planKey]?.courses) || MAX_COURSES;
        }
        // How many concepts this tier's course will hold. The server rewrites
        // the prompt to this number, so it is also what a half-built plan can
        // honestly be measured against while it streams in.
        function planLessonCount() {
            return (entitlement && PLAN_LIMITS[entitlement.planKey]?.lessonsPerCourse) || 10;
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

            const structure = getStructure();
            // The structure is part of what the digest is built from, so it is
            // part of what makes one cached block different from another.
            const key = `${activeCourseId || 'none'}:${budget}:${source.length}:${structure ? structure.sections.length : 0}`;
            if (courseContextCache.key !== key) {
                // The label is part of the cached block, so it has to be fixed
                // text — nothing per-lesson may appear here.
                const header = `[COURSE MATERIAL] A digest of the learner's whole document, the same for every lesson in this course. Lines in [SQUARE BRACKETS] are labels added by the app, not part of the document; [...] marks text left out. [OUTLINE] is the document's own structure with each part's share of it, and a label like [Chapter 2 › 2.1 Rates] says which part the passage under it came from. Use this for context — where a concept sits in the material, what came before it, what it connects to. The passage quoted in the lesson prompt below is the authority for facts.`;
                courseContextCache = { key, text: `${header}\n\n${buildSourceDigest(source, budget, structure)}` };
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

        // The text of the section a concept says it came from, or '' if the
        // document has no such section.
        //
        // The planner copies the heading out of the outline it was given, and the
        // outline is rebuilt here from the same stored text, so the two agree.
        // The match is forgiving about case and surrounding punctuation and about
        // nothing else: a near-miss that silently retrieved the wrong chapter
        // would be worse than searching the whole document, which is what an
        // outright miss falls back to.
        function sectionSource(concept, sourceText, structure = null) {
            const wanted = String(concept?.section || '').trim().toLowerCase();
            if (!wanted || wanted.length < 3) return '';

            const blocks = splitBlocks(sourceText);
            const sections = documentSections(blocks, structure);
            if (!sections.length) return '';

            const key = s => s.title.trim().toLowerCase().replace(/[\s:.\-–—]+$/, '');
            const target = wanted.replace(/[\s:.\-–—]+$/, '');
            const hit = sections.find(s => key(s) === target)
                || sections.find(s => key(s).startsWith(target) || target.startsWith(key(s)));
            if (!hit) return '';

            const text = blocks.slice(hit.block, hit.spanTo).join('\n\n');
            // A heading with almost nothing under it is not worth narrowing to.
            return text.length > 400 ? text : '';
        }

        // Return the passages most likely to be where this concept was taught.
        //
        // When the plan says which section a concept came from, that section is
        // searched first. Retrieval over the whole book has to distinguish the
        // chapter that teaches a term from the four that mention it in passing,
        // on TF-IDF alone; told the chapter, it does not have to guess. The
        // whole document is still the fallback, because a concept that spans the
        // book — and a heading the model paraphrased instead of copying — must
        // not come back empty.
        function retrieveExcerpt(concept, sourceText, structure = null) {
            if (!sourceText) return '';
            const scoped = sectionSource(concept, sourceText, structure);
            if (scoped) {
                const hit = retrieveFrom(concept, scoped);
                if (hit) return hit;
            }
            return retrieveFrom(concept, sourceText);
        }

        function retrieveFrom(concept, sourceText) {
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
            // A Markdown heading says so outright. Worth reading, because the
            // Markdown `tools/pdf_prep` writes can be uploaded on its own —
            // without the bundle, and so without an outline to be told.
            if (/^#{1,6}\s+\S/.test(s)) return true;
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

        // How deep a heading sits, from its own wording. 0 means "not a heading".
        //
        // From the wording and nothing else, on purpose. Font sizes would settle
        // this in one line, and the extractor does see them — but the outline has
        // to be rebuildable from the stored text alone. `source_text` is a string
        // in the database, and the digest built from it is a prompt-cache prefix:
        // if a reload produced a different outline, every course would pay full
        // price for its second lesson. Deriving structure from the text is what
        // makes the two runs identical.
        const HEADING_LEVELS = [
            [/^(?:part|book|volume)\b/iu, 1],
            // \b is defined in terms of ASCII word characters, so it never matches
            // at the edge of a Hebrew word — these need an explicit lookahead.
            [/^(?:שער|חלק)(?=[\s:.\-–—]|$)/u, 1],
            [/^(?:chapter|unit|appendix|lesson)\b/iu, 2],
            [/^(?:פרק|יחידה|נספח|שיעור)(?=[\s:.\-–—]|$)/u, 2],
            [/^(?:section)\b/iu, 3],
            [/^(?:סעיף)(?=[\s:.\-–—]|$)/u, 3],
        ];

        function headingLevel(block) {
            const s = block.trim();
            if (!looksLikeHeading(s)) return 0;
            const marked = /^(#{1,6})\s+\S/.exec(s);
            if (marked) return Math.min(4, marked[1].length);
            // "3.2 Photosynthesis" — one number deep is a chapter, two is a
            // section under it. Same depths the keywords below produce, so a
            // document that mixes the two styles still nests correctly.
            const numbered = /^(\d+(?:\.\d+)*)[.)]?\s+\p{L}/u.exec(s);
            if (numbered) return Math.min(4, 1 + numbered[1].split('.').length);
            for (const [pattern, level] of HEADING_LEVELS) if (pattern.test(s)) return level;
            return 2;   // a bare title line: a chapter until something says otherwise
        }

        // Where each heading of a known outline sits in the text.
        //
        // A document prepared by `tools/pdf_prep` arrives with its outline
        // already settled — read from font sizes, table grids and, for a scan,
        // from OCR — so there is nothing to guess. What is still needed is the
        // block each heading landed on, because the sampler works in blocks.
        //
        // The search only ever moves forwards, so a chapter title that also
        // appears in a cross-reference later cannot pull the outline out of
        // order. A heading that cannot be found is dropped: the text may have
        // been truncated, and a section pointing at the wrong blocks is worse
        // than one fewer section.
        function locateSections(blocks, structure) {
            const key = text => String(text || '')
                .replace(/^#+\s*/, '')          // the Markdown heading marker
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
            const keys = blocks.map(key);

            const heads = [];
            let from = 0;
            for (const section of structure.sections || []) {
                const wanted = key(section.title);
                if (!wanted) continue;
                const at = keys.indexOf(wanted, from);
                if (at < 0) continue;
                heads.push({
                    index: at,
                    level: Math.max(1, Number(section.level) || 1),
                    title: blocks[at].replace(/^#+\s*/, '').trim(),
                    pageStart: section.pageStart || 0,
                    pageEnd: section.pageEnd || 0,
                });
                from = at + 1;
            }
            return heads;
        }

        // The document's own structure: every heading, what it covers, and how
        // much of the document that is.
        //
        // Returns [] when there is no structure to find, which is the honest
        // answer for pasted text and for a paper that is one wall of prose. It
        // also returns [] when nearly every block looks like a heading, because
        // that means the title-case rule is firing on body text and a wrong
        // outline is worse than none.
        function documentSections(blocks, structure = null) {
            let heads = [];
            if (structure && Array.isArray(structure.sections)) {
                heads = locateSections(blocks, structure);
            }
            if (heads.length < 2) {
                heads = [];
                blocks.forEach((block, index) => {
                    const level = headingLevel(block);
                    if (level) heads.push({ index, level, title: block.trim().replace(/^#+\s*/, '') });
                });
                if (heads.length > Math.max(6, blocks.length * 0.4)) return [];
            }
            if (heads.length < 2) return [];

            // Compress the levels actually used into 1..n. A document whose only
            // headings are "2.4"-style should not start its outline at depth 3.
            const used = [...new Set(heads.map(h => h.level))].sort((a, b) => a - b);
            const rank = new Map(used.map((level, i) => [level, i + 1]));

            const charsBetween = (from, to) =>
                blocks.slice(from, to).reduce((sum, b) => sum + b.length, 0);

            const sections = heads.map((head, k) => {
                // A section's *text* stops at the next heading of any level: the
                // sub-section's prose belongs to the sub-section, not to both.
                const bodyTo = heads[k + 1] ? heads[k + 1].index : blocks.length;
                // Its *span* runs to the next heading of its own level or higher,
                // so a chapter still owns everything under it. That is the number
                // the outline quotes as a share of the document.
                const closing = heads.slice(k + 1).find(other => other.level <= head.level);
                const spanTo = closing ? closing.index : blocks.length;
                return {
                    title: head.title,
                    level: rank.get(head.level),
                    block: head.index,
                    bodyFrom: head.index + 1,
                    bodyTo,
                    spanTo,
                    chars: charsBetween(head.index + 1, bodyTo),
                    totalChars: charsBetween(head.index + 1, spanTo),
                    // Real page numbers, when the document came prepared. The
                    // text alone cannot supply these: a page break leaves no
                    // mark in a paragraph.
                    pageStart: head.pageStart || 0,
                    pageEnd: head.pageEnd || 0,
                    path: [],
                };
            });

            const stack = [];
            for (const section of sections) {
                while (stack.length && stack[stack.length - 1].level >= section.level) stack.pop();
                section.path = [...stack.map(s => s.title), section.title];
                stack.push(section);
            }
            return sections;
        }

        // The outline as the planner sees it: indented by level, each part
        // carrying its share of the document.
        //
        // When it does not fit, whole levels are dropped before anything is
        // truncated. Cutting the list short would drop the last chapters, which
        // is the one bias this entire function exists to remove.
        // Returns { text, complete }: complete means every top-level part is
        // named, which is what the caller pays extra for when it can.
        function renderOutline(sections, totalChars, budget) {
            const share = s => {
                const percent = Math.round(100 * s.totalChars / Math.max(totalChars, 1));
                const pages = s.pageStart
                    ? (s.pageEnd > s.pageStart ? `pp. ${s.pageStart}-${s.pageEnd}` : `p. ${s.pageStart}`)
                    : '';
                const notes = [percent >= 1 ? `${percent}%` : '', pages].filter(Boolean);
                return notes.length ? `  (${notes.join(', ')})` : '';
            };
            const render = (list, withShares) => list
                .map(s => '  '.repeat(s.level - 1) + '- ' + s.title + (withShares ? share(s) : ''))
                .join('\n');

            // Depth goes first, then the shares. Both are worth having, but a
            // part the planner is never told about is a part it cannot teach,
            // and that outranks knowing how long the other parts are.
            for (const withShares of [true, false]) {
                for (let depth = 3; depth >= 1; depth--) {
                    const text = render(sections.filter(s => s.level <= depth), withShares);
                    if (text && text.length <= budget) return { text, complete: true };
                }
            }

            // Even the top level alone is too long — a book of 200 chapters. Thin
            // it evenly so the first and the last both survive, and say so.
            const tops = sections.filter(s => s.level === 1);
            if (!tops.length) return { text: '', complete: false };
            for (let step = 2; step <= tops.length; step++) {
                const kept = tops.filter((_, i) => i % step === 0 || i === tops.length - 1);
                const text = render(kept, false) + `\n- [… ${tops.length - kept.length} more parts]`;
                if (text.length <= budget) return { text, complete: false };
            }
            return { text: render([tops[0], tops[tops.length - 1]], false), complete: false };
        }

        // Score every block by how much distinctive vocabulary it carries.
        // Boilerplate — copyright lines, running examples, navigation — reuses
        // words that appear everywhere, so it scores near zero; the passage that
        // introduces a term is where that rare term is densest.
        function blockDensity(blocks) {
            const docFreq = new Map();
            const tokenised = blocks.map(b => {
                const toks = tokenize(b);
                new Set(toks).forEach(t => docFreq.set(t, (docFreq.get(t) || 0) + 1));
                return toks;
            });
            const n = blocks.length;
            return blocks.map((b, i) => {
                const toks = tokenised[i];
                if (toks.length < 12) return 0;      // captions, page furniture, stubs
                let score = 0;
                new Set(toks).forEach(t => { score += Math.log(1 + n / (docFreq.get(t) || 1)); });
                // Divide by sqrt(length) so a long mediocre block cannot outrank a
                // short dense one purely by being long.
                return score / Math.sqrt(toks.length);
            });
        }

        // Spend the body budget section by section, in proportion to how much of
        // the document each section is.
        //
        // This is the part the outline buys. Sampling by position alone gives a
        // two-page preface the same room as a sixty-page chapter, because it can
        // only count paragraphs; sampling by section spends the budget the way
        // the author spent the pages. The floor matters as much as the
        // proportion: a short chapter still gets one passage, so a plan built
        // from this cannot silently omit it.
        function sampleBySection(blocks, density, sections, budget, taken) {
            if (budget <= 0) return [];
            const tops = sections.filter(s => s.level === 1);
            if (!tops.length) return [];

            const headings = new Set(sections.map(s => s.block));
            const total = tops.reduce((sum, s) => sum + s.totalChars, 0) || 1;
            const lengths = blocks.map(b => b.length).sort((a, b) => a - b);
            const typical = Math.max(200, lengths[Math.floor(lengths.length / 2)] || 400);

            const picked = [];
            const used = new Map(tops.map(s => [s, 0]));
            let spent = 0;

            // The densest untaken blocks of one section. Ties break by position,
            // so the digest is byte-identical every time it is rebuilt.
            const candidatesIn = section => {
                const out = [];
                for (let i = section.block + 1; i < section.spanTo; i++) {
                    if (taken.has(i) || headings.has(i) || !density[i]) continue;
                    out.push(i);
                }
                out.sort((a, b) => (density[b] - density[a]) || (a - b));
                return out;
            };

            const take = (section, i, limit) => {
                if (spent + blocks[i].length > limit) return false;
                taken.add(i);
                picked.push(i);
                spent += blocks[i].length;
                used.set(section, used.get(section) + blocks[i].length);
                return true;
            };

            // Pass one — coverage. Every part takes one passage before any part
            // takes a second. Without this the proportional pass alone spends
            // the whole budget on the long chapter it visits first, and the
            // short chapters at the end of the book get nothing: the same bias
            // as reading the first 5,000 characters, arrived at by a longer
            // route.
            //
            // The ceiling is generous because it costs nothing when it is not
            // needed — a pass that takes one passage per part stops when the
            // parts run out, and what it leaves goes to pass two.
            const coverage = Math.floor(budget * 0.7);
            const affordable = Math.max(1, Math.floor(coverage / typical));
            let order = tops;
            if (tops.length > affordable) {
                // More parts than the budget can pay for. Keep as many as it can
                // afford, spaced evenly, so the sample still spans the document
                // end to end rather than stopping where the money ran out.
                order = affordable === 1
                    ? [tops[0]]
                    : Array.from({ length: affordable }, (_, i) =>
                        tops[Math.round(i * (tops.length - 1) / (affordable - 1))]);
                order = order.filter((section, i) => order.indexOf(section) === i);
            }
            for (const section of order) {
                const best = candidatesIn(section)[0];
                if (best !== undefined) take(section, best, coverage);
            }

            // Pass two — depth, in proportion to how much of the document each
            // part is, one passage per part per round so the shares stay honest
            // however the rounding falls.
            const quota = new Map(tops.map(s => [s, Math.floor(budget * (s.totalChars / total))]));
            for (let round = 0; round < 40; round++) {
                let acceptedAny = false;
                for (const section of tops) {
                    const next = candidatesIn(section)[0];
                    if (next === undefined) continue;
                    if (used.get(section) + blocks[next].length > quota.get(section)) continue;
                    if (take(section, next, budget)) acceptedAny = true;
                }
                if (!acceptedAny) break;
            }

            // Pass three — whatever the quotas left unspent goes to what is left.
            // A part still unrepresented comes first, however dense the
            // alternatives: the leftovers are the last chance to cover it, and
            // one passage from an unseen chapter is worth more to a plan than a
            // fourth passage from a chapter already quoted three times.
            const home = new Map();
            for (const section of tops) {
                for (let i = section.block + 1; i < section.spanTo; i++) home.set(i, section);
            }
            const rest = blocks
                .map((_, i) => i)
                .filter(i => !taken.has(i) && !headings.has(i) && density[i])
                .sort((a, b) => {
                    const emptyA = used.get(home.get(a)) ? 1 : 0;
                    const emptyB = used.get(home.get(b)) ? 1 : 0;
                    return (emptyA - emptyB) || (density[b] - density[a]) || (a - b);
                });
            for (const i of rest) {
                if (spent + blocks[i].length > budget) continue;
                const section = home.get(i);
                if (section) take(section, i, budget);
                else { taken.add(i); picked.push(i); spent += blocks[i].length; }
            }

            return picked.sort((a, b) => a - b);
        }

        // The fallback, for a document with no headings to go by: walk it in
        // equal segments and take the densest block from each.
        function sampleBySegment(blocks, density, budget, taken) {
            if (budget <= 0) return [];

            // How many places in the document we can afford to sample. Sizing this
            // from the document's own paragraph length matters: a fixed guess
            // either asks for more sample points than the budget can pay for, or —
            // the worse failure — takes one short paragraph per segment and leaves
            // most of the budget unspent while whole chapters go unrepresented.
            const lengths = blocks.map(b => b.length).sort((a, b) => a - b);
            const typical = Math.max(200, lengths[Math.floor(lengths.length / 2)] || 400);
            const SEGMENTS = Math.max(4, Math.min(60, Math.floor(budget / typical)));
            const size = Math.max(1, blocks.length / SEGMENTS);

            const picked = [];
            let spent = 0;

            // Each pass nominates the best unused block from every segment, then
            // accepts nominations best-first until the budget runs out.
            //
            // Nominating first and spending afterwards is the whole point. If
            // segments simply spent as they were visited, the budget would be
            // exhausted somewhere in the middle of the document and every segment
            // after that would get nothing — reproducing, one level down, the very
            // bias this function exists to remove. Choosing across all segments at
            // once means what gets dropped is the weakest passage, not the last one.
            for (let pass = 0; pass < 3 && spent < budget; pass++) {
                const nominees = [];
                for (let s = 0; s < SEGMENTS; s++) {
                    const from = Math.floor(s * size);
                    const to = (s === SEGMENTS - 1) ? blocks.length : Math.floor((s + 1) * size);
                    let bestIdx = -1;
                    let bestScore = 0;
                    for (let i = from; i < to; i++) {
                        if (taken.has(i)) continue;
                        if (blocks[i].length > budget) continue;
                        if (density[i] > bestScore) { bestScore = density[i]; bestIdx = i; }
                    }
                    if (bestIdx >= 0) nominees.push({ i: bestIdx, score: bestScore });
                }
                if (!nominees.length) break;

                nominees.sort((a, b) => (b.score - a.score) || (a.i - b.i));
                let acceptedAny = false;
                for (const nominee of nominees) {
                    if (spent + blocks[nominee.i].length > budget) continue;
                    taken.add(nominee.i);
                    picked.push(nominee.i);
                    spent += blocks[nominee.i].length;
                    acceptedAny = true;
                }
                if (!acceptedAny) break;
            }

            return picked.sort((a, b) => a - b);
        }

        // A flat list of headings, for a document with too little structure to
        // build an outline from but enough to be worth listing.
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
        //
        // Two shapes, decided by whether the document has an outline to be read
        // from. With one, the digest is the document's structure plus a sample
        // from every part of it, each passage labelled with the part it came
        // from — so the planner is choosing concepts against the shape of the
        // whole book rather than against whatever paragraphs scored well. Without
        // one, it falls back to sampling by position, which is all a wall of
        // prose supports.
        //
        // Deterministic, and it has to stay that way: this text is the prefix of
        // every call about this document, and the API's cache is a prefix match.
        // One character that differs between two runs turns a 10%-price read into
        // a full-price write.
        function buildSourceDigest(text, budget, structure = null) {
            const source = String(text || '');
            if (source.length <= budget) return source;

            const blocks = splitBlocks(source);
            if (blocks.length <= 1) return source.slice(0, budget);

            // Reserve: the outline gets a fifth, the opening an eighth (title,
            // abstract and introduction genuinely do say what a document is
            // about), and the closing a tenth (conclusions and summaries are
            // dense with concepts). The rest is spread across the body.
            const outlineBudget = Math.floor(budget * 0.22);
            const openingBudget = Math.floor(budget * 0.12);
            const closingBudget = Math.floor(budget * 0.10);

            const density = blockDensity(blocks);
            const sections = documentSections(blocks, structure);
            const totalChars = blocks.reduce((sum, b) => sum + b.length, 0);

            let outline = '';
            if (sections.length) {
                const usual = renderOutline(sections, totalChars, outlineBudget);
                outline = usual.text;
                if (!usual.complete) {
                    // Naming every part costs more than the outline's usual share
                    // here — a book of eighty chapters. Buy it anyway if it fits
                    // in a third of the budget: a chapter the planner has never
                    // heard of cannot be taught, and a list of names is the
                    // cheapest possible way to hear of one. The passages that
                    // pays for are the ones it could only have sampled thinly.
                    const generous = renderOutline(sections, totalChars, Math.floor(budget * 0.5));
                    if (generous.complete) outline = generous.text;
                }
            } else {
                outline = extractOutline(blocks, outlineBudget).join('\n');
            }

            const opening = takeBlocks(blocks, 0, openingBudget);
            const closing = takeBlocks(blocks, blocks.length - 1, closingBudget, -1);

            // The innermost section a block sits in, so a passage can say where
            // it came from. A passage the planner cannot place is a passage it
            // cannot plan a chapter's worth of lessons around.
            const sectionOf = index => {
                let found = null;
                for (const section of sections) {
                    if (index >= section.bodyFrom && index < section.bodyTo) found = section;
                }
                return found;
            };

            const renderBody = indices => {
                let passage = '';
                let label = '';
                indices.forEach((idx, k) => {
                    if (k > 0) passage += (idx === indices[k - 1] + 1) ? '\n\n' : '\n\n[...]\n\n';
                    const section = sectionOf(idx);
                    const here = section ? section.path.join(' \u203a ') : '';
                    if (here && here !== label) {
                        passage += `[${here}]\n`;
                        label = here;
                    }
                    passage += blocks[idx];
                });
                return passage;
            };

            const assemble = passage => {
                const parts = [];
                if (outline) {
                    parts.push(sections.length
                        ? '[OUTLINE \u2014 the document\'s own structure, and each part\'s share of it]\n' + outline
                        : '[OUTLINE]\n' + outline);
                }
                if (opening.text) parts.push('[OPENING]\n' + opening.text);
                if (passage) {
                    parts.push(sections.length
                        ? '[BODY \u2014 passages from each part of the document, under the part they came from]\n' + passage
                        : '[BODY \u2014 passages sampled across the whole document]\n' + passage);
                }
                if (closing.text) parts.push('[CLOSING]\n' + closing.text);
                return parts.join('\n\n');
            };

            // Sample, assemble, and if the labels pushed it over, sample again
            // knowing what they really cost.
            //
            // Measuring beats estimating here because of what overshooting does:
            // the final slice is a hard cap, and what it cuts is the end of the
            // string — which is the end of the document. A digest that runs 5%
            // long does not lose 5% of its quality, it loses its last chapters.
            let bodyBudget = budget - outline.length - opening.chars - closing.chars - 200;
            let digest = '';
            for (let attempt = 0; attempt < 3; attempt++) {
                const taken = new Set([...opening.indices, ...closing.indices]);
                const body = sections.length
                    ? sampleBySection(blocks, density, sections, bodyBudget, taken)
                    : sampleBySegment(blocks, density, bodyBudget, taken);
                digest = assemble(renderBody(body));
                if (digest.length <= budget) break;
                bodyBudget -= (digest.length - budget) + 40;
            }

            return digest.slice(0, budget);
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

        function getStructure() {
            return activeStructure;
        }

        // ============= Course library =============
        // Every read is scoped to the caller by RLS — there is no explicit
        // "where user_id = me" needed, the database enforces it either way.
        async function loadLibrary() {
            // Neither query is filtered by the other's result — the second one
            // reads every completed lesson the user has, across every course, not
            // just the ones the first query happens to return — so there is
            // nothing forcing them to run one after the other.
            const [{ data: courses, error }, { data: doneRows }] = await Promise.all([
                supabaseClient
                    .from('courses')
                    .select('id, title, language, concepts, created_at')
                    .order('created_at', { ascending: false }),
                supabaseClient
                    .from('progress')
                    .select('course_id')
                    .eq('completed', true),
            ]);
            if (error) {
                console.error('loadLibrary failed:', error);
                library = [];
                return library;
            }

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

        async function saveCourse(course, sourceText, structure = null) {
            const row = {
                user_id: currentUser.id,
                title: cleanTitle(course.courseName) || 'Untitled course',
                language: course.language || 'English',
                concepts: course.concepts,
                source_text: sourceText || null,
                structure: structure || null,
            };

            let { data, error } = await supabaseClient
                .from('courses').insert(row).select('id').single();

            // `structure` is a newer column than the rest of this table. A
            // project that has not run the migration yet should still be able
            // to build a course — losing the outline, which the app can derive
            // from the text again, rather than losing the course.
            if (error && /structure/i.test(error.message || '')) {
                console.warn('courses.structure is missing — saving without it. '
                    + 'Run supabase/migrations to keep document outlines.');
                delete row.structure;
                ({ data, error } = await supabaseClient
                    .from('courses').insert(row).select('id').single());
            }

            if (error) {
                console.error('saveCourse failed:', error);
                showError('Could not save that course: ' + error.message);
                return null;
            }
            // The caller is on its way to the learning path, not the library
            // screen — refreshing it is unrelated to showing the course that
            // was just built. Same fire-and-forget shape as `saveProgress`:
            // nothing here waits on it, it just needs to eventually land.
            loadLibrary();
            return data.id;
        }

        // Renaming touches three places that each hold their own copy of the title:
        // the row in Supabase, the library list, and the open course in memory. The
        // local two change before the network call, not after — a rename is one row
        // write that almost never fails, and a title that only updates once the
        // request returns reads as the edit not having taken.
        async function renameCourse(id, rawTitle) {
            const title = cleanTitle(rawTitle);
            if (!title) {
                showError('A course name needs at least one letter or number.');
                return false;
            }
            const meta = library.find(c => c.id === id);
            const previousTitle = meta?.title;
            const isActive = activeCourseId === id && courseData;
            const previousActiveTitle = isActive ? courseData.courseName : null;
            const titleEl = document.getElementById('courseTitle');

            if (meta) meta.title = title;
            if (isActive) {
                courseData.courseName = title;
                if (titleEl) titleEl.textContent = title;
            }
            renderLibrary();

            const { error } = await supabaseClient.from('courses').update({ title }).eq('id', id);
            if (error) {
                console.error('renameCourse failed:', error);
                if (meta) meta.title = previousTitle;
                if (isActive) {
                    courseData.courseName = previousActiveTitle;
                    if (titleEl) titleEl.textContent = previousActiveTitle;
                }
                renderLibrary();
                showError('Could not rename that course: ' + error.message);
                return false;
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

        // Gone from the library the instant the confirm dialog closes, not after
        // a network round trip: a card that lingers past its own confirmation
        // reads as the tap having missed. The row comes back — and the active
        // course, if it was the one removed — if the delete didn't actually take.
        async function deleteCourse(id) {
            const removed = library.find(c => c.id === id);
            const removedAt = library.indexOf(removed);
            const wasActive = activeCourseId === id;
            const savedActive = wasActive
                ? { courseData, progress, activeSourceText, activeStructure } : null;

            library = library.filter(c => c.id !== id);
            if (wasActive) {
                activeCourseId = null;
                courseData = null;
                progress = {};
                activeSourceText = '';
                activeStructure = null;
                localStorage.removeItem(ACTIVE_STORAGE);
            }
            renderLibrary();

            const { error } = await supabaseClient.from('courses').delete().eq('id', id);
            if (error) {
                console.error('deleteCourse failed:', error);
                if (removed) library.splice(removedAt, 0, removed);
                if (wasActive) {
                    activeCourseId = id;
                    ({ courseData, progress, activeSourceText, activeStructure } = savedActive);
                    localStorage.setItem(ACTIVE_STORAGE, id);
                }
                renderLibrary();
                showError('Could not delete that course.');
                return false;
            }
            return true;
        }

        async function openCourse(id) {
            showCoursePathSkeleton();

            // Both queries only need `id`, which is already known — neither
            // depends on what the other returns. Firing them together instead of
            // one after the other is a free win: opening a course now costs one
            // network round trip instead of two.
            const [{ data: courseRow, error }, { data: progRows }] = await Promise.all([
                supabaseClient.from('courses').select('*').eq('id', id).maybeSingle(),
                supabaseClient.from('progress').select('*').eq('course_id', id),
            ]);
            if (error || !courseRow) {
                showError('That course could not be found.');
                // Otherwise the skeleton is left on screen behind the alert with
                // nothing that will ever replace it.
                await showLibrary();
                return false;
            }

            courseData = {
                courseName: courseRow.title,
                language: courseRow.language,
                concepts: courseRow.concepts,
            };
            activeSourceText = courseRow.source_text || '';
            activeStructure = courseRow.structure || null;

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
            // Anything still being written for the course we just left belongs
            // to that course's concepts and that course's `progress`. It
            // checks the course id before it stores itself, so an in-flight one
            // will discard itself; forgetting it here is what stops the index
            // being reused for a different concept in the meantime.
            prefetching.clear();

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

        // Shaped like renderLibrary()'s real cards — same class names, so the grid
        // does not jump size when the real ones replace them — but with nothing
        // inside to read yet. Shown only on a true first load; a revisit paints
        // whatever is already in memory immediately and refreshes underneath it,
        // same as showReview() already does.
        function renderLibrarySkeleton(count = 3) {
            const grid = document.getElementById('libraryGrid');
            const empty = document.getElementById('libraryEmpty');
            if (!grid) return;
            empty.hidden = true;
            grid.innerHTML = Array.from({ length: count }, () => `
                <div class="course-card skel-card" aria-hidden="true">
                    <div class="course-card-head">
                        <div class="skel" style="flex:1;max-width:65%;height:1.15em;border-radius:6px"></div>
                        <div class="course-card-actions">
                            <span class="skel" style="width:var(--tap);height:var(--tap);border-radius:var(--r-full)"></span>
                            <span class="skel" style="width:var(--tap);height:var(--tap);border-radius:var(--r-full)"></span>
                        </div>
                    </div>
                    <div class="skel" style="height:0.85em;width:40%;margin-bottom:var(--sp-4);border-radius:6px"></div>
                    <div class="course-progress-row">
                        <div class="course-bar skel"></div>
                        <span class="skel" style="display:inline-block;width:2.2em;height:0.85em;border-radius:6px"></span>
                    </div>
                </div>`).join('');
        }

        function renderLibrary() {
            const grid = document.getElementById('libraryGrid');
            const empty = document.getElementById('libraryEmpty');
            const count = document.getElementById('libraryCount');

            // How many courses you may keep at once — a library capacity, not a
            // meter of what you've spent. Whether this month's build allowance is
            // gone is a separate question, answered only where it's actually
            // decision-relevant: the moment you try to start a new one.
            count.textContent = `${library.length} of ${maxCourses()} kept`;
            empty.hidden = library.length > 0;
            // The empty state carries its own primary action; two "New course"
            // buttons on one screen is one too many.
            const newBtn = document.getElementById('newCourseBtn');
            if (newBtn) newBtn.hidden = library.length === 0;
            grid.innerHTML = library.map(c => {
                const pct = courseProgressPct(c.id);
                const rtl = RTL_LANGUAGES.includes(c.language);
                const done = c.completedCount || 0;
                return `
                <div class="course-card" data-id="${escAttr(c.id)}" role="button" tabindex="0"
                     aria-label="Open ${escAttr(c.title)} — ${pct}% complete">
                    <div class="course-card-head">
                        <div class="course-title" ${rtl ? 'dir="rtl"' : ''}>${esc(c.title)}</div>
                        <div class="course-card-actions">
                            <button type="button" class="course-rename" data-rename="${escAttr(c.id)}"
                                    aria-label="Rename ${escAttr(c.title)}" title="Rename">${ICONS.pencil}</button>
                            <button type="button" class="course-delete" data-del="${escAttr(c.id)}"
                                    aria-label="Delete ${escAttr(c.title)}" title="Delete">${ICONS.trash}</button>
                        </div>
                    </div>
                    <div class="course-meta">${done} of ${c.conceptCount} lessons · ${esc(c.language)}</div>
                    <div class="course-progress-row">
                        <div class="course-bar"><div class="course-bar-fill" style="width:${pct}%"></div></div>
                        <span class="course-pct">${pct}%</span>
                    </div>
                </div>`;
            }).join('');

            grid.querySelectorAll('.course-card').forEach(card => {
                const open = async (e) => {
                    // closest(), not e.target.dataset — a tap usually lands on the
                    // icon's <svg>/<path>, not on the button carrying the data attribute.
                    if (e.target.closest('[data-del], [data-rename]')) return;
                    await openCourse(card.dataset.id);
                };
                card.onclick = open;
                // A card holds its own buttons, so it can't be a <button> itself
                // without nesting them. role=button plus the two keys a button
                // answers to is the accessible equivalent.
                card.onkeydown = (e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    if (e.target !== card) return;
                    e.preventDefault();
                    open(e);
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
                    // deleteCourse removes the card and re-renders before its network
                    // call even starts, and puts it back with an error dialog if the
                    // delete didn't take — nothing left to do here but the toast.
                    if (ok && await deleteCourse(btn.dataset.del)) toast(`Deleted "${name}"`);
                };
            });
        }

        async function showLibrary() {
            if (!currentUser) {
                pendingAction = { type: 'showLibrary' };
                showAuthModal('signin');
                return;
            }
            // The screen switches immediately — tapping "Courses" used to wait on
            // a network round trip before anything on screen even changed, which
            // reads as a missed tap on a slow connection. What fills it while the
            // real list loads is whatever is already in memory, or a skeleton on
            // the very first visit of the session, when there is nothing yet.
            setScreen('courses');
            if (library.length) renderLibrary();
            else renderLibrarySkeleton();
            await loadLibrary();
            renderLibrary();
        }

        async function showNewCourse() {
            if (library.length >= maxCourses()) {
                showError(`You can keep ${maxCourses()} courses at a time. Delete one to add another.`);
                return;
            }
            // The server is the authority on quota and this copy of the count can
            // be a few minutes stale, so this warns rather than blocks — but it
            // warns before you pick a file, not after the upload finishes. What it
            // says stops short of a running count, on purpose: "you've used 5 of 5"
            // reads like a meter draining on something you paid for, when the plan
            // is really just due for its monthly reset.
            const limits = entitlement ? PLAN_LIMITS[entitlement.planKey] : null;
            if (limits && usage.coursesMonth >= limits.courses) {
                const resets = usage.monthResetAt
                    ? new Date(new Date(usage.monthResetAt).getFullYear(), new Date(usage.monthResetAt).getMonth() + 1, 1)
                        .toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
                    : null;
                const go = await uiConfirm(
                    'This month’s courses are all set',
                    `Your ${limits.label} plan is ready for more ${resets ? `on ${resets}` : 'next cycle'}. `
                    + 'Everything you already have still works — open, replay and review any of it in the meantime.',
                    { confirmText: 'See plans' });
                if (go) { showUpgradePrompt(); return; }
            }
            setScreen('home');
            document.getElementById('backToLibraryBtn').hidden = library.length === 0;
            setWorksheetMode(false);
        }

        // ============= Lesson preview =============
        let previewIndex = null;
        let previewRelease = null;

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
            // Tab used to walk straight out of the open dialog into the path behind
            // it, the way it already couldn't in the other two dialogs.
            previewRelease = trapFocus(document.getElementById('previewCard'),
                document.getElementById('previewStart'));
        }

        function closePreview() {
            const ov = document.getElementById('previewOverlay');
            ov.classList.remove('show');
            ov.setAttribute('aria-hidden', 'true');
            if (previewRelease) { previewRelease(); previewRelease = null; }
            previewIndex = null;
        }

        // ============= Screen Manager =============
        let savedPathScroll = 0;

        // Where this lesson sits: {course} › {unit or "Review"}. Needed because the
        // lesson screen is a full takeover — bottom nav, header, everything that
        // normally says which course you're in disappears the moment it opens — and
        // without this the only way to tell is to guess from the lesson's own
        // content. Read here rather than passed in, because both entry points
        // (loadLesson, startReviewSession) already set lessonState/currentLessonIndex
        // before calling openLessonScreen, so there is nothing this needs that
        // isn't already true by the time it runs.
        function renderLessonBreadcrumb() {
            const bar = document.getElementById('lessonBreadcrumb');
            if (!bar) return;

            const courseName = (courseData?.courseName || '').trim();
            if (!courseName) { bar.hidden = true; bar.innerHTML = ''; return; }

            const isReview = !!lessonState?.review;
            const here = isReview
                ? (lessonState.review.practice ? 'Extra practice' : 'Review')
                : `Unit ${unitNumber(currentLessonIndex)}`;

            bar.hidden = false;
            bar.innerHTML = `
                <button type="button" class="breadcrumb-home" id="breadcrumbHome"
                        aria-label="Back to ${escAttr(courseName)}">
                    ${ICONS.home}<span>${esc(courseName)}</span>
                </button>
                <span class="breadcrumb-sep" aria-hidden="true">›</span>
                <span class="breadcrumb-here">${esc(here)}</span>`;
            // Same destination the X button already goes to — a second, more
            // legible way back, not a second behaviour to keep in sync.
            document.getElementById('breadcrumbHome').onclick = exitLesson;
        }

        function openLessonScreen() {
            const path = document.querySelector('.path-container');
            savedPathScroll = path ? path.scrollTop : 0;

            renderLessonBreadcrumb();
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
            if (demoMode) { exitDemoLesson(); return; }
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
        // A figure attached to the question is drawn above it — for a hotspot
        // question the figure *is* the answer sheet, so that one draws its own.
        function renderQuestion(q, idPrefix) {
            const p = idPrefix || 'q';
            const figure = (q.visual && q.type !== 'hotspot') ? renderVisual(q.visual) : '';
            switch (q.type) {
                case 'boolean':    return figure + renderBoolean(q, p);
                case 'order':      return figure + renderOrder(q, p);
                case 'categorize': return figure + renderCategorize(q, p);
                case 'match':      return figure + renderMatch(q, p);
                case 'blank':      return figure + renderBlank(q, p);
                case 'numeric':    return figure + renderNumeric(q, p);
                case 'hotspot':    return renderHotspot(q, p);
                case 'choice':
                case 'mistake':
                default:           return figure + renderChoice(q, p);
            }
        }

        // Answers are <button>s, not clickable <div>s: the whole quiz — the core of
        // the product — used to be unreachable by keyboard and announced as plain
        // text to a screen reader.
        function renderChoice(q, p) {
            const opts = q.options.map((o, i) =>
                `<button type="button" class="option" data-answer="${i}">${esc(o)}</button>`).join('');
            return `<h2 class="question-text">${esc(q.text)}</h2>
                    <div class="options" id="answerOpts">${opts}</div>`;
        }

        function renderBlank(q, p) {
            // Render the sentence with the gap highlighted, options below.
            const sentence = esc(q.text).replace(/_{2,}|＿+/g, '<span class="blank-gap">?</span>');
            const opts = q.options.map((o, i) =>
                `<button type="button" class="option" data-answer="${i}">${esc(o)}</button>`).join('');
            return `<h2 class="question-text blank-sentence">${sentence}</h2>
                    <div class="step-note">Choose the word that fills the gap</div>
                    <div class="options" id="answerOpts">${opts}</div>`;
        }

        function renderBoolean(q, p) {
            return `<h2 class="question-text">${esc(q.text)}</h2>
                    <div class="bool-row" id="answerOpts">
                        <button type="button" class="option bool-opt" data-answer="true">${ICONS.check} True</button>
                        <button type="button" class="option bool-opt" data-answer="false">${ICONS.x} False</button>
                    </div>`;
        }

        function renderOrder(q, p) {
            // Present shuffled; learner taps to build the sequence.
            const shuffled = shuffle(q.items.map((text, idx) => ({ text, idx })));
            const pool = shuffled.map(it =>
                `<button class="order-chip" data-idx="${it.idx}">${esc(it.text)}</button>`).join('');
            return `<h2 class="question-text">${esc(q.text)}</h2>
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
            return `<h2 class="question-text">${esc(q.text)}</h2>
                    <div class="step-note">Tap an item, then tap its group — tap a placed item to move it back</div>
                    <div class="cat-pool" id="catPool">${pool}</div>
                    <div class="cat-buckets" id="catBuckets">${buckets}</div>`;
        }

        // A typed number. Multiple choice on a calculation gives the answer away
        // — four options and one of them is right — so anything the learner is
        // meant to *work out* is asked this way instead.
        function renderNumeric(q, p) {
            return `<h2 class="question-text">${esc(q.text)}</h2>
                    <div class="numeric-row">
                        <input class="text-input numeric-input" id="numericInput" type="text"
                               inputmode="decimal" autocomplete="off" placeholder="Your answer">
                        ${q.unit ? `<span class="numeric-unit">${esc(q.unit)}</span>` : ''}
                    </div>
                    <button class="button numeric-submit" id="numericSubmit">Check</button>`;
        }

        function renderHotspot(q, p) {
            return `<h2 class="question-text">${esc(q.text)}</h2>
                    <div class="step-note">Tap the part of the figure</div>
                    <div class="hotspot-figure" id="hotspotFigure">${renderVisual(q.visual, { interactive: true })}</div>`;
        }

        function renderMatch(q, p) {
            // Two columns; tap left then right to connect. Right side shuffled.
            const left = q.pairs.map((pair, i) =>
                `<button class="match-item match-left" data-left="${i}">${esc(pair.left)}</button>`).join('');
            const right = shuffle(q.pairs.map((pair, i) => ({ text: pair.right, i })))
                .map(r => `<button class="match-item match-right" data-right="${r.i}">${esc(r.text)}</button>`).join('');
            return `<h2 class="question-text">${esc(q.text)}</h2>
                    <div class="step-note">Tap a term, then tap its match</div>
                    <div class="match-grid">
                        <div class="match-col" id="matchLeft">${left}</div>
                        <div class="match-col" id="matchRight">${right}</div>
                    </div>`;
        }

        // ---- Wiring & grading ----
        // Each wirer calls finishQuestion(correct, explanation) when the learner
        // has committed an answer.
        // `scored: false` is for the questions that are not this lesson's exam:
        // the warm-up from an earlier lesson, and the second look at something
        // already marked wrong. Both are worth answering and neither should
        // move a score that has already been earned.
        //
        // Nothing here punishes a wrong answer. There were five hearts in the
        // topbar and they were the wrong idea in this app: a course built from
        // the learner's own document is not a game they can lose, and a row of
        // hearts draining on a first encounter with an idea teaches nothing
        // except that guessing is expensive. What a mistake costs is a second
        // attempt at the question, an explanation of what went wrong, and one
        // more look at it before the lesson ends.
        // `why` is the line written for the option they actually picked (see
        // "whyWrong" in the lesson prompt). It is the difference between "not
        // quite" and "you added the squares where this one asks you to subtract
        // them" — and it is the whole of what the retry banner says, because at
        // that point naming the mistake is the only help that does not also
        // hand over the answer.
        function wireQuestion(q, onGraded, { scored = true } = {}) {
            // A first wrong answer is not the end of the question. Say what the
            // mistake was and hand it back — a learner who is told the answer
            // straight away has been shown it, not taught it, and the second
            // attempt is where the understanding actually happens.
            //
            // The retry costs nothing and counts nothing. The second attempt
            // is the one that scores, so the lesson still means something.
            const attemptKey = lessonState.step;
            if (!lessonState.attempts) lessonState.attempts = {};
            const attempt = () => lessonState.attempts[attemptKey] || 0;

            const done = (correct, explanationOverride, why = '') => {
                if (!correct && attempt() === 0) {
                    lessonState.attempts[attemptKey] = 1;
                    showRetry(q, why);
                    return;
                }
                if (scored) {
                    lessonState.total++;
                    if (correct) lessonState.correct++;
                }
                showQuestionFeedback(correct, explanationOverride || q.explanation, why);
                onGraded && onGraded(correct);
            };

            switch (q.type) {
                case 'boolean':    return wireBoolean(q, done);
                case 'order':      return wireOrder(q, done);
                case 'categorize': return wireCategorize(q, done);
                case 'match':      return wireMatch(q, done);
                case 'numeric':    return wireNumeric(q, done);
                case 'hotspot':    return wireHotspot(q, done);
                case 'blank':
                case 'choice':
                case 'mistake':
                default:           return wireChoice(q, done);
            }
        }

        // What a learner types is not what a parser wants: thousands separators,
        // a comma for the decimal point, the unit typed out after the number, a
        // percent sign. Read the number out of it rather than rejecting it.
        function parseLearnerNumber(raw) {
            const cleaned = String(raw || '')
                .replace(/[−–—]/g, '-')
                .replace(/[\s '`״׳]/g, '')
                .replace(/,(?=\d{3}\b)/g, '')     // 1,200 → 1200
                .replace(/,/g, '.');              // 3,5 → 3.5
            // A math answer is often correct as a fraction — "1/2" for a
            // question graded against the decimal 0.5 — and typing the
            // decimal instead is not how anyone actually thinks the answer.
            // Divide it out before falling back to reading a single number
            // out of the string, so "1/2" is not read as "1" with a stray
            // "/2" ignored.
            const frac = /^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/.exec(cleaned);
            if (frac) {
                const den = Number(frac[2]);
                return den ? Number(frac[1]) / den : null;
            }
            const m = /-?\d+(\.\d+)?/.exec(cleaned);
            return m ? Number(m[0]) : null;
        }

        function wireNumeric(q, done) {
            const input = document.getElementById('numericInput');
            const submit = document.getElementById('numericSubmit');
            if (!input || !submit) return;

            const grade = () => {
                const value = parseLearnerNumber(input.value);
                if (value === null) { input.classList.add('shake'); setTimeout(() => input.classList.remove('shake'), 400); return; }
                // A tolerance of zero still needs a float epsilon: 0.1 + 0.2 is
                // not 0.3 in any language, and the learner typed 0.3.
                const isRight = Math.abs(value - q.answer) <= (q.tolerance || 1e-9);
                input.disabled = true;
                submit.disabled = true;
                input.classList.add(isRight ? 'is-correct' : 'is-incorrect');
                const shown = fmtNum(q.answer, 4) + (q.unit || '');
                done(isRight, isRight ? q.explanation
                    : [`The answer is ${shown}.`, q.explanation].filter(Boolean).join(' '));
            };

            submit.onclick = grade;
            input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); grade(); } };
            input.focus({ preventScroll: true });
        }

        function wireHotspot(q, done) {
            const figure = document.getElementById('hotspotFigure');
            if (!figure) return;
            const parts = [...figure.querySelectorAll('[data-part]')];

            const pick = el => {
                if (figure.classList.contains('is-answered')) return;
                figure.classList.add('is-answered');
                const isRight = el.dataset.part === q.target;
                parts.forEach(p => {
                    if (p.dataset.part === q.target) p.classList.add('is-right');
                    else if (p === el) p.classList.add('is-wrong');
                    p.removeAttribute('tabindex');
                });
                done(isRight);
            };

            parts.forEach(el => {
                el.onclick = () => pick(el);
                el.onkeydown = e => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(el); }
                };
            });
        }

        // Duolingo's signature moment: a colored banner docks in from the bottom
        // of the screen with the verdict and a big Continue.
        // `why` is about the answer they gave; `explanation` is about the
        // question. Both are shown, in that order, because the first one is the
        // only part addressed to them.
        function showQuestionFeedback(correct, explanation, why = '') {
            const bar = document.getElementById('feedbackBar');
            if (!bar) return;
            bar.className = 'feedback-bar show ' + (correct ? 'feedback-ok' : 'feedback-bad');
            // The inner wrapper is what the grid row animates against, so a long
            // explanation grows the banner instead of being clipped by a fixed
            // max-height the way it used to be.
            bar.innerHTML = `
                <div>
                    <div class="feedback-inner">
                        <div class="feedback-head">${correct ? ICONS.check + ' Nice!' : ICONS.x + ' Not quite'}</div>
                        ${!correct && why ? `<div class="feedback-why">${esc(why)}</div>` : ''}
                        <div class="feedback-body">${explanation ? esc(explanation) : ''}</div>
                        <button class="button step-next" id="stepNext">Continue</button>
                    </div>
                </div>`;
            const next = document.getElementById('stepNext');
            next.onclick = advanceStep;
            // The verdict is the only thing that matters at this moment; put the
            // keyboard on the button that moves past it.
            if (!prefersReducedMotion()) setTimeout(() => next.focus({ preventScroll: true }), 60);
            else next.focus({ preventScroll: true });
        }

        // Between the two attempts: what went wrong, and a way back in. No
        // Continue here on purpose — the only way past this question is to
        // answer it again.
        function showRetry(q, why) {
            const bar = document.getElementById('feedbackBar');
            if (!bar) return;
            // The line for the option they picked first, then the question's own
            // hint. Never the grader's message: for a numeric or an ordering
            // question that message contains the answer, and this banner is
            // shown *before* the second attempt.
            const nudge = why || q.hint
                || 'Look again at what the question is actually asking.';
            bar.className = 'feedback-bar show feedback-retry';
            bar.innerHTML = `
                <div>
                    <div class="feedback-inner">
                        <div class="feedback-head">${ICONS.x} Not quite — one more go</div>
                        <div class="feedback-body">${esc(nudge)}</div>
                        <button class="button step-next" id="stepRetry">Try again</button>
                    </div>
                </div>`;
            const again = document.getElementById('stepRetry');
            again.onclick = () => renderStep();      // re-renders and re-wires this step
            if (!prefersReducedMotion()) setTimeout(() => again.focus({ preventScroll: true }), 60);
            else again.focus({ preventScroll: true });
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
                    done(isRight, null, isRight ? '' : (q.whyWrong?.[picked] || ''));
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
            const buckets = document.getElementById('catBuckets');
            let selected = null;   // the chip element awaiting a bucket
            const assign = {};     // idx -> bucket index
            const total = q.items.length;
            // Grading is automatic the moment every item has a bucket, which
            // means a misplaced item was locked in with no way back until the
            // ordering question type got an undo and this one didn't. A tap
            // on the placed chip un-assigns it — right up until grading, after
            // which `.is-graded` below turns the pointer back into a label.
            let graded = false;

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
                    const placedChip = document.createElement('button');
                    placedChip.type = 'button';
                    placedChip.className = 'cat-placed';
                    placedChip.dataset.idx = idx;
                    placedChip.setAttribute('aria-label', `Move "${q.items[idx].text}" back to the list`);
                    placedChip.innerHTML = `<span>${esc(q.items[idx].text)}</span>${ICONS.x}`;
                    placedChip.onclick = e => {
                        e.stopPropagation();
                        if (graded) return;
                        delete assign[idx];
                        placedChip.remove();
                        const original = pool.querySelector(`.cat-chip[data-idx="${idx}"]`);
                        if (original) original.classList.remove('placed');
                    };
                    drop.appendChild(placedChip);
                    selected.classList.add('placed');
                    selected.classList.remove('selected');
                    selected = null;
                    if (Object.keys(assign).length === total) grade();
                };
            });

            const grade = () => {
                graded = true;
                if (buckets) buckets.classList.add('is-graded');
                let right = 0;
                q.items.forEach((it, idx) => {
                    const correctBucket = q.buckets.indexOf(it.bucket);
                    const chip = buckets?.querySelector(`.cat-placed[data-idx="${idx}"]`);
                    if (assign[idx] === correctBucket) {
                        right++;
                        if (chip) chip.classList.add('is-right');
                    } else if (chip) {
                        chip.classList.add('is-wrong');
                    }
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
            // Pair colours are functional — they only have to be told apart — but
            // they still come from the app's palette rather than a sixth set of hues.
            const palette = ['#0B6FA3', '#7C3FBF', '#3E8523', '#A8620A', '#C81E1E', '#0F766E'];

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

        // ============= Demo lesson =============
        // A hand-written, zero-cost lesson a brand-new visitor can try before
        // committing to an upload and a wait. It runs through the exact same
        // step engine as a real lesson — same renderers, same question
        // grading — because the point is to show the actual thing, not a
        // mockup of it. The only special handling is making sure it can never
        // write anything: it ends on its own step type instead of `complete`
        // (so commitLessonResult/saveProgress/bumpStreak never run for it),
        // and it snapshots and restores every global the real lesson flow
        // touches, so trying it can't disturb a course someone already has
        // open.
        let demoMode = false;
        let demoSnapshot = null;

        function demoLessonContent() {
            return {
                title: 'Why the Sky Is Blue',
                estimatedMinutes: 2,
                hook: {
                    text: 'Sunlight looks white, but it’s secretly every color mixed together. '
                        + 'Something in the air is pulling the blue out of that mix before it reaches your eyes.',
                },
                cards: [
                    {
                        idea: 'Light scatters off tiny things',
                        text: 'Air is mostly empty space, but it’s full of gas molecules far smaller than a '
                            + 'wavelength of light. When sunlight hits one, it bounces off in a random direction — '
                            + 'physicists call this scattering.',
                        analogy: 'Like a wave hitting a buoy: the buoy doesn’t block the wave, it just sends out little ripples of its own.',
                        visual: null,
                    },
                    {
                        idea: 'Blue scatters the most',
                        text: 'Shorter wavelengths scatter far more than longer ones — blue light scatters about '
                            + 'five times more than red. So blue gets bounced all over the sky, arriving at your eyes '
                            + 'from every direction, while red mostly goes straight through.',
                        analogy: null,
                        visual: null,
                    },
                ],
                quiz: [
                    {
                        type: 'choice',
                        text: 'Why does the sky look blue instead of red?',
                        options: ['Blue light scatters more than red light', 'The atmosphere is naturally blue', 'Red light gets absorbed by clouds'],
                        correct: 0,
                        hint: 'Think about which color got mentioned as bouncing around the most.',
                        explanation: 'Shorter wavelengths (blue) scatter far more off air molecules than longer ones (red), so blue light reaches your eyes from all over the sky.',
                    },
                    {
                        type: 'choice',
                        text: 'What would sunsets look like with a much thinner atmosphere?',
                        options: ['Less colorful — less air means less scattering', 'Even more red and orange', 'Exactly the same'],
                        correct: 0,
                        hint: 'Scattering is what paints the sky — what happens if there’s less of the thing doing the scattering?',
                        explanation: 'A sunset’s color comes from sunlight travelling through a lot of atmosphere at a low angle, scattering out the blue and leaving red and orange. Less air means less of that effect.',
                    },
                ],
                challenge: null, summary: null, memoryCheck: null, prediction: null, explore: null,
                workedExample: null, practice: null,
            };
        }

        function startDemoLesson() {
            demoSnapshot = { courseData, progress, activeCourseId, currentLessonIndex, lessonState };
            demoMode = true;

            // No courseName means renderLessonBreadcrumb() stays hidden — there is
            // no real course to jump back to from inside the demo.
            courseData = { courseName: '', language: 'English', concepts: [{ name: 'Why the Sky Is Blue' }] };
            progress = {};
            activeCourseId = null;
            currentLessonIndex = 0;

            const lesson = demoLessonContent();
            const steps = [
                { type: 'hook' }, { type: 'card', i: 0 }, { type: 'card', i: 1 },
                { type: 'quiz', i: 0 }, { type: 'quiz', i: 1 }, { type: 'demoComplete' },
            ];
            lessonState = {
                lesson, steps, step: 0, correct: 0, total: 0,
                startedAt: Date.now(), answered: {}, attempts: {},
                warmUp: null, missed: [], result: null,
            };

            document.getElementById('lessonXpBadge').textContent = 'Example — nothing is saved';
            document.getElementById('lessonMeta').innerHTML = `
                <span class="meta-chip">2 min</span>
                <span class="meta-chip">${steps.length} steps</span>`;

            applyContentDirection();
            buildStepSegments(steps.length);
            openLessonScreen();
            renderStep();
        }

        function exitDemoLesson() {
            closeLessonScreen();
            ({ courseData, progress, activeCourseId, currentLessonIndex, lessonState } = demoSnapshot);
            demoSnapshot = null;
            demoMode = false;
            // Opened from the first run rather than from the home screen: go
            // back to the step it was on, not to an upload box they have not
            // been introduced to yet.
            if (onboardingPaused) { resumeOnboardingFromDemo(); return; }
            setScreen('home');
        }

        // ============= Writing the next lesson during this one =============
        //
        // Streaming makes the wait legible. This is the one that removes it.
        //
        // A lesson takes five to ten minutes to work through and one to two to
        // generate on the tiers that run the larger models, and those two
        // numbers have never overlapped: the learner finishes, presses "Next
        // lesson", and only then does anything start being written. So it
        // starts a third of the way through the current lesson instead — by
        // the time they press the button the next lesson is already sitting in
        // `progress`, which is exactly where a replayed one comes from, and it
        // opens instantly.
        //
        // It also fixes the cache it rides on. The shared course context is
        // cached for five minutes, and a learner takes longer than that per
        // lesson, so a lesson requested *after* the previous one finishes
        // always misses and pays the write premium again. Requested while the
        // previous one is still on screen, it hits — which makes the next
        // lesson both faster and about a tenth of the input price.
        //
        // What it must never do is spend a lesson the learner would not have:
        // it runs only for the very next concept, only once, and only when
        // there is quota left to spend on it.
        const prefetching = new Map();   // concept index -> Promise<lesson|null>

        // The index a learner is actually sitting on the "Almost ready…"
        // overlay for, or null. A prefetch runs with nobody watching most of
        // the time — lesson 2 written while lesson 1 is still on screen — and
        // drawing its partial content then would mean opening a lesson screen
        // nobody asked for. Set only while `loadLesson` is awaiting that exact
        // index's prefetch, so `prefetchLesson`'s `onPartial` knows when it is
        // safe to put a draft on screen instead of leaving the learner on a
        // blank spinner for however long the rest takes.
        let watchingIndex = null;

        function monthlyLessonsLeft() {
            const limits = PLAN_LIMITS[entitlement?.planKey];
            if (!limits || !usage.loaded) return Infinity;   // unknown is not "none"
            return limits.courses * limits.lessonsPerCourse - (usage.lessonsMonth || 0);
        }

        // How many of the quiz's questions are moved up among the cards.
        //
        // Three or four explanation cards in a row is the one place this lesson
        // still reads like a page rather than something you do: the learner taps
        // Continue, Continue, Continue, and only then is asked whether any of it
        // landed. Every question moved up is a card that gets answered while the
        // idea in it is still the thing on screen.
        //
        // Half the quiz, rounded down, and never one after the last card. The
        // closing run has to stay long enough to be a quiz — the point is to
        // break up the cards, not to abolish the part where the whole lesson is
        // tested at once. Fewer than two cards, or fewer than two questions, and
        // nothing moves at all.
        function interleavedCount(cardCount, quizCount) {
            return Math.min(Math.max(cardCount - 1, 0), Math.floor(quizCount / 2));
        }

        /**
         * The part of a half-written lesson that is safe to show already.
         *
         * A lesson is opened before it has finished streaming (see
         * `loadLesson`), and the one thing that must never happen is a step
         * moving under a learner who is standing on it. `buildLessonSteps`
         * lays the opening out as warm-up, hook, prediction, explore and only
         * then reaches the cards — and none of those four depend on anything
         * written later. Every field after `explore` is dropped here, cards
         * included and *especially* cards: `interleavedCount` decides how many
         * quiz questions sit between them, the quiz is written after them, so
         * a card rendered early would have questions spliced in around it once
         * the quiz landed.
         *
         * What this buys is the guarantee the whole feature rests on:
         * `buildLessonSteps(openingLesson(l))` is always a prefix of
         * `buildLessonSteps(l)`, so the steps a learner has already walked
         * through are exactly the steps the finished lesson would have given
         * them. `tests/lesson-flow.js` checks that against the real thing.
         */
        function openingLesson(lesson) {
            if (!lesson) return null;
            return {
                title: lesson.title,
                estimatedMinutes: lesson.estimatedMinutes,
                hook: lesson.hook || null,
                prediction: lesson.prediction || null,
                explore: lesson.explore || null,
                cards: [],
                quiz: [],
            };
        }

        // Worth opening early only if there is something to do in it. A hook
        // alone is one screen and a Continue button, which lands the learner on
        // the waiting state almost immediately — worse than a spinner, because
        // it looks like the lesson broke.
        function openingIsWorthShowing(lesson) {
            const opening = openingLesson(lesson);
            if (!opening?.hook) return false;
            return !!(opening.prediction || opening.explore);
        }

        // The whole step sequence for a lesson, skipping anything the model
        // omitted. Pure — it reads a lesson and returns a list — so the order
        // is testable without a browser, which is the only reason the run of
        // pushes that used to live inside loadLesson() is a function now.
        function buildLessonSteps(lesson, { warmUp = false } = {}) {
            const steps = [];
            const cards = Array.isArray(lesson.cards) ? lesson.cards : [];
            const quiz = Array.isArray(lesson.quiz) ? lesson.quiz : [];

            if (warmUp) steps.push({ type: 'warmup' });
            if (lesson.hook) steps.push({ type: 'hook' });
            if (lesson.prediction) steps.push({ type: 'prediction' });
            if (lesson.explore) steps.push({ type: 'explore' });

            const early = interleavedCount(cards.length, quiz.length);
            cards.forEach((_, i) => {
                steps.push({ type: 'card', i });
                if (i < early) steps.push({ type: 'quiz', i });
            });

            if (lesson.workedExample) steps.push({ type: 'worked' });
            if (lesson.practice) steps.push({ type: 'practice' });
            quiz.forEach((_, i) => { if (i >= early) steps.push({ type: 'quiz', i }); });
            if (lesson.challenge) steps.push({ type: 'challenge' });
            if (lesson.summary) steps.push({ type: 'summary' });
            if (lesson.memoryCheck) steps.push({ type: 'memory' });
            return steps;
        }

        function prefetchLesson(index) {
            if (!courseData || !currentUser) return;
            const concept = courseData.concepts?.[index];
            if (!concept) return;
            if (progress[index]?.lesson) return;             // already have it
            if (prefetching.has(index)) return;              // already writing it
            if (navigator.onLine === false) return;
            // The last lesson of the month is the learner's to choose, not
            // ours to spend on a guess about what they will open next.
            if (monthlyLessonsLeft() <= 1) return;

            // The document, not the course id, is what says which course this
            // lesson belongs to. They agree everywhere except the one place
            // that matters here: lesson 1 is started while the course is still
            // being planned (see `processLearningMaterial`), so there is no id
            // to capture yet and comparing one would discard a lesson that had
            // been written perfectly well. The source text is set the moment
            // the build commits to a document and put back if it never
            // produces a course, which is exactly the question being asked.
            const source = activeSourceText;
            const promise = generateLesson(concept, {
                quiet: true,
                // A no-op unless someone is actually waiting on this exact
                // lesson (see `watchingIndex`) — a prefetch running ahead of
                // the learner must stay invisible until they ask for it.
                onPartial: draft => {
                    if (watchingIndex === index) openPartialLesson(draft, index, concept);
                },
            })
                .then(lesson => {
                    // A course switched away from mid-flight has a different
                    // `progress` object behind it now. Writing this lesson
                    // into it would file lesson 4 of one course as lesson 4 of
                    // another.
                    if (lesson && activeSourceText === source) {
                        if (!progress[index]) progress[index] = {};
                        progress[index].lesson = lesson;
                        saveProgress();
                    }
                    return lesson;
                })
                .catch(err => { console.warn('Prefetch failed:', err); return null; })
                .finally(() => prefetching.delete(index));

            prefetching.set(index, promise);
        }

        // Far enough in that the learner has clearly committed to this lesson,
        // early enough that a slow tier still finishes writing the next one
        // before they get there.
        function maybePrefetchNext() {
            if (!lessonState || lessonState.review) return;
            // This lesson is still being written. Starting the next one now
            // would run two generations at once and, on a short opening, would
            // trigger a third of the way into four steps rather than a third of
            // the way into the lesson.
            if (lessonState.partialFor != null) return;
            const { step, steps } = lessonState;
            if (step < Math.floor(steps.length / 3)) return;
            prefetchLesson(currentLessonIndex + 1);
        }

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
                } else if (prefetching.has(index)) {
                    // Already being written in the background. Waiting on that
                    // one is the whole point — starting a second call for the
                    // same lesson would spend two of the month's lessons and
                    // arrive later than the one already in flight.
                    showMessage("Almost ready…");
                    showProgress('This lesson was already being written');
                    // Tells the prefetch's own `onPartial` (see
                    // `prefetchLesson`) that its draft is now safe to draw —
                    // reset in the `finally` below regardless of how this
                    // turns out.
                    watchingIndex = index;
                    lesson = await prefetching.get(index);
                    if (!lesson) {
                        // The background attempt failed quietly. Now that
                        // someone is actually waiting, try again in the
                        // foreground, where both the failure and the progress
                        // are visible.
                        showMessage("Preparing lesson...");
                        lesson = await generateLesson(concept);
                    }
                    if (!lesson) { closeLessonScreen(); return; }
                    if (!progress[index]) progress[index] = {};
                    progress[index].lesson = lesson;
                    saveProgress();
                } else {
                    // Nobody reading anything yet, so this is the other branch
                    // that opens the lesson early — a cached lesson is instant
                    // already, and one being prefetched is covered by
                    // `watchingIndex` above.
                    lesson = await generateLesson(concept, {
                        onPartial: draft => openPartialLesson(draft, index, concept),
                    });
                    if (!lesson) {
                        // Generation failed. Stay on the path; the error was already shown.
                        // If the opening had already gone up, this closes it —
                        // leaving a hook on screen with nothing behind it would
                        // be a lesson that can never continue.
                        closeLessonScreen();
                        return;
                    }
                    if (!progress[index]) progress[index] = {};
                    progress[index].lesson = lesson;
                    saveProgress();
                }

                // Already on screen and half-read: the opening went up while
                // this was still streaming, so swap the finished lesson in
                // underneath rather than starting it over from step 0.
                if (lessonState?.partialFor === index) {
                    applyFinishedLesson(lesson, concept);
                    return;
                }

                // Retrieval practice comes first, from an earlier lesson —
                // before the new material has a chance to crowd it out.
                const warmUp = pickWarmUp(index);
                const steps = buildLessonSteps(lesson, { warmUp: !!warmUp });

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
                    startedAt: Date.now(),
                    answered: {},
                    attempts: {},
                    warmUp,
                    // Questions that went wrong on both attempts, kept so the
                    // lesson can come back to them before it calls itself done.
                    missed: [],
                    result: null,
                    // Set only while a half-written lesson is on screen.
                    partialFor: null,
                };

                document.getElementById('sourcePicker').hidden = true;
                document.getElementById('learningPath').classList.add('active');

                setLessonChrome(lesson, concept, steps);
                applyContentDirection();
                buildStepSegments(steps.length);
                displayLearningPath();
                openLessonScreen();
                renderStep();
            } finally {
                lessonLoading = false;
                watchingIndex = null;
                hideMessage();
            }
        }

        // Max possible: base + 10 per gradeable question + perfect-run bonus.
        // Read off the finished lesson, so it is only ever set once the quiz is
        // all there — a half-written lesson has no honest number to show.
        function setLessonChrome(lesson, concept, steps) {
            const gradeable = (lesson.quiz?.length || 0)
                + (lesson.practice ? 1 : 0)
                + (lesson.challenge ? 1 : 0);
            const maxXp = 20 + gradeable * 10 + (gradeable > 0 ? 25 : 0);
            document.getElementById('lessonXpBadge').textContent = `Up to ${maxXp} XP`;
            document.getElementById('lessonMeta').innerHTML = `
                <span class="meta-chip">${lesson.estimatedMinutes} min</span>
                <span class="meta-chip">Difficulty ${'●'.repeat(concept.difficulty || 1)}${'○'.repeat(Math.max(0, 5 - (concept.difficulty || 1)))}</span>
                <span class="meta-chip">${steps.length} steps</span>`;
        }

        /**
         * Put a lesson on screen before it has finished being written.
         *
         * Only the opening goes up (see `openingLesson`), followed by a
         * `writing` step that the learner reaches only if they outrun the
         * model. Nothing here is saved to `progress`: a half-written lesson is
         * not a lesson, and filing one would hand it back from cache next time
         * with everything after `explore` missing for good.
         */
        function openPartialLesson(draft, index, concept) {
            const warmUp = pickWarmUp(index);
            const steps = buildLessonSteps(draft, { warmUp: !!warmUp });
            if (!steps.length) return false;
            steps.push({ type: 'writing' });

            lessonState = {
                lesson: draft, steps, step: 0,
                correct: 0, total: 0,
                startedAt: Date.now(),
                answered: {},
                attempts: {},
                warmUp,
                missed: [],
                result: null,
                partialFor: index,
            };

            document.getElementById('sourcePicker').hidden = true;
            document.getElementById('learningPath').classList.add('active');
            // No chrome yet — the XP total and the step count are both
            // unknowable until the quiz has arrived, and a number that changes
            // under the learner is worse than no number.
            document.getElementById('lessonXpBadge').textContent = '';
            applyContentDirection();
            buildStepSegments(steps.length);
            displayLearningPath();
            openLessonScreen();
            renderStep();
            hideMessage();
            return true;
        }

        /**
         * Swap the finished lesson in under a learner who is already reading it.
         *
         * Safe only because of the prefix guarantee `openingLesson` exists to
         * provide: the steps built from the finished lesson begin with exactly
         * the steps built from its opening, so `lessonState.step` still points
         * at the same step it did a moment ago. Everything the learner has done
         * — answers, attempts, the warm-up they were given — is carried across
         * untouched.
         *
         * The screen is only redrawn if they are sitting on the `writing` step,
         * where redrawing is the whole point. Redrawing anywhere else would
         * wipe a half-typed answer to a question that has not changed.
         */
        function applyFinishedLesson(lesson, concept) {
            const wasWaiting = lessonState.steps[lessonState.step]?.type === 'writing';
            const steps = buildLessonSteps(lesson, { warmUp: !!lessonState.warmUp });
            steps.push({ type: 'complete' });

            lessonState.lesson = lesson;
            lessonState.steps = steps;
            lessonState.partialFor = null;

            setLessonChrome(lesson, concept, steps);
            buildStepSegments(steps.length);
            updateStepSegments(lessonState.step, steps.length);
            if (wasWaiting) renderStep();
        }

        // The same question with the options moved, so a second look tests the
        // idea rather than the memory of which button turned green.
        function reshuffleOptions(q) {
            if (!Array.isArray(q.options) || q.options.length < 2) return q;
            if (!Number.isInteger(q.correct)) return q;
            const order = shuffle(q.options.map((_, i) => i));
            // Whatever is indexed by option has to travel with it. A whyWrong
            // left in place would explain the mistake behind whichever option
            // happened to land in that slot.
            const why = Array.isArray(q.whyWrong) ? order.map(i => q.whyWrong[i] || '') : q.whyWrong;
            return { ...q, options: order.map(i => q.options[i]),
                     correct: order.indexOf(q.correct), whyWrong: why };
        }

        // Three is the most anyone will work through at the end of a lesson.
        // Past that it stops being a second chance and becomes a punishment
        // for a bad run.
        const MAX_REPAIR = 3;

        function advanceStep() {
            if (!lessonState) return;
            const { steps, step } = lessonState;

            // The lesson is one step from declaring itself finished. Anything
            // that went wrong on the way gets asked once more first — and only
            // once, which is what `lessonState.repair` being set records.
            if (steps[step + 1]?.type === 'complete' && !lessonState.repair && lessonState.missed?.length) {
                lessonState.repair = lessonState.missed.slice(0, MAX_REPAIR)
                    .map(m => ({ ...m, question: reshuffleOptions(m.question) }));
                steps.splice(step + 1, 0, ...lessonState.repair.map((_, i) => ({ type: 'repair', i })));
                buildStepSegments(steps.length);
            }

            if (lessonState.step < steps.length - 1) {
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

            // "7 min · Difficulty · 16 steps" answers "should I start this?" — a
            // question you only ask once. Leaving it above every question ate the
            // top of a phone screen on all sixteen steps.
            //
            // It belongs on the lesson's own first step, which is the one after
            // the warm-up when there is one: the warm-up is a question, and a
            // panel of statistics about a different lesson above a question is
            // exactly what this was moved off.
            // Held back entirely while the lesson is still being written: two
            // of the three chips it carries (the step count, and the XP the
            // badge beside it shows) cannot be known until the quiz has
            // arrived. `applyFinishedLesson` fills them in.
            const meta = document.getElementById('lessonMeta');
            const introAt = steps.findIndex(x => x.type !== 'warmup');
            if (meta) meta.hidden = lessonState.partialFor != null || step !== introAt;

            const body = document.getElementById('lessonExplanation');

            // Commit exactly once, before rendering the complete screen.
            if (s.type === 'complete' && !lessonState.result) {
                lessonState.result = commitLessonResult();
            }
            if (s.type === 'reviewComplete' && !lessonState.result) {
                lessonState.result = commitReviewResult();
            }

            const renderers = {
                warmup: () => stepWarmUp(),
                repair: () => stepRepair(s.i),
                hook: () => stepHook(lesson),
                prediction: () => stepPrediction(lesson),
                explore: () => stepExplore(lesson),
                card: () => stepCard(lesson, s.i),
                worked: () => stepWorked(lesson),
                practice: () => stepPractice(lesson),
                quiz: () => stepQuiz(lesson, s.i),
                challenge: () => stepChallenge(lesson),
                summary: () => stepSummary(lesson),
                memory: () => stepMemory(lesson),
                complete: () => stepComplete(lesson),
                demoComplete: () => stepDemoComplete(),
                reviewq: () => stepReviewQuestion(s.i),
                reviewComplete: () => stepReviewComplete(),
                writing: () => stepWriting(),
            };
            body.innerHTML = renderers[s.type]();
            // Interactive diagrams arrive inert, whichever step drew them.
            wireVisuals(body);
            wireStep(s);
            // The next lesson is written while this one is being read.
            maybePrefetchNext();
            const scroller = document.getElementById('lessonScroll');
            if (scroller) {
                scroller.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
            }
        }

        // ---- Step renderers ----

        // Only reachable on a lesson opened before it finished streaming, and
        // only if the learner got through the opening faster than the model
        // wrote the rest. There is no Continue on it: `applyFinishedLesson`
        // replaces the step list and re-renders the moment the lesson lands, so
        // the button would be gone before it could be pressed. It says what is
        // happening rather than showing a bare spinner, because the learner is
        // mid-lesson here and a spinner with no sentence reads as a hang.
        function stepWriting() {
            return `
                <div class="step-writing">
                    <span class="spinner" aria-hidden="true"></span>
                    <h2 class="question-text">Still writing the rest…</h2>
                    <p class="step-writing-note">You got through the opening faster than we could
                    write the rest of it. This carries on by itself in a moment.</p>
                </div>`;
        }

        // The one question in the lesson that is not about this lesson. It
        // says which concept it came from, because being reminded that you
        // learned this on Tuesday is part of what the step is for.
        function stepWarmUp() {
            const { lessonIndex, question } = lessonState.warmUp;
            const concept = courseData.concepts[lessonIndex];
            return `
                <div class="step-eyebrow">Still know this? · ${esc(concept.name)}</div>
                ${renderQuestion(question, 'warm')}`;
        }

        // A question the learner got wrong twice, asked once more at the end of
        // the lesson with the explanation already behind it.
        //
        // The old ending was: get it wrong, read why, walk on, finish, see 60%.
        // The number was the only consequence, and a number is not a second
        // chance to understand. This is — and it deliberately does not move
        // the score, so it is a chance to get it right rather than a chance to
        // score better, which is the difference between practice and a resit.
        function stepRepair(i) {
            const { question, label } = lessonState.repair[i];
            return `
                <div class="step-eyebrow">Let's fix that · ${esc(label)}</div>
                <div class="step-note">This one didn't land the first time. No marks in it — just get it right.</div>
                ${renderQuestion(question, 'fix' + i)}`;
        }

        function stepHook(l) {
            return `
                <div class="step-eyebrow">A moment of curiosity</div>
                <div class="hook-card">${esc(l.hook.text)}</div>
                <button class="button step-next" id="stepNext">Continue</button>`;
        }

        function stepPrediction(l) {
            const opts = l.prediction.options.map((o, i) =>
                `<button type="button" class="option" data-pick="${i}">${esc(o)}</button>`).join('');
            return `
                <div class="step-eyebrow">Guess before we explain</div>
                <h2 class="question-text">${esc(l.prediction.question)}</h2>
                <div class="step-note">${"No wrong answer \u2014 just think for a second."}</div>
                <div class="options" id="predictOpts">${opts}</div>`;
        }

        // The Brilliant half of the lesson: do it, then be told why.
        //
        // Continue stays disabled until the learner actually touches the figure.
        // That is the whole difference between an interaction and an
        // illustration — a step you can click past without touching is one you
        // did not do, and the insight underneath it would be an answer to a
        // question nobody asked.
        function stepExplore(l) {
            return `
                <div class="step-eyebrow">Try it</div>
                <h2 class="question-text">${esc(l.explore.instruction)}</h2>
                <div class="explore-figure">${renderVisual(l.explore.visual)}</div>
                ${l.explore.insight
                    ? `<div class="explore-insight" id="exploreInsight" hidden>
                           <span class="analogy-label">What just happened</span>${esc(l.explore.insight)}
                       </div>`
                    : ''}
                <button class="button step-next" id="stepNext" disabled>Continue</button>`;
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
                `<button type="button" class="option" data-answer="${i}">${esc(o)}</button>`).join('');
            return `
                <div class="step-eyebrow">Guided practice</div>
                <h2 class="question-text">${esc(p.problem)}</h2>
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
                <h2 class="question-text">${esc(l.memoryCheck.prompt)}</h2>
                <textarea class="memory-input" id="memoryInput" placeholder="Write it in your own words…"></textarea>
                <button class="button" id="memorySubmit">Check my answer</button>
                <div class="feedback" id="memoryFeedback" role="status" aria-live="polite" hidden></div>`;
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
                    <div class="complete-actions">
                        <button class="button" id="backToPath">Back to path</button>
                    </div>
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
                    ${isLast ? `<div class="step-note">You finished the whole course. Well done.</div>` : ''}
                    <!-- One obvious next step, with the way back underneath it —
                         not two buttons of equal weight side by side. -->
                    <div class="complete-actions">
                        ${isLast ? '' : `<button class="button" id="continueNext">Next lesson</button>`}
                        <button class="button ${isLast ? '' : 'button-secondary'}" id="backToPath">Back to path</button>
                    </div>
                </div>`;
        }

        // The demo's own ending — deliberately not `complete`, so nothing here
        // ever reaches commitLessonResult() (no XP, no streak, no save).
        function stepDemoComplete() {
            const { correct, total } = lessonState;
            return `
                <div class="complete-screen">
                    <div class="complete-badge">${ICONS.check}</div>
                    <h3 class="complete-title">That's a full lesson</h3>
                    <div class="complete-stats">
                        <div class="cstat"><div class="cstat-val">${correct}/${total}</div><div class="cstat-lbl">Correct</div></div>
                    </div>
                    <div class="step-note">Every real lesson works exactly like this one — written from your own material, with a warm-up, a quiz, and a repair round if something doesn't stick.</div>
                    <div class="complete-actions">
                        <button class="button" id="demoExitBtn">${onboardingPaused ? 'Back to setting up' : 'Build my own course'}</button>
                    </div>
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

            if (s.type === 'explore') {
                const figure = document.querySelector('.explore-figure');
                const insight = document.getElementById('exploreInsight');
                const unlock = () => {
                    if (next.disabled === false) return;
                    next.disabled = false;
                    if (insight) {
                        insight.hidden = false;
                        insight.classList.add('appear');
                    }
                };
                // Whatever the figure is made of, touching it counts: a slider
                // fires input, a reveal card and a hotspot fire click, and a
                // keyboard user gets there with a key. Listening for all three
                // on the container means a new interactive type needs no change
                // here to unlock the step.
                if (figure) {
                    ['input', 'change', 'click', 'keyup'].forEach(event =>
                        figure.addEventListener(event, unlock, { once: false }));
                } else {
                    unlock();
                }
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
                const label = s.type === 'quiz' ? `Question ${s.i + 1}` : 'Final challenge';
                wireQuestion(item, correct => {
                    if (!correct) lessonState.missed.push({ question: item, label });
                });
            }

            if (s.type === 'warmup') {
                const { lessonIndex, question } = lessonState.warmUp;
                wireQuestion(question, correct => {
                    // Getting it wrong is the useful outcome: it says that
                    // lesson needs seeing again sooner than the schedule
                    // thought. Getting it right changes nothing — one question
                    // answered under no pressure is not evidence enough to
                    // push a review further out.
                    if (!correct) nudgeReviewSooner(lessonIndex);
                }, { scored: false });
            }

            if (s.type === 'repair') {
                wireQuestion(lessonState.repair[s.i].question, null, { scored: false });
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
                const input = document.getElementById('memoryInput');
                if (input) {
                    // Plain Enter has to stay a newline — this is the one step
                    // that asks for a written answer — so the submit shortcut
                    // rides the modifier instead, same idea as the numeric
                    // step's bare Enter-to-check.
                    input.onkeydown = e => {
                        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); evaluateMemory(); }
                    };
                    input.focus({ preventScroll: true });
                }
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

            if (s.type === 'demoComplete') {
                document.getElementById('demoExitBtn').onclick = exitDemoLesson;
            }
        }

        async function evaluateMemory() {
            const input = document.getElementById('memoryInput').value.trim();
            const fb = document.getElementById('memoryFeedback');
            if (!input) return;

            fb.hidden = false;
            fb.className = 'feedback';
            fb.innerHTML = `<div class="tutor-thinking">
                <span class="spinner" aria-hidden="true"></span><span>Reading your answer…</span>
            </div>`;

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
            const colors = ['#3E8523', '#0B6FA3', '#7C3FBF', '#A8620A', '#C81E1E'];
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

            const meta = document.querySelector('.course-progress-meta');
            if (meta) meta.hidden = false;    // showCoursePathSkeleton() may have hidden it
            document.getElementById('completedCount').textContent = completed;
            document.getElementById('progressPercent').textContent = percent + '%';
            document.getElementById('progressBar').style.width = percent + '%';
        }

        // ============= Event Listeners =============
        document.getElementById('tryDemoLessonBtn').addEventListener('click', startDemoLesson);

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

        // Drag state is a class, not an inline colour: `drop` never cleared the
        // inline border the way `dragleave` did, so the zone stayed highlighted
        // after every successful drop.
        const dropZone = document.getElementById('uploadSection');
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('is-dragging');
        });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-dragging'));
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('is-dragging');
            if (e.dataTransfer.files[0]) {
                handleFileUpload(e.dataTransfer.files[0]);
            }
        });

        function selectSource(mode) {
            const file = mode === 'file';
            document.getElementById('uploadPanel').hidden = !file;
            document.getElementById('textPasteSection').hidden = file;
            [['tabFile', file], ['tabPaste', !file]].forEach(([id, on]) => {
                const tab = document.getElementById(id);
                tab.classList.toggle('active', on);
                tab.setAttribute('aria-selected', String(on));
                // Roving tabindex: a tablist is one stop in the tab order, and the
                // arrow keys move between the tabs inside it.
                tab.tabIndex = on ? 0 : -1;
            });
        }

        document.querySelector('#sourcePicker .source-tabs').addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            e.preventDefault();
            const next = document.getElementById('tabFile').classList.contains('active') ? 'paste' : 'file';
            selectSource(next);
            document.getElementById(next === 'file' ? 'tabFile' : 'tabPaste').focus();
        });

        document.getElementById('libraryBtn').addEventListener('click', showLibrary);
        document.getElementById('newCourseBtn').addEventListener('click', showNewCourse);
        document.getElementById('emptyNewCourseBtn').addEventListener('click', showNewCourse);
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

            // The HUD hides itself when it has nothing to say, so it has to be
            // re-evaluated on every screen change and not only when the path renders.
            renderHud();

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
            setButtonBusy(btn, true);
            try {
                await processLearningMaterial(text, '', requestedCourseName(), null, worksheetMode);
            } finally {
                setButtonBusy(btn, false);
            }
        });

        document.getElementById('worksheetModeToggle').addEventListener('click', () => setWorksheetMode(!worksheetMode));

        // The title itself and the pencil beside it do the same thing — the pencil
        // exists so the affordance is visible without a caption explaining it.
        const renameActiveCourse = async () => {
            if (!activeCourseId || !courseData) return;
            await promptRename(activeCourseId, courseData.courseName);
        };
        document.getElementById('courseTitle').addEventListener('click', renameActiveCourse);
        document.getElementById('courseRenameBtn').addEventListener('click', renameActiveCourse);

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

        // ============= First run =============
        // What a new account used to get, one second after signing up, was an
        // empty upload box: a file picker, a paste tab, and no answer to the
        // only question a person actually has at that moment — what is this
        // going to do with my document, and why should I hand one over.
        //
        // This is the answer, said once. Three things the app does, two
        // questions worth asking (what you are here for, and what you are
        // interested in), and then a course to start with rather than a blank
        // field: a short piece of real material in a subject they just picked,
        // built through exactly the same pipeline as an upload. It runs on the
        // first sign-in and never again — the flag lives on the account, so a
        // second device does not repeat it — and it is skippable at every step,
        // because the fastest first run is the one belonging to someone who
        // already has a PDF open in the next tab.

        const ONBOARDING_STORAGE = 'onboarding';   // cache; the account row is the truth
        const onboardingKey = () => currentUser ? `${ONBOARDING_STORAGE}:${currentUser.id}` : ONBOARDING_STORAGE;

        // What the app does, in the order it does it. Said as three promises
        // rather than a feature list: nothing here names a screen or a button.
        //
        // Each carries a `visual` — the same spec shape a real lesson's cards
        // use, drawn by the same `renderVisual()` — so the promise is shown,
        // not just told, and the screen underneath it is filled with the one
        // thing this app already knows how to draw instead of empty space
        // waiting on nothing. No new asset, no illustration to keep on brand:
        // the diagram a real lesson would use IS the illustration here.
        const ONBOARDING_VALUES = [
            {
                icon: 'file',
                title: 'It teaches your material, not a syllabus',
                body: 'Give it a PDF, a chapter or a page of notes. It reads the whole thing, '
                    + 'finds the 10 to 20 ideas inside it, and puts them in the order they have to be learned.',
                visual: { type: 'flow', steps: ['Your document', '10–20 ideas found', 'Ordered by what to learn first'] },
            },
            {
                icon: 'star',
                title: 'Lessons you do, not lessons you read',
                body: 'Every idea becomes a short lesson: a question before the explanation, diagrams you can '
                    + 'drag, a worked example, a quiz. Every fact in it comes from your document.',
                visual: { type: 'compare',
                    left: { title: 'Reading', points: ['Paragraphs, top to bottom', 'You judge if it landed'] },
                    right: { title: 'This app', points: ['A question before the answer', 'Right or wrong, right away'] } },
            },
            {
                icon: 'refresh',
                title: 'It brings things back before you forget them',
                body: 'Each finished lesson is scheduled for review by how well it went — and the next lesson '
                    + 'opens with one question from whatever is closest to being forgotten.',
                visual: { type: 'timeline', events: [
                    { label: 'Day 1', text: 'Learned' }, { label: 'Day 3', text: 'Reviewed' },
                    { label: 'Day 7', text: 'Reviewed' }, { label: 'Day 21', text: 'Remembered' },
                ] },
            },
        ];

        // Why they are here. It does not gate anything — it is stored on the
        // account, shown back on the Account screen, and it is the difference
        // between two questions that feel like being met and one that feels
        // like a form.
        const ONBOARDING_GOALS = [
            { id: 'exam',     icon: 'cap', label: 'An exam or a course',     detail: 'Textbook chapters, lecture notes, past papers' },
            { id: 'work',     icon: 'briefcase', label: 'Something for work',      detail: 'A manual, a spec, a field you have just moved into' },
            { id: 'curious',  icon: 'compass', label: 'My own curiosity',        detail: 'No deadline, no exam — I just want to understand it' },
            { id: 'teaching', icon: 'chat', label: 'I teach or explain this', detail: 'Material I need to know well enough to hand on' },
        ];

        // The interests exist to choose a starter course, so every one of them
        // except `other` has one. Adding an interest without a starter would put
        // a card on the last screen that leads nowhere.
        const INTERESTS = [
            { id: 'math',    icon: 'shapes', label: 'Maths & logic' },
            { id: 'science', icon: 'atom', label: 'Physics & how things work' },
            { id: 'life',    icon: 'pulse', label: 'Biology & health' },
            { id: 'tech',    icon: 'chip', label: 'Computers & AI' },
            { id: 'money',   icon: 'coins', label: 'Money & business' },
            { id: 'mind',    icon: 'bulb', label: 'Mind & learning' },
            { id: 'other',   icon: 'sparkle', label: 'Something else' },
        ];

        // Six pieces of material, one per interest, each written to be exactly
        // what the pipeline is good at: prose, a few hundred words, ten or so
        // ideas in it that depend on each other. They are the *source document*
        // for a real course — planned, written and cached like any other, and
        // costing the same one course from the month's quota, which the last
        // screen says out loud rather than spending it quietly.
        const STARTER_COURSES = [
            {
                id: 'pythagoras',
                interest: 'math',
                icon: 'shapes',
                title: 'Right triangles and Pythagoras',
                blurb: 'The one rule that turns two sides of a triangle into the third — and the surprising number of things that are secretly a right triangle.',
                text: `A right triangle is a triangle with one angle of exactly 90 degrees. That single angle changes everything about it, because it fixes the relationship between the lengths of the three sides. The two sides that meet at the right angle are called the legs. The third side, opposite the right angle, is called the hypotenuse, and it is always the longest side of the triangle. That is not a coincidence: the largest angle in any triangle always faces the longest side, and in a right triangle the 90 degree angle is necessarily the largest, because the three angles of a triangle add to 180 degrees and two right angles would already use all of it.

The Pythagorean theorem says that in a right triangle, the square of the hypotenuse equals the sum of the squares of the two legs. If the legs are a and b, and the hypotenuse is c, then a squared plus b squared equals c squared. A triangle with legs of 3 and 4 has a hypotenuse of 5, because 9 plus 16 is 25, and 25 is 5 squared. A triangle with legs of 6 and 8 has a hypotenuse of 10. These whole number combinations are called Pythagorean triples, and 3-4-5, 5-12-13 and 8-15-17 are the ones worth recognising on sight, because they appear constantly in textbook problems and in building work.

The theorem works in both directions, and the second direction is the more useful one in practice. If you know the hypotenuse and one leg, you subtract instead of adding: the missing leg squared equals the hypotenuse squared minus the known leg squared. A ladder 5 metres long leaning against a wall, with its foot 3 metres out from the wall, reaches 4 metres up the wall, because 25 minus 9 is 16, and the square root of 16 is 4. Notice how easy it is to get this backwards. Adding 25 and 9 would give a wall height of about 5.8 metres, which is longer than the ladder itself — impossible, and a useful check. The hypotenuse can never be shorter than either leg.

The converse of the theorem is a test rather than a calculation. If the three sides of a triangle satisfy a squared plus b squared equals c squared, then that triangle must contain a right angle. Builders use this to square a corner without a protractor: measure 3 units along one wall, 4 units along the other, and adjust until the diagonal between those two marks is exactly 5 units. When it is, the corner is exactly 90 degrees. If the diagonal comes out longer than 5, the corner is open wider than a right angle; if it comes out shorter, the corner is too tight.

The same rule measures distance on a map or a graph. The straight line between two points is the hypotenuse of a right triangle whose legs are the horizontal and vertical gaps between them. Two points separated by 3 kilometres east and 4 kilometres north are 5 kilometres apart in a straight line, even though walking the two legs would cover 7 kilometres. That difference between the direct distance and the walked distance is why the theorem matters far outside geometry class: it is the arithmetic behind navigation, screen sizes measured on the diagonal, roof pitches, and the shortest path across any grid.

A common mistake is applying the theorem to a triangle that has no right angle. It simply does not hold there, and the number it produces is meaningless. Before using it, find the right angle and identify which side is opposite it — that side, and only that side, is the c in the formula.`,
            },
            {
                id: 'forces',
                interest: 'science',
                icon: 'atom',
                title: 'Forces, motion and why things speed up',
                blurb: "Newton's three laws, and what they say about a car braking, a rocket launching and a coffee cup sliding off a dashboard.",
                text: `Speed is how fast something is moving; velocity is how fast it is moving in a particular direction. The distinction sounds pedantic until something goes round a corner. A car driving round a roundabout at a steady 30 kilometres per hour has a constant speed but a constantly changing velocity, because its direction keeps changing. Acceleration is the rate at which velocity changes, so that car is accelerating even though the speedometer never moves. Acceleration also covers slowing down, which is simply acceleration in the direction opposite to the motion.

Newton's first law says that an object keeps doing whatever it is already doing — staying still, or moving in a straight line at a constant speed — unless a force acts on it. This is why a coffee cup slides forward off the dashboard when the car brakes. Nothing pushed the cup forward. The car slowed down and the cup, with no meaningful force acting on it, carried on at the speed it already had. The tendency of matter to resist changes in its motion is called inertia, and mass is the measure of it: the heavier the object, the more force it takes to change its motion.

Newton's second law makes that quantitative. The acceleration of an object equals the force applied to it divided by its mass, usually written as force equals mass times acceleration. Doubling the force doubles the acceleration; doubling the mass halves it. This is the law that explains why a loaded lorry takes far longer to stop than an empty one with the same brakes, and why the same engine makes a small car quicker than a large one.

Mass and weight are constantly confused, and the second law is what separates them. Mass is the amount of matter in an object and does not change. Weight is the force that gravity exerts on that mass, which is mass times the strength of gravity. An astronaut with a mass of 70 kilograms has the same mass on the Moon, but weighs about a sixth as much there, because the Moon pulls more weakly.

Newton's third law says that forces always come in pairs: if one object pushes on another, the second pushes back with equal size in the opposite direction. A rocket does not push against the ground or the air. It throws hot gas downwards, and the gas pushes the rocket upwards by exactly as much, which is why rockets work in the vacuum of space. When you walk, you push backwards on the ground and the ground pushes you forwards. The two forces in the pair act on different objects, which is why they do not simply cancel out.

Friction is the force that resists sliding between two surfaces in contact, and it always acts against the direction of motion. Friction is the reason a pushed box eventually stops, which for centuries made it look as though motion needed a continuous force to keep going. It does not — friction was the hidden force all along, and on an ice rink, where friction is small, the first law is easy to see.

Falling objects show all of this at once. Gravity accelerates everything near the Earth's surface at about 9.8 metres per second squared, regardless of mass, so in a vacuum a feather and a hammer fall side by side. In air, the feather is slowed by air resistance, a force that grows with speed. When air resistance grows large enough to balance the weight, the total force is zero, acceleration stops, and the object continues at a constant terminal velocity — which is what makes a parachute work.`,
            },
            {
                id: 'immune',
                interest: 'life',
                icon: 'pulse',
                title: 'How your immune system fights an infection',
                blurb: 'From the first barrier to the memory cells that make you immune — the week your body spends beating a virus, step by step.',
                text: `An infection begins when a pathogen — a bacterium, a virus, a fungus or a parasite — gets past the body's outer defences and starts to multiply. Those outer defences do most of the work and get none of the credit. Intact skin is a physical barrier that almost nothing crosses. Mucus in the airways traps particles, and tiny hairs called cilia sweep them back out. Stomach acid destroys most of what is swallowed. Tears and saliva carry enzymes that break bacterial cell walls apart.

Once something is through, the innate immune system responds. It is called innate because it is present from birth and does not need to have met the pathogen before, and it acts within minutes to hours. Damaged cells release chemical signals that widen nearby blood vessels and make them leaky, which is the inflammation you see as redness, heat and swelling. That leakiness lets white blood cells out of the bloodstream and into the tissue. Neutrophils arrive first and in enormous numbers, engulfing bacteria and dying in the process; the pus at an infected wound is largely spent neutrophils. Macrophages, larger and longer lived, engulf pathogens and debris and keep working for days.

Fever is part of this response rather than a side effect of it. The brain raises the body's set temperature in response to signals from immune cells, which slows the reproduction of many pathogens and speeds up immune cell activity. This is why suppressing a mild fever is not automatically helpful.

If the innate response cannot finish the job, the adaptive immune system takes over, and it works quite differently. It is specific: it targets one particular pathogen, recognised by molecules on its surface called antigens. A macrophage that has engulfed a pathogen displays fragments of its antigens on its own surface, effectively holding up a description of the intruder. Helper T cells read that description and coordinate the response, activating the two arms that do the damage.

B cells produce antibodies — proteins shaped to lock onto one specific antigen. Antibodies neutralise pathogens by sticking to them, clumping them together, blocking their entry into cells, and marking them so that macrophages destroy them. Killer T cells take a different route: they identify the body's own cells that have already been infected by a virus and destroy them, removing the factory rather than the product. This is necessary because a virus inside a cell is invisible to antibodies.

The adaptive response is powerful but slow the first time. Finding and multiplying the few B and T cells that happen to match a new pathogen takes about a week, which is roughly how long a first infection makes you ill.

The last step is what makes the whole system worth having. After the infection clears, a small population of memory B and T cells remains, already matched to that pathogen. If it returns, the response takes hours instead of days and is often finished before symptoms appear. That is immunity. Vaccines exploit it directly: they present the immune system with antigens — from a weakened or inactivated pathogen, a piece of one, or instructions for making a piece of one — so that memory cells are built without the illness that would otherwise be needed to build them.`,
            },
            {
                id: 'neural',
                interest: 'tech',
                icon: 'chip',
                title: 'How a neural network learns',
                blurb: 'Weights, loss and gradient descent — what is actually happening when a model is "trained", without the hype and without the calculus.',
                text: `A neural network is a function: numbers go in, numbers come out, and everything in between is arithmetic. What makes it interesting is that the arithmetic contains thousands or billions of adjustable numbers, called weights, and that there is a mechanical procedure for tuning those weights until the function does something useful.

The smallest unit is an artificial neuron. It takes several input numbers, multiplies each by its own weight, adds the results together along with a constant called a bias, and passes the total through an activation function. The activation function is what stops the whole network collapsing into simple multiplication: without it, stacking layers of neurons would be mathematically identical to a single layer, no matter how many you stacked. A common activation simply replaces negative totals with zero and leaves positive ones alone, which is enough to introduce the nonlinearity that lets a network represent complicated relationships.

Neurons are arranged in layers. The input layer holds the data — the pixel values of an image, say. Each hidden layer takes the previous layer's outputs as its inputs, and the output layer produces the answer, such as a score for each possible category. Passing data through in this direction is called the forward pass, and at the start, with weights set to random values, the answer it produces is nonsense.

Training needs a way to measure how wrong the answer is, and that measure is called the loss. A loss function compares the network's output with the correct answer from labelled training data and returns a single number: large when the prediction is far off, small when it is close. Training is the search for weights that make the average loss small across the whole training set.

The search method is gradient descent. For each weight, you ask how the loss would change if that weight increased slightly. That quantity is the gradient, and it points uphill; you move each weight a small step in the opposite direction, which reduces the loss slightly. Repeat this millions of times and the network descends towards a set of weights that works. The size of the step is called the learning rate, and it matters enormously: too small and training takes forever, too large and the steps overshoot the minimum and the loss bounces around instead of settling.

Backpropagation is what makes computing all those gradients affordable. Rather than testing each weight separately, it starts from the loss at the output and works backwards through the layers, using the chain rule to calculate every weight's contribution to the error in a single pass. The whole cycle — forward pass, loss, backward pass, weight update — is repeated over batches of examples, and one sweep through the training data is called an epoch.

The goal is never to do well on the training data. It is to do well on data the network has never seen, which is called generalisation. A network with enough capacity can memorise its training examples, achieving near-zero training loss while failing badly on anything new. This is overfitting, and it is why performance is always measured on a held-out validation set that the network never trains on. When training loss keeps falling while validation loss starts rising, the network has stopped learning the pattern and started memorising the examples — the point at which more training makes the model worse.`,
            },
            {
                id: 'interest',
                interest: 'money',
                icon: 'coins',
                title: 'Compound interest, loans and what a rate really costs',
                blurb: 'Why savings grow slowly then suddenly, why a credit card at 20% is worse than it sounds, and how to read a rate before you sign it.',
                text: `Interest is the price of money over time. If you lend money, interest is what you are paid for waiting; if you borrow, it is what you pay for not waiting. The amount you start with is called the principal, and the rate is expressed as a percentage per year.

Simple interest is calculated only on the original principal. Put 1,000 into an account paying 5% simple interest and you receive 50 every year, forever: 50 in year one, 50 in year twenty. Compound interest is calculated on the principal plus the interest already earned. The same 1,000 at 5% compound earns 50 in the first year, but 52.50 in the second, because the second year's interest is calculated on 1,050. After ten years the simple account holds 1,500 and the compound account holds about 1,629. After forty years, the gap is enormous: 3,000 against about 7,040.

That shape — flat for years, then steep — is why compound growth is so consistently underestimated. The growth is exponential rather than linear, and most of the total arrives late. A useful shortcut is the rule of 72: divide 72 by the annual percentage rate and you get roughly the number of years for the money to double. At 6%, money doubles in about twelve years. At 12%, about six.

How often interest is added matters too. A rate of 12% per year added monthly is 1% each month applied to a growing balance, which comes to about 12.68% over the year rather than 12%. This is the difference between a nominal rate and an effective rate. Advertised loan rates are often quoted in ways that hide this, which is exactly what the standardised figures exist to prevent: an APR on a loan is meant to include compounding and mandatory fees, so that two offers can be compared honestly.

Loans run the same arithmetic backwards. A repayment loan is priced so that a fixed monthly payment covers the interest accrued that month and repays part of the principal as well. Early on, most of the payment is interest, because the balance is large; late on, most of it is principal. This is why paying an extra amount early in a mortgage saves far more than the same amount paid near the end — the early payment removes principal that would otherwise have accrued interest for decades.

Credit cards are where compounding does the most damage, because the rate is high and the compounding is monthly. A balance of 3,000 at 20% APR, paid off at the minimum of about 2% of the balance each month, takes well over twenty years to clear and costs more in interest than the original purchase. The minimum payment is set close to the monthly interest, so almost nothing comes off the principal.

Two adjustments are needed to judge any return honestly. The first is inflation: a savings account paying 3% while prices rise 4% is losing about 1% of purchasing power a year, and only that real return matters. The second is fees, which compound exactly as returns do — an annual charge of 1% on an investment growing at 7% removes roughly a fifth of the final balance over thirty years, even though 1% sounds negligible next to 7%.`,
            },
            {
                id: 'memory',
                interest: 'mind',
                icon: 'bulb',
                title: 'Why you forget, and how spacing fixes it',
                blurb: 'The forgetting curve, retrieval practice and interleaving — the small number of study habits that are actually supported by evidence.',
                text: `Remembering has three stages, and study advice that ignores the difference between them tends to fail. Encoding is getting information in; storage is holding it over time; retrieval is getting it back out when you need it. Most study failures are not failures of storage. The material is still in there — it simply cannot be reached under the conditions of an exam, which is a retrieval failure.

Forgetting is fastest immediately after learning and slows down afterwards. Hermann Ebbinghaus mapped this in the 1880s by memorising nonsense syllables and testing himself at intervals, producing the forgetting curve: a steep drop in the first day, then a long, shallow tail. The practical consequence is that the timing of the second exposure matters more than its length. A short review the next day is worth more than three times as long a review a fortnight later, once most of the material has already gone.

Each successful review flattens the curve. After the first review, forgetting is slower; after the second, slower again. This is the basis of spaced repetition, in which the gap between reviews grows each time a piece of material is recalled successfully — a day, then three days, then a week, then a month. The gaps are the point. Reviewing something you still remember perfectly teaches you very little, so the schedule aims to bring material back just as it is starting to slip.

How you review matters as much as when. Rereading notes produces a strong feeling of familiarity and very little durable memory, because recognising something is not the same as being able to produce it. Trying to recall the material without looking — retrieval practice — is far more effective, and this is called the testing effect. The effort of retrieval is what strengthens the trace, so an attempt that ends in failure, followed by seeing the correct answer, still beats rereading. This is deeply counterintuitive: the strategy that feels least productive during study is the one that produces the best results at test.

Robert Bjork's term for this is desirable difficulty. Conditions that make learning feel slower and harder — spacing sessions out, testing rather than reviewing, mixing topics together — tend to produce better long-term retention, while conditions that make it feel easy produce fast gains that disappear. Fluency during study is a poor predictor of memory later.

Interleaving is the mixing part. Practising one type of problem twenty times in a row (blocked practice) feels efficient and produces good performance within the session, but the learner is really practising the execution of a method they have already been told to use. Mixing problem types forces you to work out which method applies, which is the harder skill and the one an exam actually tests.

Cramming does work, briefly. Massed study before an exam can produce a decent grade the next morning and almost nothing a month later, which is why material crammed for one exam has to be relearned from scratch for the next.

Two other factors do real work. Sleep consolidates memories — the hours after studying are part of the learning, not a pause in it. And memory is cue-dependent: what you can recall depends on the cues available when you try. Studying in varied contexts, and practising with the kind of prompts you will face later, gives a memory more routes back to the surface.`,
            },
        ];

        // A topic with no document behind it. The app writes a few hundred
        // words about it and then treats those words exactly as it treats an
        // upload: same suitability gate, same concept extraction, same
        // excerpt-grounded lessons. A bare topic string cannot go through that
        // pipeline; a piece of real prose about it can.
        //
        // Six hundred words, not the nine hundred that would be nicer: the
        // server caps anything under the course threshold at 1000 output
        // tokens, and material that stops mid-sentence is what the learner
        // would then be taught from. What does arrive is trimmed back to its
        // last full stop for the same reason.
        async function generateInterestPrimer(topic) {
            const prompt = `Write an introduction to "${topic}" for someone meeting it for the first time.

Cover its core ideas, the terms someone needs, how it shows up in everyday life, and two or three concrete examples. Plain prose in paragraphs — no headings, no bullet points, no markdown. 450-600 words. Write only the material itself, nothing about a course or about writing it.`;
            const text = await callAI(prompt, '', { maxTokens: MAX_TOKENS.primer, task: 'primer', quiet: true });
            if (!text) return '';
            const end = Math.max(text.lastIndexOf('.'), text.lastIndexOf('!'), text.lastIndexOf('?'));
            return end > 200 ? text.slice(0, end + 1) : text;
        }

        // Which starters to offer, given what they picked. Their own interests
        // first, in the order the tiles are laid out, then whatever else is
        // needed to make up three — a screen offering one card looks like the
        // app has one course in it.
        function starterPicks(interests, max = 3) {
            const chosen = new Set(interests || []);
            const mine = STARTER_COURSES.filter(s => chosen.has(s.interest));
            const rest = STARTER_COURSES.filter(s => !chosen.has(s.interest));
            return [...mine, ...rest].slice(0, max);
        }

        // What the Account screen shows for the answers given during the first
        // run. An answer nobody can see afterwards, and nobody can change, is a
        // question that should not have been asked.
        function interestSummary() {
            const picked = (onboarding.interests || [])
                .map(id => INTERESTS.find(i => i.id === id))
                .filter(Boolean)
                .map(i => i.label);
            if (!picked.length) return 'Not set yet — tap to pick your subjects and see the intro again';
            const shown = picked.slice(0, 3).join(', ');
            const more = picked.length - 3;
            return `${shown}${more > 0 ? ` and ${more} more` : ''} — tap to change`;
        }

        // { done, goal, interests, completedAt, skipped } — what the account
        // remembers about its first run.
        let onboarding = { done: false };
        // The live wizard, only while it is on screen.
        let onboardingRun = null;
        let onboardingRelease = null;

        // What the app does used to be one screen with all three promises
        // listed on it — read once, top to bottom, the way a feature list is
        // read rather than the way this app teaches anything. One promise per
        // step instead: each gets the same weight a lesson card gets, and the
        // Continue button is the same motion the rest of the intro already
        // asks for. `VALUE_STEPS` are the value indices in step order; the
        // step id itself (`value0`, `value1`, …) is what onboardingBody()
        // switches on.
        const VALUE_STEPS = ONBOARDING_VALUES.map((_, i) => `value${i}`);
        const ONBOARDING_STEPS = [...VALUE_STEPS, 'goal', 'interests', 'starter'];

        function readLocalOnboarding() {
            try {
                const raw = JSON.parse(localStorage.getItem(onboardingKey()) || 'null');
                return raw && typeof raw === 'object' ? raw : null;
            } catch (_) { return null; }
        }

        function writeLocalOnboarding(state) {
            try { localStorage.setItem(onboardingKey(), JSON.stringify(state)); } catch (_) {}
        }

        // Local first, because it is instant and because it is what keeps the
        // intro from flashing up on a slow connection. The row is the truth for
        // a second device, and a failure to read it — including the case where
        // the column has not been deployed yet — leaves the cache in charge
        // rather than replaying the intro at someone who has already seen it.
        async function loadOnboarding() {
            const local = readLocalOnboarding();
            onboarding = local || { done: false };
            if (!currentUser || onboarding.done) return onboarding;

            const { data, error } = await supabaseClient
                .from('user_stats')
                .select('onboarding')
                .eq('user_id', currentUser.id)
                .maybeSingle();
            if (error) {
                console.error('loadOnboarding failed:', error);
                return onboarding;
            }
            const remote = data && data.onboarding;
            if (remote && remote.done) {
                onboarding = remote;
                writeLocalOnboarding(remote);
            }
            return onboarding;
        }

        // Fire-and-forget, like saveStreak: the cache is already correct, and a
        // write that fails costs one repeated intro on another device.
        async function saveOnboarding(state) {
            onboarding = state;
            writeLocalOnboarding(state);
            if (!currentUser) return;
            const { error } = await supabaseClient.from('user_stats').upsert({
                user_id: currentUser.id,
                onboarding: state,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'user_id' });
            if (error) console.error('saveOnboarding failed:', error);
        }

        // Called once per sign-in, after the library has loaded. An account with
        // courses in it is not a new account — someone who signed up before this
        // existed gets the flag written silently instead of a tour of an app
        // they have already been using.
        async function maybeShowOnboarding() {
            if (!currentUser) return false;
            const state = await loadOnboarding();
            if (state.done) return false;
            if (library.length) {
                saveOnboarding({ done: true, completedAt: Date.now(), skipped: 'had-courses' });
                return false;
            }
            // Whatever is underneath is going to be uncovered the moment this
            // closes, so put it in the state it should be in when that happens.
            setScreen('home');
            startOnboarding();
            return true;
        }

        // `steps` lets a caller run a subset of the wizard rather than the
        // full first-run tour — see the Account "What you're interested in"
        // row, which only wants the one screen it names.
        function startOnboarding({ replay = false, resume = null, steps = ONBOARDING_STEPS } = {}) {
            onboardingRun = resume || {
                step: 0,
                goal: onboarding.goal || null,
                // Only the first survives: an account that picked several
                // before this became single-select would otherwise reopen
                // with every one of its old picks still highlighted.
                interests: Array.isArray(onboarding.interests) && onboarding.interests.length
                    ? [onboarding.interests[0]] : [],
                starter: null,
                topic: '',
                replay,
                steps,
            };
            const screen = document.getElementById('onboardingScreen');
            screen.hidden = false;
            screen.setAttribute('aria-hidden', 'false');
            document.body.classList.add('onboarding-open');
            requestAnimationFrame(() => screen.classList.add('open'));
            renderOnboarding();
            // The step content, not the button at the bottom: this is where a
            // screen reader should start reading, and it is what every later
            // step moves focus back to.
            onboardingRelease = trapFocus(screen, document.getElementById('onbScroll'));
        }

        function closeOnboarding() {
            const screen = document.getElementById('onboardingScreen');
            screen.classList.remove('open');
            screen.setAttribute('aria-hidden', 'true');
            document.body.classList.remove('onboarding-open');
            if (onboardingRelease) { onboardingRelease(); onboardingRelease = null; }
            onboardingRun = null;
            // Matches --dur-3; hiding it outright would cut the exit animation.
            setTimeout(() => { screen.hidden = true; }, 240);
        }

        function onboardingStepId() {
            return onboardingRun.steps[onboardingRun.step];
        }

        // The one rule for the footer button: a step that asks a question is not
        // finished until it has an answer. Nothing here is compulsory — Skip is
        // in the topbar throughout — but a disabled Continue is what says "this
        // one is waiting on you" without a line of error text.
        function onboardingCanContinue() {
            const step = onboardingStepId();
            if (step === 'goal') return !!onboardingRun.goal;
            if (step === 'interests') return onboardingRun.interests.length > 0;
            if (step === 'starter') return !!(onboardingRun.starter || (onboardingRun.topic || '').trim());
            return true;
        }

        function onboardingNextLabel() {
            const step = onboardingStepId();
            if (step === 'starter') return 'Build this course';
            // The last step of a short flow (interests, from Account) saves
            // and returns rather than moving on — "Continue" would promise a
            // next screen that isn't coming.
            if (onboardingRun.step === onboardingRun.steps.length - 1) return 'Save';
            return 'Continue';
        }

        function onboardingBody() {
            const step = onboardingStepId();

            const valueAt = VALUE_STEPS.indexOf(step);
            if (valueAt >= 0) {
                const v = ONBOARDING_VALUES[valueAt];
                const isFirst = valueAt === 0;
                const isLast = valueAt === ONBOARDING_VALUES.length - 1;
                return `
                    ${isFirst ? '<p class="onb-kicker">Anything you\'re studying, as a course you can do</p>' : ''}
                    <div class="onb-value-solo">
                        <span class="onb-value-solo-icon">${ICONS[v.icon]}</span>
                        <h2 class="onb-title">${esc(v.title)}</h2>
                        <p class="onb-lede">${esc(v.body)}</p>
                        ${renderVisual(v.visual)}
                    </div>
                    ${isLast ? `
                        <p class="onb-foot-note">Two quick questions next, then a course to start on. Under a minute.</p>
                        <button type="button" class="button button-ghost button-block" id="onbTryDemo">
                            Or see a two-minute example lesson first
                        </button>` : ''}`;
            }

            if (step === 'goal') {
                return `
                    <h2 class="onb-title">What are you learning for?</h2>
                    <p class="onb-lede">One tap. It shapes what we suggest, and you can change it later.</p>
                    <div class="options">
                        ${ONBOARDING_GOALS.map(g => `
                            <button type="button" class="option onb-choice${onboardingRun.goal === g.id ? ' picked' : ''}"
                                    data-goal="${g.id}" aria-pressed="${onboardingRun.goal === g.id}">
                                <span class="onb-icon">${ICONS[g.icon]}</span>
                                <span class="onb-choice-text">
                                    <strong>${esc(g.label)}</strong>
                                    <span>${esc(g.detail)}</span>
                                </span>
                            </button>`).join('')}
                    </div>`;
            }

            if (step === 'interests') {
                const n = onboardingRun.interests.length;
                // The whole point of picking is stated in the lede ("it decides
                // which course we offer you") but used to stay an unverifiable
                // claim until the last screen — a tap here just toggled a
                // highlight with nothing to show for it. Naming the actual
                // pick, live, off the same `starterPicks()` the last screen
                // itself calls, makes each tap visibly do something instead
                // of only looking pressed.
                const preview = n ? starterPicks(onboardingRun.interests, 1)[0] : null;
                return `
                    <h2 class="onb-title">What are you interested in?</h2>
                    <p class="onb-lede">Pick one — it decides which course we offer you to start on.</p>
                    <div class="onb-grid">
                        ${INTERESTS.map(i => {
                            const on = onboardingRun.interests.includes(i.id);
                            return `
                            <button type="button" class="option onb-tile${on ? ' picked' : ''}"
                                    data-interest="${i.id}" aria-pressed="${on}">
                                <span class="onb-tile-icon">${ICONS[i.icon]}</span>
                                <span class="onb-tile-label">${esc(i.label)}</span>
                            </button>`;
                        }).join('')}
                    </div>
                    ${preview ? `
                    <div class="onb-preview" role="status">
                        <span class="onb-preview-label">You'll be offered</span>
                        <strong class="onb-preview-title">${esc(preview.title)}</strong>
                    </div>` : `<p class="onb-count" role="status">Tap one to see what it unlocks</p>`}`;
            }

            // starter
            const picks = starterPicks(onboardingRun.interests);
            return `
                <h2 class="onb-title">Start with one of these</h2>
                <p class="onb-lede">A short piece of real material, in a subject you picked — built into a
                   course exactly the way your own PDF would be, and yours to keep, rename or delete.</p>
                <div class="onb-starters">
                    ${picks.map(s => `
                        <button type="button" class="option onb-starter${onboardingRun.starter === s.id ? ' picked' : ''}"
                                data-starter="${s.id}" aria-pressed="${onboardingRun.starter === s.id}">
                            <span class="onb-icon">${ICONS[s.icon]}</span>
                            <span class="onb-choice-text">
                                <strong>${esc(s.title)}</strong>
                                <span>${esc(s.blurb)}</span>
                            </span>
                        </button>`).join('')}
                </div>
                <div class="onb-topic">
                    <label class="field-label" for="onbTopicInput">Or name any subject at all</label>
                    <input type="text" id="onbTopicInput" class="auth-input" maxlength="60" autocomplete="off"
                           placeholder="e.g. Roman roads, options trading, sourdough"
                           value="${escAttr(onboardingRun.topic || '')}" />
                    <p class="field-hint">No document needed — the app writes the material, then builds the
                       course from it the same way.</p>
                </div>
                <p class="onb-foot-note">Building it takes about a minute and uses one course from your plan,
                   exactly like uploading your own material would.</p>
                <button type="button" class="button button-ghost button-block" id="onbOwnMaterial">
                    I'd rather upload my own material
                </button>`;
        }

        function renderOnboarding() {
            if (!onboardingRun) return;

            const bar = document.getElementById('onbStepBar');
            // A one-screen flow (editing interests from Account) has nothing
            // for a progress bar to show progress through.
            bar.hidden = onboardingRun.steps.length <= 1;
            bar.innerHTML = onboardingRun.steps.map((_, i) =>
                `<span class="step-segment${i < onboardingRun.step ? ' filled' : i === onboardingRun.step ? ' current' : ''}"></span>`
            ).join('');
            bar.setAttribute('aria-label', `Step ${onboardingRun.step + 1} of ${onboardingRun.steps.length}`);

            document.getElementById('onbBack').hidden = onboardingRun.step === 0;

            const body = document.getElementById('onbBody');
            body.innerHTML = onboardingBody();
            body.classList.remove('onb-enter');
            void body.offsetWidth;               // restart the animation on every step
            body.classList.add('onb-enter');
            document.getElementById('onbScroll').scrollTop = 0;

            const next = document.getElementById('onbNext');
            next.textContent = onboardingNextLabel();
            next.disabled = !onboardingCanContinue();

            body.querySelectorAll('[data-goal]').forEach(btn => {
                btn.onclick = () => { onboardingRun.goal = btn.dataset.goal; renderOnboarding(); };
            });
            body.querySelectorAll('[data-interest]').forEach(btn => {
                // One at a time: picking a tile replaces whatever was picked
                // before rather than adding to it, so exactly one tile — the
                // one just tapped — ever carries the highlight. Tapping the
                // same tile again clears it, the same way a single-answer
                // question elsewhere in this wizard would.
                btn.onclick = () => {
                    const id = btn.dataset.interest;
                    onboardingRun.interests = onboardingRun.interests[0] === id ? [] : [id];
                    renderOnboarding();
                };
            });
            body.querySelectorAll('[data-starter]').forEach(btn => {
                btn.onclick = () => {
                    onboardingRun.starter = btn.dataset.starter;
                    onboardingRun.topic = '';
                    renderOnboarding();
                };
            });
            // Typing is the other way to answer this step, so it clears the
            // chosen card — but it must not re-render, or the field would be
            // replaced (and the cursor lost) on every keystroke. It updates the
            // two things a re-render would have: the selection and the button.
            const topicInput = document.getElementById('onbTopicInput');
            if (topicInput) topicInput.oninput = () => {
                onboardingRun.topic = topicInput.value;
                if (topicInput.value.trim() && onboardingRun.starter) {
                    onboardingRun.starter = null;
                    body.querySelectorAll('[data-starter]').forEach(b => {
                        b.classList.remove('picked');
                        b.setAttribute('aria-pressed', 'false');
                    });
                }
                next.disabled = !onboardingCanContinue();
            };
            const own = document.getElementById('onbOwnMaterial');
            if (own) own.onclick = () => finishOnboarding({ starterId: null });
            const demo = document.getElementById('onbTryDemo');
            if (demo) demo.onclick = pauseOnboardingForDemo;
        }

        function onboardingNext() {
            if (!onboardingRun || !onboardingCanContinue()) return;
            if (onboardingStepId() === 'starter') {
                const topic = cleanTitle(onboardingRun.topic);
                finishOnboarding(topic ? { topic } : { starterId: onboardingRun.starter });
                return;
            }
            // A short flow (e.g. just 'interests', from Account) ends on
            // whatever its last step is rather than always on 'starter' —
            // finishing here saves the answer and returns instead of running
            // off the end of a shorter step list into a course-building step
            // nobody asked to reach.
            if (onboardingRun.step === onboardingRun.steps.length - 1) {
                finishOnboarding();
                return;
            }
            onboardingRun.step++;
            renderOnboarding();
            document.getElementById('onbScroll').focus();
        }

        function onboardingBack() {
            if (!onboardingRun || onboardingRun.step === 0) return;
            onboardingRun.step--;
            renderOnboarding();
            document.getElementById('onbScroll').focus();
        }

        // The one exit. Whatever answers exist at this point are worth keeping —
        // someone who skips on the last screen still told us two things — and
        // the flag is written either way, because an intro that reappears after
        // being dismissed is worse than one that was never shown.
        async function finishOnboarding({ starterId = null, topic = '', skipped = false } = {}) {
            const run = onboardingRun;
            if (!run) return;
            closeOnboarding();

            if (!run.replay || !onboarding.done) {
                await saveOnboarding({
                    done: true,
                    goal: run.goal || null,
                    interests: run.interests,
                    completedAt: Date.now(),
                    ...(skipped ? { skipped: true } : {}),
                });
            } else {
                // A replay only updates the answers; it must not rewrite the
                // date the account actually finished its first run.
                await saveOnboarding({ ...onboarding, goal: run.goal || null, interests: run.interests });
            }

            const starter = starterId ? STARTER_COURSES.find(s => s.id === starterId) : null;
            if (starter) {
                await processLearningMaterial(starter.text, starter.title, starter.title);
                return;
            }
            if (topic) {
                // The one build that has to write its own material first. It is
                // the same overlay the upload path uses, one stage earlier.
                showStages(BUILD_STAGES, 'read');
                showMessage(`Writing material on ${topic}…`);
                const primer = await generateInterestPrimer(topic);
                if (!primer) {
                    hideMessage();
                    showError(`Couldn't put together material on "${topic}". Try another subject, or upload your own document.`);
                    setScreen('home');
                    return;
                }
                await processLearningMaterial(primer, topic, topic);
                return;
            }
            if (run.replay) { renderAccount(); return; }
            setScreen('home');
            if (!skipped) toast('Upload a PDF or paste a chapter to begin', 'info');
        }

        // The second value screen claims lessons are something you do rather
        // than read. The demo is that claim, checked, and it costs nothing — so
        // the first run steps aside for it and picks up exactly where it left off.
        let onboardingPaused = null;

        function pauseOnboardingForDemo() {
            onboardingPaused = onboardingRun;
            closeOnboarding();
            startDemoLesson();
        }

        function resumeOnboardingFromDemo() {
            const run = onboardingPaused;
            onboardingPaused = null;
            startOnboarding({ resume: run });
        }

        document.getElementById('onbNext').addEventListener('click', onboardingNext);
        document.getElementById('onbBack').addEventListener('click', onboardingBack);
        document.getElementById('onbSkip').addEventListener('click', () => finishOnboarding({ skipped: true }));

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
            document.getElementById('authTabIn').setAttribute('aria-pressed', String(!isUp));
            document.getElementById('authTabUp').setAttribute('aria-pressed', String(isUp));
            document.getElementById('authTitle').textContent = isUp ? 'Create your account' : 'Welcome back';
            document.getElementById('authSubtitle').textContent = isUp
                ? 'Fourteen days free, no card. Your courses sync to every device you sign in on.'
                : 'Your courses, progress and review schedule live on your account.';
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
            document.getElementById('authForgotBtn').closest('.auth-forgot-row').hidden = isUp;
        }

        // Checkout isn't wired up yet (no Stripe), but the tiers are real — the
        // Edge Function already enforces them. Showing what each one is beats a
        // one-line "coming soon" that leaves you with nothing to do: the things
        // that still work without paying are spelled out at the bottom.
        // Not a security boundary — the real gate is inside debug_set_plan
        // itself, which checks the caller's own account against this same
        // address on the server and refuses everyone else. This is only
        // whether the button is worth drawing.
        const DEBUG_PLAN_EMAIL = 'mayangabinet@gmail.com';

        function canDebugPlan() {
            return (currentUser?.email || '').trim().toLowerCase() === DEBUG_PLAN_EMAIL;
        }

        // A stand-in for checkout, which does not exist yet (see README). One
        // account gets to try the tiers directly; everyone else sees the same
        // "checkout isn't live" plan list this always showed.
        async function setDebugPlan(planKey, button) {
            const original = button.textContent;
            button.disabled = true;
            button.textContent = 'Switching…';
            const { error } = await supabaseClient.rpc('debug_set_plan', { new_plan: planKey });
            if (error) {
                button.disabled = false;
                button.textContent = original;
                showError('Could not switch plan: ' + error.message);
                return;
            }
            await Promise.all([loadEntitlement(), refreshUsage()]);
            document.getElementById('dialogConfirm')?.click();   // close, then reopen fresh
            showUpgradePrompt();
            if (document.getElementById('accountBody')) renderAccount();
        }

        // The tier most accounts should actually want: real model quality
        // without Max's price. Marked, not sold — there's no checkout yet to
        // steer toward, just a clearer read of which card is "the" one.
        const RECOMMENDED_PLAN = 'pro';

        function showUpgradePrompt() {
            const rows = Object.entries(PLAN_LIMITS)
                .filter(([key]) => key !== 'trial')
                .map(([key, p]) => {
                    const here = entitlement && !entitlement.trialing && entitlement.planKey === key;
                    // Roughly 1,800 characters to a printed page — close enough to
                    // turn an abstract character budget into something you can
                    // picture against the document you were about to upload.
                    const pages = Math.round(p.readChars / 1800);
                    const debugBtn = canDebugPlan() && !here
                        ? `<button type="button" class="button button-secondary plan-debug-btn" data-debug-plan="${key}">Switch to ${p.label} (debug)</button>`
                        : '';
                    const badge = here
                        ? '<span class="plan-card-badge is-current">Your plan</span>'
                        : key === RECOMMENDED_PLAN
                            ? '<span class="plan-card-badge">Most popular</span>'
                            : '';
                    const features = [
                        `${p.courses} course${p.courses === 1 ? '' : 's'} a month`,
                        `up to ${p.lessonsPerCourse} lessons each`,
                        p.depth,
                        `reads about ${pages} page${pages === 1 ? '' : 's'} of your document when planning the course`,
                    ].map(f => `<li>${ICONS.check}<span>${f}</span></li>`).join('');
                    return `
                        <li class="plan-card${here ? ' is-current' : ''}">
                            <div class="plan-card-head"><strong>${p.label}</strong>${badge}</div>
                            <ul class="plan-card-features">${features}</ul>
                            ${debugBtn}
                        </li>`;
                }).join('');

            const debugNote = canDebugPlan()
                ? `<p class="plan-debug-note">Debug buttons are visible only on this account — they switch your
                   real plan row directly, no payment involved, so quotas and models change for real.</p>`
                : '';

            uiAlert(
                `<ul class="plan-list">${rows}</ul>
                 ${debugNote}
                 <p>Checkout isn't live yet, so there's nothing to buy today. Until it is,
                 everything you've already built keeps working: open any course, replay any
                 lesson, and run reviews and extra practice as often as you like — replays
                 and reviews reuse lessons you already generated and don't count against
                 any limit.</p>`,
                entitlement?.trialing ? 'Plans' : 'Your trial has ended',
                { html: true });

            // Wired after the dialog's own promise is created but not awaited —
            // openDialog fills the DOM synchronously before returning it.
            document.querySelectorAll('[data-debug-plan]').forEach(btn => {
                btn.onclick = () => setDebugPlan(btn.dataset.debugPlan, btn);
            });
        }

        // Set by any gated action (building a course, opening the library, etc.)
        // when it hits the auth wall — resumed automatically right after sign-in,
        // so the person never has to redo what they were already doing.
        // A plain serializable descriptor, not a closure — so it can also
        // survive the full-page redirect an OAuth sign-in does (stashed in
        // sessionStorage right before redirecting, restored on return).
        let pendingAction = null;

        async function runPendingAction(action) {
            if (action.type === 'buildCourse') return processLearningMaterial(action.text, action.title, action.chosenName, action.structure, action.worksheet);
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
            flushReports();

            if (pendingAction) {
                const action = pendingAction;
                pendingAction = null;
                await refreshUsage();
                await runPendingAction(action);
                loadDueOverview().then(() => { renderReviewBanner(); renderHud(); });
                return;
            }

            try {
                // Different tables, neither read by the other — usage is only
                // consulted later (the quota warning, the account screen), so
                // nothing between here and there needs to wait for it specifically.
                await Promise.all([refreshUsage(), loadLibrary()]);
                // First sign-in on this account: say what the app does before
                // handing over an empty upload box. It decides for itself
                // whether it has anything to say, and takes the screen when it
                // does — so nothing below should choose a screen as well.
                if (await maybeShowOnboarding()) {
                    loadDueOverview().then(() => { renderReviewBanner(); renderHud(); });
                    return;
                }
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
            activeStructure = null;
            library = [];
            pendingAction = null;
            entitlement = null;
            dueOverview = null;
            xpByCourse = {};
            // The streak is the signed-out person's, not the one who just left —
            // it reloads from their own row (and their own cache) at next sign-in.
            streak = { count: 0, lastActive: null };
            // Same reasoning as the streak: the next person to sign in on this
            // browser gets their own first run, not the last one's.
            onboarding = { done: false };
            document.getElementById('signInPromptBtn').hidden = false;
            // Left over from the signed-in session: a "back to my courses" button
            // that now only leads to the sign-in wall.
            document.getElementById('backToLibraryBtn').hidden = true;
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
            const emailEl = document.getElementById('authEmail');
            const passwordEl = document.getElementById('authPassword');
            const email = emailEl.value.trim();
            const password = passwordEl.value;
            const isUp = document.getElementById('authTabUp').classList.contains('active');
            const err = document.getElementById('authError');
            err.className = 'error-message';
            err.hidden = true;
            // The message says what's wrong; the field says *where*. Marking the
            // field is also what tells someone using a magnifier which box to fix.
            [emailEl, passwordEl].forEach(el => {
                el.classList.remove('is-invalid');
                el.removeAttribute('aria-invalid');
            });
            const markInvalid = (el, message) => {
                el.classList.add('is-invalid');
                el.setAttribute('aria-invalid', 'true');
                err.textContent = message;
                err.hidden = false;
                el.focus();
            };

            if (!email) return markInvalid(emailEl, 'Enter the email address for your account.');
            if (!password) return markInvalid(passwordEl, 'Enter your password.');
            if (isUp && password.length < 6) {
                return markInvalid(passwordEl, 'Pick a password of at least 6 characters.');
            }

            const btn = document.getElementById('authSubmitBtn');
            setButtonBusy(btn, true);
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
                setButtonBusy(btn, false);
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
        applyTheme();

        // Static icon slots that never change — filled once here rather than
        // duplicating the SVG markup inline in the HTML.
        const staticIcons = {
            hudIconStreak: 'flame', hudIconXp: 'star',
            libraryEmptyIcon: 'book', uploadIcon: 'file', reviewBannerIcon: 'refresh', demoLessonIcon: 'book',
            navIconHome: 'home', navIconCourses: 'book', navIconReview: 'refresh', navIconAccount: 'account',
            authCloseBtn: 'x', courseRenameBtn: 'pencil',
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
