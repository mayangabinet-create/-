/*
 * The upload box, in a real browser — the one interaction ../pdf-pipeline.js
 * documents as manual-only ("The cases above call the functions; they never
 * open the page... driven through the real DOM once"). This automates that
 * exact recipe: the three kinds of upload (a pdf-prep bundle, a plain .txt,
 * a .json that isn't a bundle), asserting on the same DOM state the comment
 * names — #authModal, not offsetParent, which is null for a position:fixed
 * modal.
 *
 *     node tests/playwright/upload-box.test.mjs
 *
 * (needs `npm install` inside tests/playwright/ first)
 *
 * This is the one flow in that comment safe to automate: it needs no
 * account and spends nothing. The comment is explicit that signed-in flows
 * (building a course, generating a lesson) were deliberately left out of
 * that recipe because "they need an account and spend real tokens" — this
 * suite leaves them out for the same reason. The browser context starts
 * with no stored session, so supabaseClient.auth.getSession() resolves
 * locally with no network call at all (see app.js's init IIFE) — but every
 * request to *.supabase.co is aborted anyway, to turn that into an
 * enforced guarantee instead of an assumption.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite, siteDir } from "./site-setup.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// This sandbox pre-installs Chromium at a fixed path and skips Playwright's
// own download, which can pin a different browser revision than the
// installed `playwright` package expects — launch against that fixed path
// when it's there. A normal CI runner has no such path; `npx playwright
// install --with-deps chromium` there puts a matching revision wherever
// playwright's own launch() already looks, so the default (no override)
// resolves correctly on its own.
async function launchOptions() {
  const sandboxChromium = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  try { await access(sandboxChromium); return { executablePath: sandboxChromium }; }
  catch { return {}; }
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".woff2": "font/woff2", ".json": "application/json" };

function serveSite(dir) {
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(dir, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "\n       " + extra : "")); }
}

buildSite();
const server = await serveSite(siteDir);
const port = server.address().port;

const browser = await chromium.launch(await launchOptions());
const context = await browser.newContext();
// Enforced, not assumed: this flow needs no account, so it should touch the
// live project never — abort anything that tries, rather than trust that it
// won't happen.
let hitSupabase = false;
await context.route("**://*.supabase.co/**", (route) => { hitSupabase = true; route.abort(); });
const page = await context.newPage();
page.on("pageerror", (err) => console.log("  [page error] " + err.message));

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.__appBooted === true);

console.log("\n== a pdf-prep bundle ==");
{
  await page.setInputFiles("#fileInput", path.join(here, "fixtures/bundle.json"));
  const modal = page.locator("#authModal");
  await modal.waitFor({ state: "attached" });
  await page.waitForFunction(() => document.getElementById("authModal")?.classList.contains("active"), { timeout: 10000 });
  ok("a valid bundle is read, then the sign-up wall — never a course built anonymously",
     await modal.evaluate((el) => el.classList.contains("active")));
  await page.evaluate(() => { document.getElementById("authModal").classList.remove("active"); hideAuthModal(); });
}

console.log("\n== a plain .txt file ==");
{
  await page.reload();
  await page.waitForFunction(() => window.__appBooted === true);
  await page.setInputFiles("#fileInput", path.join(here, "fixtures/study-notes.txt"));
  await page.waitForFunction(() => document.getElementById("authModal")?.classList.contains("active"), { timeout: 10000 });
  ok("a .txt file is read the same way a bundle is — same wall, not a reader error",
     await page.locator("#authModal").evaluate((el) => el.classList.contains("active")));
}

console.log("\n== a .json that is not a bundle ==");
{
  await page.reload();
  await page.waitForFunction(() => window.__appBooted === true);
  await page.setInputFiles("#fileInput", path.join(here, "fixtures/not-a-bundle.json"));
  await page.waitForFunction(() => document.getElementById("dialogBackdrop")?.classList.contains("active"), { timeout: 10000 });
  const title = await page.locator("#dialogTitle").textContent();
  const body = await page.locator("#dialogBody").textContent();
  ok("a .json without pdf-prep's schema is refused, not silently treated as a bundle",
     title === "Something went wrong", "title=" + JSON.stringify(title));
  ok("naming the actual problem — this regressed once when .txt was routed through the PDF reader",
     /isn't a document bundle/.test(body ?? ""), "body=" + JSON.stringify(body));
  ok("and the sign-up wall never shows for a rejected file",
     !(await page.locator("#authModal").evaluate((el) => el.classList.contains("active"))));
}

ok("the live Supabase project was never contacted", !hitSupabase);

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
