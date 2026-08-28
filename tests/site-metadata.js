/*
 * The static half of the site: the files a crawler and a link asks for, rather
 * than anything the app does once it is running.
 *
 *     node tests/site-metadata.js
 *
 * All of this is the kind of thing that breaks silently. A renamed page leaves
 * a dead link in four footers and nothing throws; a reworded FAQ answer leaves
 * the JSON-LD quoting text that is no longer on the page, which is a rich-result
 * policy violation rather than a bug; an edited inline <script> leaves a CSP
 * hash that no longer matches, and the theme flash and the signed-out pitch both
 * stop working with no error anywhere. None of it shows up in a browser test of
 * the upload box, so it is checked here, from the files themselves.
 *
 * Deliberately no HTML parser and no dependencies — same as every other suite
 * in this directory, which lift what they need out of the shipping source with
 * a regex and assert on it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(root, f));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
}

// Every page a visitor can land on. 404.html is served by GitHub Pages for any
// unknown path; thanks.html is where Grow returns a payer.
const ALL_PAGES = ['index.html', 'privacy.html', 'terms.html', 'thanks.html', '404.html'];

// Checked first and separately. A deleted or renamed page is the single most
// likely thing to break everything below it, and every later check read()s
// these files — without this the suite dies on an ENOENT stack trace instead of
// saying which page went missing. Whatever survives is what the rest runs over,
// so one missing page reports as one clear failure rather than a crash.
console.log('== every page still exists ==');
for (const f of ALL_PAGES) ok(`${f} exists`, exists(f));
const PAGES = ALL_PAGES.filter(exists);

console.log('\n== the files a crawler asks for by name ==');
for (const f of ['robots.txt', 'sitemap.xml', 'site.webmanifest', 'og-image.png',
                 'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png',
                 'icon-192.png', 'icon-512.png']) {
    ok(`${f} exists`, exists(f));
}
{
    const robots = read('robots.txt');
    ok('robots.txt points at the sitemap', /^Sitemap:\s*https:\/\/\S+\/sitemap\.xml$/m.test(robots));
    ok('robots.txt allows crawling', /^User-agent:\s*\*/m.test(robots) && /^Allow:\s*\//m.test(robots));

    const sitemap = read('sitemap.xml');
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    ok('the sitemap lists at least the home page', locs.length >= 1, locs.join(', '));
    // A noindex page in a sitemap is a contradiction: it asks Google to crawl a
    // URL it has been told to drop. This is the check that catches someone
    // adding thanks.html to the sitemap because it looked like a missing page.
    const noindexed = PAGES.filter(f => /<meta name="robots" content="noindex/.test(read(f)));
    for (const f of noindexed) {
        ok(`${f} is noindex, so it stays out of the sitemap`,
           !locs.some(l => l.endsWith('/' + f)));
    }
}

console.log('\n== titles and descriptions ==');
{
    const seenTitles = new Map();
    for (const f of PAGES) {
        const html = read(f);
        const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1];
        const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1];
        ok(`${f} has a <title>`, !!title && title.trim().length > 0);
        ok(`${f} has a meta description`, !!desc && desc.trim().length > 0);
        // Long descriptions are truncated in results; short ones say nothing.
        ok(`${f}'s description is a usable length`,
           !!desc && desc.length >= 50 && desc.length <= 200, desc && `${desc.length} chars`);
        if (title) {
            const prev = seenTitles.get(title);
            ok(`${f}'s title is unique to it`, !prev, prev && `shared with ${prev}`);
            seenTitles.set(title, f);
        }
    }
}

console.log('\n== internal links all resolve ==');
{
    for (const f of PAGES) {
        const html = read(f);
        const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
        const broken = [];
        for (const href of hrefs) {
            // Only same-repo relative links are ours to verify. Anything with a
            // scheme (https:, mailto:) or a bare #fragment is out of scope here.
            if (/^[a-z]+:/i.test(href) || href.startsWith('#')) continue;
            const file = href.split('#')[0].split('?')[0];
            if (!file) continue;
            if (!exists(file)) broken.push(`${href} (in ${f})`);
        }
        ok(`${f} has no dead relative links`, broken.length === 0, broken.join(', '));
    }
    // The two anchors the standalone pages link into the app by.
    const index = read('index.html');
    ok('index.html actually has the #faq anchor the other pages link to',
       /id="faq"/.test(index));
}

console.log('\n== every page carries its icons ==');
for (const f of PAGES) {
    const html = read(f);
    ok(`${f} links a favicon`, /rel="icon"/.test(html));
    ok(`${f} links an apple-touch-icon`, /rel="apple-touch-icon"/.test(html));
}

console.log('\n== index.html: sharing card and canonical ==');
{
    const html = read('index.html');
    for (const prop of ['og:title', 'og:description', 'og:url', 'og:image', 'og:image:alt']) {
        ok(`${prop} is set`, new RegExp(`property="${prop}"[^>]*content="[^"]+"`).test(html));
    }
    ok('twitter:image:alt is set — the card image is described too',
       /name="twitter:image:alt"[^>]*content="[^"]+"/.test(html));
    ok('a canonical URL is declared', /<link rel="canonical" href="https:\/\/[^"]+"/.test(html));
    const canonical = (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1];
    const ogUrl = (html.match(/property="og:url" content="([^"]+)"/) || [])[1];
    // Two different absolute addresses for one page is how a duplicate gets
    // indexed; they have to agree.
    ok('canonical and og:url name the same address', canonical === ogUrl, `${canonical} vs ${ogUrl}`);
}

console.log('\n== JSON-LD ==');
{
    const html = read('index.html');
    const block = (html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1];
    ok('index.html carries a JSON-LD block', !!block);
    let data = null;
    try { data = JSON.parse(block); } catch (e) { ok('the JSON-LD parses', false, e.message); }
    if (data) {
        ok('the JSON-LD parses', true);
        const types = data['@graph'].map(n => n['@type']);
        for (const t of ['WebSite', 'Organization', 'SoftwareApplication', 'FAQPage']) {
            ok(`it describes a ${t}`, types.includes(t));
        }
        // Prices live in Grow's dashboard and the edge function's env vars, never
        // in this repo. A price written here would be a guess, and a wrong price
        // in a rich result is worse than none.
        ok('it claims no price it cannot know', !/"price"/.test(block));

        // The rule Google actually enforces: FAQ rich-result text has to be the
        // text on the page. This is the check that stops the two drifting.
        const faq = data['@graph'].find(n => n['@type'] === 'FAQPage').mainEntity;
        const section = (html.match(/<section class="public-section" id="faq"[\s\S]*?<\/section>/) || [])[0] || '';
        const onPage = [...section.matchAll(
            /<summary>([\s\S]*?)<\/summary>\s*<div class="faq-answer">([\s\S]*?)<\/div>/g)];
        const flat = (x) => x
            .replace(/<[^>]+>/g, ' ')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .replace(/\s+([.,;:])/g, '$1')   // tag boundaries leave a space before punctuation
            .trim();
        ok('the JSON-LD has one entry per question on the page',
           onPage.length === faq.length, `page ${onPage.length}, JSON-LD ${faq.length}`);
        onPage.forEach(([, q, a], i) => {
            if (!faq[i]) return;
            ok(`Q${i + 1}'s question matches the page`, flat(q) === faq[i].name,
               `page: ${flat(q)}\n       ld:   ${faq[i].name}`);
            ok(`Q${i + 1}'s answer matches the page`, flat(a) === faq[i].acceptedAnswer.text,
               `page: ${flat(a)}\n       ld:   ${faq[i].acceptedAnswer.text}`);
        });
    }
}

console.log('\n== CSP still allow-lists every inline script ==');
{
    // index.html's CSP names each inline script by hash rather than opening the
    // page up with 'unsafe-inline'. Editing one of those scripts — even
    // reindenting it — invalidates its hash, and the browser then silently
    // refuses to run it: no error, just a theme flash and a pitch that never
    // hides. Nothing else in this repo would notice.
    const html = read('index.html');
    const csp = (html.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
    const blocks = [
        ...[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => ['inline script', m[1]]),
        ...[...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
            .map(m => ['ld+json block', m[1]]),
    ];
    ok('there are inline scripts to check', blocks.length > 0);
    for (const [kind, body] of blocks) {
        const hash = 'sha256-' + crypto.createHash('sha256').update(body, 'utf8').digest('base64');
        ok(`the ${kind} starting "${body.trim().slice(0, 28).replace(/\s+/g, ' ')}…" is allow-listed`,
           csp.includes(hash), `computed ${hash}`);
    }
}

console.log('\n== the post-checkout return path ==');
{
    // This was a real bug: the browser sent window.location.origin, which drops
    // the /-/ this app is served from, so a payer was redirected to the domain
    // root — a different site. Both halves are asserted so it can't come back.
    const app = read('app.js');
    ok('app.js sends its base URL, directory included, not a bare origin',
       /function appBaseUrl\(\)/.test(app) && /origin:\s*appBaseUrl\(\)/.test(app),
       'checkout must not send window.location.origin');
    ok('app.js no longer sends a bare origin to checkout',
       !/origin:\s*window\.location\.origin/.test(app));

    const fn = read('supabase/functions/grow-checkout/index.ts');
    ok('grow-checkout returns a payer to the thank-you page',
       /successUrl:\s*`\$\{returnBase\}\/thanks\.html`/.test(fn));
    ok('and the thank-you page exists to receive them', exists('thanks.html'));
    ok('the thank-you page hands ?checkout=success back to the app, so the plan refreshes',
       /href="index\.html\?checkout=success"/.test(read('thanks.html')));
    ok('app.js still acts on ?checkout=success', /params\.get\('checkout'\)/.test(app));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
