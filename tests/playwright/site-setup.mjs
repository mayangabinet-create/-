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

  let html = readFileSync(path.join(repoRoot, "index.html"), "utf8");
  const cdnScript = html.match(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[^"]+"[^>]*><\/script>/);
  if (!cdnScript) throw new Error("supabase-js <script> tag not found in index.html — has the CDN line changed shape?");
  html = html.replace(cdnScript[0], '<script src="vendor/supabase.js"></script>');
  writeFileSync(path.join(siteDir, "index.html"), html);

  let js = readFileSync(path.join(repoRoot, "app.js"), "utf8");
  const pdfjsBase = js.match(/const PDFJS_BASE = `https:\/\/cdn\.jsdelivr\.net\/npm\/pdfjs-dist@\$\{PDFJS_VERSION\}\/build\/`;/);
  if (!pdfjsBase) throw new Error("PDFJS_BASE CDN line not found in app.js — has it changed shape?");
  js = js.replace(pdfjsBase[0], "const PDFJS_BASE = 'vendor/';");
  // The integrity hash is pinned to the file as published to jsdelivr; a
  // locally-served copy won't match it, and loadPdfJs() would reject every
  // load with a SRI mismatch instead of ever calling onload.
  const integrityLine = js.match(/\s*script\.integrity = 'sha384-[^']+';\n/);
  if (!integrityLine) throw new Error("pdf.js integrity line not found in app.js — has it changed shape?");
  js = js.replace(integrityLine[0], "\n");
  writeFileSync(path.join(siteDir, "app.js"), js);

  return siteDir;
}

export { siteDir };
