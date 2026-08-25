/*
 * A scanned PDF, read by OCR, in a real browser.
 *
 *     node tests/playwright/scanned-pdf.test.mjs
 *
 * (needs `npm install` inside tests/playwright/ first)
 *
 * ../pdf-pipeline.js checks the pure half of this — ocrLinesToLines against a
 * hand-built Tesseract page, looksScanned against character counts. Neither
 * can tell you whether the feature works, because everything that makes it
 * hard is in the browser: a WASM core loaded inside a worker, a page rendered
 * to a canvas, and a Content-Security-Policy strict enough that any one of
 * those can be refused silently. A CSP that forgets 'wasm-unsafe-eval' fails
 * exactly here and nowhere else.
 *
 * So this builds a PDF with no text layer at all — Hebrew drawn onto a canvas,
 * the canvas embedded as a JPEG, no font and no text operators anywhere in the
 * file — and asserts the words come back out of it. It needs no account and
 * spends nothing: processLearningMaterial is replaced with a recorder before
 * the upload, so the run stops the moment the text exists, which is the moment
 * this test is about.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite, siteDir } from "./site-setup.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

async function launchOptions() {
  const sandboxChromium = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  try { await access(sandboxChromium); return { executablePath: sandboxChromium }; }
  catch { return {}; }
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".woff2": "font/woff2",
  ".json": "application/json", ".wasm": "application/wasm", ".gz": "application/gzip",
};

function serveSite(dir) {
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(dir, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
    try {
      const body = await readFile(file);
      const headers = { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" };
      // Tesseract asks for `heb.traineddata.gz` and expects the gzip envelope
      // intact — it inflates the body itself. Serving it as Content-Encoding:
      // gzip would have the browser inflate it first and hand the worker a
      // file it then fails to parse.
      res.writeHead(200, headers);
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

// The Hebrew that goes onto the page as pixels and has to come back as text.
// Ordinary study prose, not a pangram: the point is the material a student
// actually uploads.
const LINES = [
  "מבנה התא",
  "התא הוא יחידת החיים הבסיסית.",
  "בתוך התא נמצאים אברונים רבים.",
  "המיטוכונדריה מייצרת אנרגיה לתא.",
  "הגרעין מכיל את החומר הגנטי.",
];

buildSite();
const server = await serveSite(siteDir);
const port = server.address().port;

const browser = await chromium.launch(await launchOptions());
const context = await browser.newContext();
let hitSupabase = false;
await context.route("**://*.supabase.co/**", (route) => { hitSupabase = true; route.abort(); });
// Everything Tesseract needs is vendored into the served site by
// site-setup.mjs. Cutting the network is what proves it: a path that still
// pointed at a CDN would hang here rather than quietly working in CI and
// failing behind a firewall.
let hitCdn = false;
await context.route("**://cdn.jsdelivr.net/**", (route) => { hitCdn = true; route.abort(); });
await context.route("**://tessdata.projectnaptha.com/**", (route) => { hitCdn = true; route.abort(); });

const page = await context.newPage();
page.on("pageerror", (err) => console.log("  [page error] " + err.message));
// A CSP refusal is a console message and nothing else — no exception, no
// failed promise. Without this the test would just time out and never say why.
const cspViolations = [];
page.on("console", (msg) => {
  if (/Content Security Policy|Refused to/i.test(msg.text())) cspViolations.push(msg.text());
});

// The fixture builder lives in an init script so it survives a reload: each
// scenario below starts from a fresh page and needs the same scan again.
await page.addInitScript(() => {
  // Draw the Hebrew, flatten it to a JPEG, and wrap that JPEG in the smallest
  // legal PDF that shows it. Nothing in the result is text — there is no font
  // object and no text operator anywhere in the file.
  window.__makeScanPdf = async (lines) => {
    const W = 1240, H = 1754;                    // A4 at 150dpi
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#000";
    ctx.direction = "rtl";
    ctx.textAlign = "right";
    let y = 220;
    lines.forEach((text, i) => {
      ctx.font = `${i === 0 ? "bold 64px" : "48px"} "DejaVu Sans", "FreeSans", sans-serif`;
      ctx.fillText(text, W - 120, y);
      y += i === 0 ? 160 : 110;
    });

    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.95));
    const jpeg = new Uint8Array(await blob.arrayBuffer());

    const enc = new TextEncoder();
    const chunks = [];
    let length = 0;
    const put = (bytes) => {
      const b = typeof bytes === "string" ? enc.encode(bytes) : bytes;
      chunks.push(b);
      length += b.length;
      return length;
    };

    const PW = 595, PH = 842;                    // MediaBox in points
    const offsets = [];
    put("%PDF-1.4\n");
    const obj = (n, body) => {
      offsets[n] = length;
      put(`${n} 0 obj\n`);
      if (typeof body === "string") put(body); else body();
      put("\nendobj\n");
    };

    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] `
         + `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
    obj(4, () => {
      put(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB `
        + `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
      put(jpeg);
      put("\nendstream");
    });
    const content = `q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`;
    obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

    const xrefAt = length;
    put(`xref\n0 6\n0000000000 65535 f \n`);
    for (let n = 1; n <= 5; n++) put(String(offsets[n]).padStart(10, "0") + " 00000 n \n");
    put(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

    const pdf = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) { pdf.set(c, at); at += c.length; }
    return pdf;
  };

  // Hand a built PDF to the input the way a drop does, and record the text the
  // reader produces instead of letting the app carry on into the sign-up wall.
  window.__uploadScan = async (lines) => {
    const pdf = await window.__makeScanPdf(lines);
    window.__material = null;
    window.processLearningMaterial = async (text) => { window.__material = text; };

    const file = new File([pdf], "scanned-chapter.pdf", { type: "application/pdf" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById("fileInput");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const asText = new TextDecoder("latin1").decode(pdf);
    return { bytes: pdf.length, hasTextOperator: /\bBT\b/.test(asText), hasFont: /\/Font\b/.test(asText) };
  };
});

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.__appBooted === true);

console.log("\n== a PDF with no text layer ==");
const built = await page.evaluate((lines) => window.__uploadScan(lines), LINES);

ok("the fixture really is a scan — no text operators", !built.hasTextOperator);
ok("...and no font object either", !built.hasFont, JSON.stringify(built));

// The reader finds no text layer and asks before spending minutes on OCR.
await page.waitForFunction(
  () => document.getElementById("dialogBackdrop")?.classList.contains("active"),
  { timeout: 30000 },
);
const title = await page.locator("#dialogTitle").textContent();
const body = await page.locator("#dialogBody").textContent();
ok("a scan is offered OCR, not refused", title === "This looks like a scan", "title=" + JSON.stringify(title));
ok("...and told what it will cost", /take/i.test(body ?? ""), "body=" + JSON.stringify(body));
ok("...with a one-page scan read whole", /All 1 page/.test(body ?? ""), "body=" + JSON.stringify(body));

const confirmLabel = await page.locator("#dialogConfirm").textContent();
ok("the confirm button says what it does", confirmLabel === "Read it anyway", JSON.stringify(confirmLabel));

await page.locator("#dialogConfirm").click();

// The whole OCR stack now has to start: script, worker, WASM core, language
// model. Generous, because it is genuinely slow the first time.
await page.waitForFunction(() => typeof window.__material === "string", { timeout: 180000 });
const material = await page.evaluate(() => window.__material);

console.log("\n== what came back ==");
console.log("  " + JSON.stringify(material));

ok("no CSP violations along the way", cspViolations.length === 0, cspViolations.join("\n       "));
ok("nothing reached a CDN — the whole stack was served locally", !hitCdn);
ok("the live Supabase project was never contacted", !hitSupabase);
ok("OCR produced text", (material ?? "").trim().length > 40, JSON.stringify(material));

// OCR is never perfect, so this asks for most of the words rather than all of
// them. What it will not tolerate is a systematic failure: a language model
// that never loaded reads Hebrew as Latin punctuation and scores zero.
const words = ["התא", "אברונים", "אנרגיה", "הגרעין", "הגנטי", "מבנה", "החיים"];
const found = words.filter((w) => (material ?? "").includes(w));
ok(`most of the Hebrew is recovered (${found.length}/${words.length})`,
   found.length >= Math.ceil(words.length * 0.6), "missing: " + words.filter((w) => !found.includes(w)).join(", "));

// The regression that matters most for Hebrew: Tesseract returns a line in
// reading order already, and reversing it a second time — the thing the
// text-layer reader must do — would turn every phrase inside out.
ok("phrases read in the right direction, not reversed",
   /מבנה\s+התא/.test(material ?? "") || /יחידת\s+החיים/.test(material ?? ""),
   JSON.stringify(material));

console.log("\n== declining the offer ==");
{
  // Cancelling has to land somewhere that explains itself. The old dead end
  // sent everyone to a Python tool; someone who has just been shown an offer
  // and turned it down needs to hear that the offer is still there.
  await page.reload();
  await page.waitForFunction(() => window.__appBooted === true);
  await page.evaluate((lines) => window.__uploadScan(lines), LINES);
  await page.waitForFunction(
    () => document.getElementById("dialogTitle")?.textContent === "This looks like a scan",
    { timeout: 30000 },
  );
  await page.locator("#dialogCancel").click();
  await page.waitForFunction(
    () => document.getElementById("dialogTitle")?.textContent === "Something went wrong",
    { timeout: 30000 },
  );
  const body = await page.locator("#dialogBody").textContent();
  ok("declining says the scan can still be read, not 'no text found'",
     /Upload it again to run it/.test(body ?? ""), "body=" + JSON.stringify(body));
  ok("...and no course is built from an empty read",
     (await page.evaluate(() => window.__material)) === null);
}

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
