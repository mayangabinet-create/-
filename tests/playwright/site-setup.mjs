// Builds a servable copy of the app with its two CDN scripts replaced by
// local files, per the recipe documented in ../pdf-pipeline.js: file://
// refuses cross-directory scripts, so the app has to be served over http,
// and a sandbox (this one included) usually can't reach the real CDNs.
//
// Output goes to ./site (gitignored, rebuilt on every run — see
// upload-box.test.mjs, which calls buildSite() before launching the browser).
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const siteDir = path.join(here, "site");

export function buildSite() {
  rmSync(siteDir, { recursive: true, force: true });
  mkdirSync(path.join(siteDir, "vendor"), { recursive: true });

  cpSync(path.join(repoRoot, "fonts"), path.join(siteDir, "fonts"), { recursive: true });

  cpSync(
    path.join(here, "node_modules/@supabase/supabase-js/dist/umd/supabase.js"),
    path.join(siteDir, "vendor/supabase.js"),
  );
  cpSync(
    path.join(here, "node_modules/pdfjs-dist/build/pdf.min.js"),
    path.join(siteDir, "vendor/pdf.min.js"),
  );
  cpSync(
    path.join(here, "node_modules/pdfjs-dist/build/pdf.worker.min.js"),
    path.join(siteDir, "vendor/pdf.worker.min.js"),
  );

  // Tesseract is four separate downloads at runtime — the library, its worker
  // script, the WASM core the worker importScripts, and one language model per
  // language — and the OCR path needs every one of them. Vendoring the lot is
  // what lets the scanned-PDF test run with the network cut, same as pdf.js.
  cpSync(
    path.join(here, "node_modules/tesseract.js/dist/tesseract.min.js"),
    path.join(siteDir, "vendor/tesseract.min.js"),
  );
  cpSync(
    path.join(here, "node_modules/tesseract.js/dist/worker.min.js"),
    path.join(siteDir, "vendor/worker.min.js"),
  );
  // The whole core directory: the worker picks between the SIMD and plain
  // builds at runtime by feature detection, so it must find either.
  cpSync(path.join(here, "node_modules/tesseract.js-core"), path.join(siteDir, "vendor/core"), { recursive: true });
  mkdirSync(path.join(siteDir, "vendor/lang"), { recursive: true });
  for (const lang of ["heb", "eng"]) {
    cpSync(
      path.join(here, `node_modules/@tesseract.js-data/${lang}/4.0.0/${lang}.traineddata.gz`),
      path.join(siteDir, `vendor/lang/${lang}.traineddata.gz`),
    );
  }

  let html = readFileSync(path.join(repoRoot, "index.html"), "utf8");
  const cdnScript = html.match(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[^"]+"[^>]*><\/script>/);
  if (!cdnScript) throw new Error("supabase-js <script> tag not found in index.html — has the CDN line changed shape?");
  html = html.replace(cdnScript[0], '<script src="vendor/supabase.js"></script>');
  writeFileSync(path.join(siteDir, "index.html"), html);

  let js = readFileSync(path.join(repoRoot, "app.js"), "utf8");
  const pdfjsBase = js.match(/const PDFJS_BASE = `https:\/\/cdn\.jsdelivr\.net\/npm\/pdfjs-dist@\$\{PDFJS_VERSION\}\/build\/`;/);
  if (!pdfjsBase) throw new Error("PDFJS_BASE CDN line not found in app.js — has it changed shape?");
  js = js.replace(pdfjsBase[0], "const PDFJS_BASE = 'vendor/';");
  const tesseractPaths = [
    [/const TESSERACT_BASE = `https:\/\/cdn\.jsdelivr\.net\/npm\/tesseract\.js@\$\{TESSERACT_VERSION\}\/dist\/`;/, "const TESSERACT_BASE = 'vendor/';"],
    [/const TESSERACT_CORE_BASE = `https:\/\/cdn\.jsdelivr\.net\/npm\/tesseract\.js-core@v\$\{TESSERACT_CORE_VERSION\}`;/, "const TESSERACT_CORE_BASE = new URL('vendor/core', location.href).href;"],
    [/const TESSERACT_LANG_BASE = 'https:\/\/tessdata\.projectnaptha\.com\/4\.0\.0';/, "const TESSERACT_LANG_BASE = new URL('vendor/lang', location.href).href;"],
  ];
  for (const [pattern, replacement] of tesseractPaths) {
    const found = js.match(pattern);
    if (!found) throw new Error(`tesseract CDN line not found in app.js (${pattern}) — has it changed shape?`);
    js = js.replace(found[0], replacement);
  }

  // The integrity hashes are pinned to the files as published to jsdelivr; a
  // locally-served copy won't match them, and loadPdfJs()/loadTesseract() would
  // reject every load with a SRI mismatch instead of ever calling onload. Both
  // loaders have one, hence the /g.
  const integrityLines = js.match(/\s*script\.integrity = 'sha384-[^']+';\n/g);
  if (!integrityLines || integrityLines.length !== 2) {
    throw new Error(`expected 2 integrity lines in app.js, found ${integrityLines ? integrityLines.length : 0} — has a loader changed shape?`);
  }
  for (const found of integrityLines) js = js.replace(found, "\n");
  writeFileSync(path.join(siteDir, "app.js"), js);

  return siteDir;
}

export { siteDir };
