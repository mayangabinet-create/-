/*
 * PDF pipeline checks — extraction, furniture removal, paragraph reconstruction,
 * chunking, and the document digest that replaced substring(0, 5000).
 *
 * These are pure text functions, so unlike tests/tier-checks.js they need no
 * account, no network and no browser:
 *
 *     node tests/pdf-pipeline.js
 *
 * app.js is a plain browser script with no module system (deliberately — the
 * app has no build step), so the functions under test are lifted out of the
 * source by name and compiled on their own. That keeps the tests honest: they
 * run the shipping code, not a copy of it that can drift.
 *
 * For the end-to-end check — a real multi-page PDF through real PDF.js — see
 * the note at the bottom of this file.
 */
// Pull the pure text-processing functions out of app.js and expose them, so the
// pipeline can be exercised in Node without a browser or a Supabase project.
const fs = require('fs');
const src = fs.readFileSync(process.argv[2] || require('path').join(__dirname, '..', 'app.js'), 'utf8');

// Grab a top-level `function name(...)  {...}` or `const NAME = ...;` by matching braces.
function grab(decl) {
  const idx = src.indexOf(decl);
  if (idx < 0) throw new Error('not found: ' + decl);

  if (decl.startsWith('function')) {
    let i = src.indexOf('{', idx), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
    }
    throw new Error('unbalanced: ' + decl);
  }
  // A const: run to the semicolon that closes the statement, tracking nesting so
  // `new Set([...])` and object literals do not end it early.
  let depth = 0;
  for (let i = idx; i < src.length; i++) {
    const c = src[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0) return src.slice(idx, i + 1);
  }
  throw new Error('no statement end: ' + decl);
}

const names = [
  'const LINE_TOLERANCE', 'const RTL_CHARS', 'const LTR_CHARS',
  'function pageItemsToLines',
  'function stripRepeatedFurniture',
  'function linesToParagraphs',
  'const CHUNK_CHARS',
  'const STOPWORDS',
  'function tokenize',
  'function splitBlocks',
  'function chunkText',
  'function buildIndex',
  'function scoreChunk',
  'function sectionSource',
  'function retrieveFrom',
  'function retrieveExcerpt',
  'function readBundle',
  'function bundleStructure',
  'function locateSections',
  'function looksLikeHeading',
  'const HEADING_LEVELS',
  'function headingLevel',
  'function documentSections',
  'function renderOutline',
  'function blockDensity',
  'function sampleBySection',
  'function sampleBySegment',
  'function extractOutline',
  'function buildSourceDigest',
  'function takeBlocks',
];

let code = `
const CHUNK_OVERLAP = 150;
const MAX_SOURCE_CHARS = 600000;
let entitlement = null;
const PLAN_LIMITS = ${JSON.stringify({
  trial: { readChars: 5000, excerptChars: 2400 },
  basic: { readChars: 5000, excerptChars: 2400 },
  pro:   { readChars: 40000, excerptChars: 8000 },
  max:   { readChars: 120000, excerptChars: 16000 },
})};
function planReadChars(){ return (entitlement && PLAN_LIMITS[entitlement.planKey]?.readChars) || 5000; }
function excerptBudget(){ return (entitlement && PLAN_LIMITS[entitlement.planKey]?.excerptChars) || 2400; }
function setPlan(p){ entitlement = p ? { planKey: p } : null; }
`;
for (const n of names) code += '\n' + grab(n) + '\n';
code += `
module.exports = { pageItemsToLines, stripRepeatedFurniture, linesToParagraphs,
  splitBlocks, chunkText, tokenize, retrieveExcerpt, sectionSource, looksLikeHeading,
  readBundle, bundleStructure, locateSections,
  headingLevel, documentSections, renderOutline, blockDensity,
  extractOutline, buildSourceDigest, takeBlocks, planReadChars, excerptBudget, setPlan };
`;


const m = new module.constructor();
m._compile(code, '/pipeline.js');
const P = m.exports;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
};

// ---- Build a synthetic PDF page: text runs with real geometry ----
// y descends down the page; each run carries x/width so gaps become spaces.
function line(y, parts, height = 10) {
  let x = 50;
  return parts.map(w => {
    const item = { str: w, width: w.length * 5, height, transform: [1, 0, 0, height, x, y] };
    x += w.length * 5 + 5;   // a real inter-word gap
    return item;
  });
}

console.log('\n== line reconstruction ==');
{
  const items = [...line(700, ['The', 'cell', 'membrane']), ...line(686, ['is', 'selectively', 'permeable.'])];
  const lines = P.pageItemsToLines(items);
  ok('two baselines become two lines', lines.length === 2, JSON.stringify(lines.map(l => l.text)));
  ok('runs on a line are spaced', lines[0].text === 'The cell membrane', lines[0].text);
  ok('reading order is top-down', lines[1].text.startsWith('is selectively'), lines[1].text);
}
{
  // Runs abutting with no gap must not gain a space ("mem" + "brane").
  const items = [
    { str: 'mem', width: 15, height: 10, transform: [1, 0, 0, 10, 50, 700] },
    { str: 'brane', width: 25, height: 10, transform: [1, 0, 0, 10, 65, 700] },
  ];
  ok('abutting runs are not split', P.pageItemsToLines(items)[0].text === 'membrane');
}
{
  // PDF.js emits runs in visual order (left to right). A Hebrew line is read
  // right to left, so its runs must be walked backwards to recover the sentence.
  const items = [
    { str: 'עולם', width: 20, height: 10, transform: [1, 0, 0, 10, 50, 700] },
    { str: 'שלום', width: 20, height: 10, transform: [1, 0, 0, 10, 80, 700] },
  ];
  ok('Hebrew line is read right-to-left', P.pageItemsToLines(items)[0].text === 'שלום עולם',
     P.pageItemsToLines(items)[0].text);
}
{
  // The case that actually bites: a digit splits the line into several runs, and
  // visual order stops matching reading order. Geometry taken from a real PDF.
  const items = [
    { str: ': המיטוכונדריה', width: 105, height: 15, transform: [1, 0, 0, 15, 382, 755] },
    { str: '2',             width: 10,  height: 15, transform: [1, 0, 0, 15, 488, 755] },
    { str: ' ',             width: 7,   height: 0,  transform: [1, 0, 0, 15, 498, 755] },
    { str: 'פרק',           width: 30,  height: 15, transform: [1, 0, 0, 15, 503, 755] },
  ];
  const got = P.pageItemsToLines(items)[0].text;
  ok('numbered Hebrew heading reads correctly', got === 'פרק 2: המיטוכונדריה', JSON.stringify(got));
  ok('...and is then recognised as a heading', P.looksLikeHeading(got));
}
{
  // The same shape in Latin must still read left to right.
  const items = [
    { str: 'Chapter',    width: 40, height: 15, transform: [1, 0, 0, 15, 50, 700] },
    { str: '2',          width: 8,  height: 15, transform: [1, 0, 0, 15, 95, 700] },
    { str: ': Mitochondria', width: 70, height: 15, transform: [1, 0, 0, 15, 104, 700] },
  ];
  const got = P.pageItemsToLines(items)[0].text;
  ok('numbered Latin heading is unaffected', got === 'Chapter 2: Mitochondria', JSON.stringify(got));
}

console.log('\n== headers / footers / folios ==');
{
  const words = ['mitochondria', 'ribosome', 'membrane', 'nucleus', 'enzyme', 'cytoplasm'];
  const pages = [];
  for (let p = 1; p <= 10; p++) {
    const body = [];
    for (let b = 0; b < 6; b++) {
      body.push({ text: `The ${words[(p + b) % words.length]} of specimen ${p}${b} showed a distinct response.`, y: 700 - b * 12, height: 10 });
    }
    pages.push([
      { text: 'Introduction to Biology', y: 750, height: 9 },   // running head
      ...body,
      { text: String(p), y: 60, height: 9 },                     // folio
    ]);
  }
  const cleaned = P.stripRepeatedFurniture(pages);
  const flat = cleaned.flat().map(l => l.text);
  ok('running head removed', !flat.some(t => t === 'Introduction to Biology'));
  ok('bare page numbers removed', !flat.some(t => /^\d+$/.test(t)));
  ok('body survives', cleaned.every(p => p.length === 6), JSON.stringify(cleaned.map(p => p.length)));

  // A sparse page must not have its only body line mistaken for a running head.
  const sparse = [];
  for (let p = 1; p <= 10; p++) {
    sparse.push([
      { text: 'Running Head', y: 750, height: 9 },
      { text: 'The single real sentence of content on this page.', y: 700, height: 10 },
      { text: String(p), y: 60, height: 9 },
    ]);
  }
  const sparseFlat = P.stripRepeatedFurniture(sparse).flat().map(l => l.text);
  ok('sparse page keeps its body line',
     sparseFlat.filter(t => t.startsWith('The single real')).length === 10,
     JSON.stringify(sparseFlat.slice(0, 5)));

  // Chapter openings: "Chapter 1", "Chapter 2"... collapse to one key once digits
  // are ignored, so a naive furniture rule deletes every heading in the book.
  const chapters = [];
  for (let c = 1; c <= 10; c++) {
    chapters.push([
      { text: `Chapter ${c}`, y: 750, height: 16 },
      { text: `Opening paragraph of chapter ${c}, which introduces the material to follow.`, y: 700, height: 10 },
      { text: `Further discussion for chapter ${c} continues across the page.`, y: 688, height: 10 },
      { text: String(c), y: 60, height: 9 },
    ]);
  }
  const chapterFlat = P.stripRepeatedFurniture(chapters).flat().map(l => l.text);
  ok('chapter headings survive the furniture pass',
     chapterFlat.filter(t => /^Chapter \d+$/.test(t)).length === 10,
     JSON.stringify(chapterFlat.filter(t => /^Chapter/.test(t))));

  // ...while a genuine running head repeating verbatim is still removed.
  const heads = [];
  for (let p = 1; p <= 10; p++) {
    heads.push([
      { text: 'Chapter 4: Cell Division', y: 750, height: 9 },   // same heading, every page
      { text: `Body sentence number ${p} carrying the real content of this page here.`, y: 700, height: 10 },
      { text: `A second body sentence, number ${p}, with further detail on the topic.`, y: 688, height: 10 },
    ]);
  }
  const headFlat = P.stripRepeatedFurniture(heads).flat().map(l => l.text);
  ok('a verbatim repeated running head is still removed',
     !headFlat.includes('Chapter 4: Cell Division'),
     JSON.stringify(headFlat.slice(0, 3)));
}
{
  // A 3-page handout: a line repeating twice is a coincidence, not furniture.
  const pages = [
    [{ text: 'Results', y: 750, height: 9 }, { text: 'Alpha body content goes here.', y: 700, height: 10 }],
    [{ text: 'Results', y: 750, height: 9 }, { text: 'Beta body content goes here.', y: 700, height: 10 }],
    [{ text: 'Discussion', y: 750, height: 9 }, { text: 'Gamma body content goes here.', y: 700, height: 10 }],
  ];
  const flat = P.stripRepeatedFurniture(pages).flat().map(l => l.text);
  ok('short doc keeps repeated headings', flat.filter(t => t === 'Results').length === 2, JSON.stringify(flat));
}

console.log('\n== paragraphs and de-hyphenation ==');
{
  const lines = [
    { text: 'Photosynthesis converts light energy into chemical energy stored in glu-', y: 700, height: 10 },
    { text: 'cose molecules inside the chloroplast of the plant cell.', y: 688, height: 10 },
    { text: 'A second paragraph starts after a wider vertical gap than the line spacing.', y: 640, height: 10 },
  ];
  const out = P.linesToParagraphs(lines);
  ok('hyphen across wrap rejoined', out.includes('glucose'), out);
  ok('wrapped line joined into one', out.split('\n\n')[0].includes('chloroplast'), out);
  ok('wide gap starts a paragraph', out.split('\n\n').length === 2, JSON.stringify(out));
}

console.log('\n== heading detection ==');
{
  ok('numbered heading', P.looksLikeHeading('3.2 Photosynthesis'));
  ok('chapter heading', P.looksLikeHeading('Chapter 4: Cell Division'));
  ok('all caps heading', P.looksLikeHeading('METHODS AND MATERIALS'));
  ok('title case heading', P.looksLikeHeading('The Krebs Cycle'));
  ok('Hebrew chapter heading', P.looksLikeHeading('פרק 3 מבוא'));
  ok('a sentence is not a heading', !P.looksLikeHeading('The cell membrane is selectively permeable.'));
  ok('a long line is not a heading',
     !P.looksLikeHeading('This particular line runs on well past the point where any reasonable heading would stop'));
}

console.log('\n== digest coverage (the whole point) ==');
{
  // A synthetic "textbook": front matter, then 12 chapters, each with a distinctive
  // term that appears nowhere else, then a conclusion.
  const blocks = [];
  blocks.push('Principles of Cell Biology');
  blocks.push('Copyright 2019 Academic Press. All rights reserved. No part of this publication may be reproduced or transmitted in any form without prior written permission of the publisher, including photocopying and recording.');
  blocks.push('Table of Contents');
  for (let c = 1; c <= 12; c++) {
    blocks.push(`Chapter ${c}: Topic ${c}`);
    for (let s = 0; s < 8; s++) {
      blocks.push(`Section ${c}.${s} discusses zygomorph${c} which is the defining mechanism of this chapter. `
        + `The zygomorph${c} pathway regulates transport and is measured by standard laboratory assay techniques `
        + `across a range of experimental conditions described in the accompanying protocol notes here.`);
    }
  }
  blocks.push('Conclusion');
  blocks.push('The zygomorph pathways surveyed across these chapters together describe how the cell coordinates transport, signalling and division into one regulated system that responds to its environment.');
  const doc = blocks.join('\n\n');

  const digest = P.buildSourceDigest(doc, 5000);
  ok('digest respects the budget', digest.length <= 5000, 'len=' + digest.length);

  const oldWay = doc.substring(0, 5000);
  const covered = n => digest.includes('zygomorph' + n);
  const oldCovered = n => oldWay.includes('zygomorph' + n);
  const digestChapters = [...Array(12)].map((_, i) => i + 1).filter(covered);
  const oldChapters = [...Array(12)].map((_, i) => i + 1).filter(oldCovered);
  console.log('       digest reaches chapters: ' + JSON.stringify(digestChapters));
  console.log('       substring(0,5000) reaches: ' + JSON.stringify(oldChapters));
  ok('digest reaches the final chapter', covered(12));
  ok('digest spans more chapters than the old head-slice',
     digestChapters.length > oldChapters.length,
     `${digestChapters.length} vs ${oldChapters.length}`);
  ok('outline is present', digest.includes('[OUTLINE'));
  ok('outline lists late chapters', digest.includes('Chapter 11') || digest.includes('Chapter 12'));
  ok('outline names every chapter', [...Array(12)].every((_, i) => digest.includes('Chapter ' + (i + 1) + ': Topic ' + (i + 1))));
  ok('outline quotes each part\'s share', /\(\d+%\)/.test(digest), digest.slice(0, 80));
  ok('passages say which part they came from', digest.includes('[Chapter'), digest.slice(0, 200));
  ok('closing is present', digest.includes('[CLOSING]'));
  ok('gaps are marked', digest.includes('[...]'));

  // Bigger budget must not lose coverage.
  const big = P.buildSourceDigest(doc, 40000);
  ok('pro-sized digest respects budget', big.length <= 40000, 'len=' + big.length);
  const bigChapters = [...Array(12)].map((_, i) => i + 1).filter(n => big.includes('zygomorph' + n));
  ok('pro-sized digest covers >= basic', bigChapters.length >= digestChapters.length,
     `${bigChapters.length} vs ${digestChapters.length}`);
}
{
  const short = 'Just a little text that fits comfortably.';
  ok('short doc passes through untouched', P.buildSourceDigest(short, 5000) === short);
  const wall = 'x'.repeat(9000);
  ok('single-block doc is truncated safely', P.buildSourceDigest(wall, 5000).length === 5000);
  ok('empty input is safe', P.buildSourceDigest('', 5000) === '');
}

console.log('\n== heading depth ==');
{
  ok('a part is the top level', P.headingLevel('Part One') === 1);
  ok('a chapter sits under it', P.headingLevel('Chapter 4: Cell Division') === 2);
  ok('a Hebrew chapter too', P.headingLevel('פרק 3 מבוא') === 2);
  ok('a Hebrew part is level 1', P.headingLevel('חלק ב: דיני חוזים') === 1);
  ok('one number deep is a chapter', P.headingLevel('3 Photosynthesis') === 2);
  ok('two numbers deep is a section', P.headingLevel('3.2 Photosynthesis') === 3);
  ok('a bare title is a chapter until told otherwise', P.headingLevel('The Krebs Cycle') === 2);
  ok('a sentence has no level', P.headingLevel('The cell membrane is selectively permeable.') === 0);
}

console.log('\n== document structure ==');
{
  const doc = [
    'Part One: Foundations',
    'An opening paragraph about the foundations of the subject, long enough to count as real body text rather than a stray line.',
    'Chapter 1: Cells',
    'A paragraph about cells and the way they are organised into tissues, with enough words in it to be a genuine block of prose.',
    '1.1 Membranes',
    'A paragraph about membranes, their structure, and the transport that happens across them under normal conditions.',
    'Chapter 2: Energy',
    'A paragraph about energy, respiration and the way a cell pays for the work it does across a long enough stretch of text.',
  ].join('\n\n');
  const sections = P.documentSections(P.splitBlocks(doc));

  ok('every heading became a section', sections.length === 4, JSON.stringify(sections.map(s => s.title)));
  ok('levels are compressed to 1..n',
     JSON.stringify(sections.map(s => s.level)) === '[1,2,3,2]',
     JSON.stringify(sections.map(s => s.level)));
  ok('a section knows its ancestors',
     sections[2].path.join(' > ') === 'Part One: Foundations > Chapter 1: Cells > 1.1 Membranes',
     sections[2].path.join(' > '));

  // A chapter owns its sub-sections' text; its own text stops at the next heading.
  const chapter1 = sections[1];
  ok('a chapter spans its sub-sections', chapter1.totalChars > chapter1.chars,
     `${chapter1.totalChars} vs ${chapter1.chars}`);
  ok('the part spans the whole document', sections[0].totalChars > chapter1.totalChars);

  ok('prose with no headings has no structure',
     P.documentSections(P.splitBlocks([...Array(8)].map((_, i) =>
       `Paragraph ${i} runs on for a while about the subject at hand and does not look like a heading in any way.`).join('\n\n'))).length === 0);

  // Title Case fires on body text in some documents. A wrong outline is worse
  // than none, so a document that is nearly all headings reports no structure.
  ok('a page of title-case lines is not an outline',
     P.documentSections([...Array(10)].map((_, i) => 'Some Title Case Line ' + i)).length === 0);
}

console.log('\n== digest coverage of an uneven document ==');
{
  // The shape the old sampler got wrong: one huge chapter and nine short ones.
  // Sampling by position spends the budget where the paragraphs are, so a short
  // chapter at the end of the book can go unmentioned; sampling by section gives
  // every chapter a passage before any chapter gets a second.
  const blocks = ['A Practical Handbook'];
  for (let c = 1; c <= 10; c++) {
    blocks.push(`Chapter ${c}: Topic ${c}`);
    for (let s = 0; s < (c === 1 ? 60 : 3); s++) {
      blocks.push(`Passage ${c}.${s} explains widget${c} at length, showing how widget${c} behaves `
        + `under load and why the surrounding machinery depends on it in practice, with worked reasoning.`);
    }
  }
  blocks.push('Conclusion');
  blocks.push('The widgets described above form one coherent system for the practitioner to apply.');
  const doc = blocks.join('\n\n');

  const digest = P.buildSourceDigest(doc, 5000);
  const reached = [...Array(10)].map((_, i) => i + 1).filter(n => digest.includes('widget' + n));
  ok('every chapter is sampled, not just the long one', reached.length === 10, JSON.stringify(reached));
  ok('the long chapter still gets the most room',
     (digest.match(/widget1\b/g) || []).length >= 2, JSON.stringify(reached));
  ok('the digest respects its budget', digest.length <= 5000, 'len=' + digest.length);
  ok('rebuilding is byte-identical', P.buildSourceDigest(doc, 5000) === digest);
}

console.log('\n== a book with more parts than the budget ==');
{
  const blocks = [];
  for (let c = 1; c <= 80; c++) {
    blocks.push(`Chapter ${c}: Topic ${c}`);
    for (let s = 0; s < 4; s++) {
      blocks.push(`Passage ${c}.${s} explains gizmo${c} in depth and shows how gizmo${c} interacts `
        + `with the rest of the system under realistic conditions, with worked reasoning throughout.`);
    }
  }
  const digest = P.buildSourceDigest(blocks.join('\n\n'), 5000);

  // At this budget no sampler can quote 80 chapters. Naming them all costs a
  // line each, and a chapter the planner never hears of cannot be taught.
  const named = [...Array(80)].map((_, i) => i + 1).filter(n => digest.includes(`Chapter ${n}: Topic ${n}`));
  ok('every part is named even when few can be quoted', named.length === 80, named.length + '/80');
  ok('still within budget', digest.length <= 5000, 'len=' + digest.length);
}

console.log('\n== retrieval scoped to the concept\'s section ==');
{
  // "flux" is discussed in two chapters. Chapter 3 is where it is taught; chapter 7
  // mentions it more often, so whole-document TF-IDF prefers chapter 7.
  const blocks = ['A Field Guide'];
  for (let c = 1; c <= 8; c++) {
    blocks.push(`Chapter ${c}: Topic ${c}`);
    for (let s = 0; s < 4; s++) {
      if (c === 3) blocks.push(`The definition of flux is given here: flux is the quantity crossing a surface per unit time, and this chapter derives it from first principles in section ${s}.`);
      else if (c === 7) blocks.push(`Applications of flux appear throughout, and flux flux flux is invoked repeatedly in worked examples of the applied kind in section ${s}.`);
      else blocks.push(`Chapter ${c} section ${s} discusses matters unrelated to the subject of this test, at a length that makes it a real block of prose.`);
    }
  }
  const doc = blocks.join('\n\n');
  const concept = { name: 'Flux', description: 'the quantity crossing a surface per unit time', importance: 'core', examples: [] };

  P.setPlan('basic');
  const unscoped = P.retrieveExcerpt(concept, doc);
  const scoped = P.retrieveExcerpt({ ...concept, section: 'Chapter 3: Topic 3' }, doc);

  ok('the section is found in the stored text', P.sectionSource({ section: 'Chapter 3: Topic 3' }, doc).includes('first principles'));
  ok('scoped retrieval reads the chapter it was told to', scoped.includes('first principles'), scoped.slice(0, 90));
  ok('scoped retrieval leaves the other chapter alone', !scoped.includes('Applications of flux'), scoped.slice(0, 90));
  ok('unscoped retrieval is unchanged', unscoped.length > 0);

  // A heading the model paraphrased instead of copying must not come back empty.
  const wrong = P.retrieveExcerpt({ ...concept, section: 'Chapter Three, On Flux' }, doc);
  ok('an unmatched section falls back to the whole document', wrong === unscoped, wrong.slice(0, 60));
  ok('no section behaves as before', P.retrieveExcerpt(concept, doc) === unscoped);
  P.setPlan(null);
}

console.log('\n== a prepared bundle ==');
{
  // A real bundle, as `python3 -m tools.pdf_prep book.pdf --bundle` writes it,
  // trimmed to the parts the app reads. Kept verbatim rather than invented, so
  // this test fails if either side of the contract moves.
  const bundle = {
    "schema": "pdf-prep/1",
    "kind": "bundle",
    "markdown": "---\ntitle: \"מדריך המשפט המעשי\"\nsource: \"heb.pdf\"\npages: \"5\"\nlanguage: \"he\"\ngenerated_by: \"tools/pdf_prep\"\n---\n\n# מדריך המשפט המעשי\n\n<!-- page 1 -->\n\nהוצאת דוגמה, תל אביב\n\n<!-- page 3 -->\n\n### פרק 1 — חוזים\n\nחוזה הוא הסכם מחייב בין שני צדדים או יותר. תוקפו של החוזה תלוי בגמירות דעת ובמסוימות של התנאים, ואלה נבחנים לפי אמות מידה אובייקטיביות.\n\nהפרת חוזה מזכה את הצד הנפגע בתרופות הבאות:\n\n- אכיפה של החוזה\n- ביטול החוזה והשבה\n- פיצויים על הנזק שנגרם\n\n<!-- page 4 -->\n\n### פרק 2 — מיסוי\n\nמס רכישה מוטל על רוכש זכות במקרקעין. שיעור המס נקבע לפי שווי העסקה ולפי מספר הדירות שבבעלות הרוכש במועד הרכישה.\n\n#### 2.1 מדרגות המס\n\n**טבלה 1: מדרגות מס רכישה לדירה יחידה**\n\n| מדרגה | שיעור |\n| --- | --- |\n| עד מיליון ש\"ח | 0% |\n| מעל מיליון ש\"ח | 3.5% |\n\n<!-- page 5 -->\n\n### פרק 3 — תכנון ובנייה\n\nהיתר בנייה נדרש לכל עבודה טעונת היתר. הוועדה המקומית דנה בבקשה ומחליטה בה לאחר שמיעת התנגדויות, אם הוגשו כאלה במועד\n\n",
    "manifest": {
      "document": {
        "page_count": 5,
        "title": "מדריך המשפט המעשי"
      },
      "outline": [
        {
          "id": "s001",
          "title": "מדריך המשפט המעשי",
          "level": 1,
          "page_start": 1,
          "page_end": 5,
          "path": [
            "מדריך המשפט המעשי"
          ],
          "children": [
            {
              "id": "s002",
              "title": "פרק 1 — חוזים",
              "level": 2,
              "page_start": 3,
              "page_end": 3,
              "path": [
                "מדריך המשפט המעשי",
                "פרק 1 — חוזים"
              ],
              "children": []
            },
            {
              "id": "s003",
              "title": "פרק 2 — מיסוי",
              "level": 2,
              "page_start": 4,
              "page_end": 4,
              "path": [
                "מדריך המשפט המעשי",
                "פרק 2 — מיסוי"
              ],
              "children": [
                {
                  "id": "s004",
                  "title": "2.1 מדרגות המס",
                  "level": 3,
                  "page_start": 4,
                  "page_end": 4,
                  "path": [
                    "מדריך המשפט המעשי",
                    "פרק 2 — מיסוי",
                    "2.1 מדרגות המס"
                  ],
                  "children": []
                }
              ]
            },
            {
              "id": "s005",
              "title": "פרק 3 — תכנון ובנייה",
              "level": 2,
              "page_start": 5,
              "page_end": 5,
              "path": [
                "מדריך המשפט המעשי",
                "פרק 3 — תכנון ובנייה"
              ],
              "children": []
            }
          ]
        }
      ]
    }
  };

  const { text, structure } = P.readBundle(JSON.stringify(bundle));
  ok('the Markdown comes through', text.includes('פרק 1 — חוזים'), text.slice(0, 60));
  ok('the outline is flattened with its depths',
     JSON.stringify(structure.sections.map(s => s.level)) === '[1,2,2,3,2]',
     JSON.stringify(structure.sections.map(s => s.level)));
  ok('page numbers survive', structure.sections.some(s => s.pageStart === 4),
     JSON.stringify(structure.sections[2]));
  ok('the page count comes through', structure.pages === 5);

  // The headings in that Markdown are written "### פרק 1 — חוזים". Being told
  // the outline is what lets the app find them; deriving would have to read
  // past the hashes and could never recover the page numbers at all.
  const blocks = P.splitBlocks(text);
  const located = P.documentSections(blocks, structure);
  ok('every heading is located in the text', located.length === structure.sections.length,
     JSON.stringify(located.map(s => s.title)));
  ok('located sections keep their page numbers',
     located.find(s => s.title === 'פרק 2 — מיסוי').pageStart === 4);
  ok('a located section owns the text under it',
     located.find(s => s.title === 'פרק 1 — חוזים').totalChars > 100);

  const digest = P.buildSourceDigest(text, 600, structure);
  ok('the outline quotes real pages', /pp?\. \d/.test(digest), digest.slice(0, 200));
  ok('the digest is still deterministic', P.buildSourceDigest(text, 600, structure) === digest);

  // Junk in, refusal out — never a course built on nothing.
  const rejects = ['not json at all', '{}', '{"schema":"other/1","markdown":"x"}',
                   JSON.stringify({ schema: 'pdf-prep/1', markdown: 'too short' })];
  ok('junk is rejected', rejects.every(raw => {
    try { P.readBundle(raw); return false; } catch (e) { return e.message === 'BUNDLE_INVALID'; }
  }));

  // An outline of one heading is not an outline; the app derives instead.
  ok('a thin outline is ignored',
     P.bundleStructure({ outline: [{ title: 'Only One', children: [] }] }) === null);

  // A heading the text no longer holds — the Markdown was truncated at
  // MAX_SOURCE_CHARS — is dropped rather than pointed at the wrong blocks.
  const missing = { sections: [...structure.sections, { title: 'פרק 9 — לא קיים', level: 2 }] };
  ok('a heading that is not in the text is dropped',
     P.locateSections(blocks, missing).length === structure.sections.length);

  // Without the bundle the same Markdown still yields an outline — from its
  // "###" markers — but no page numbers, which is the difference the bundle buys.
  const derived = P.buildSourceDigest(text, 600, null);
  ok('the same Markdown alone still finds headings', derived.includes('[OUTLINE'), derived.slice(0, 60));
  ok('but it cannot invent page numbers', !/pp?\. \d/.test(derived));
}

console.log('\n== chunking ==');
{
  const doc = ['Alpha paragraph about mitochondria and energy production in the cell.',
               'Beta paragraph about ribosomes and protein synthesis machinery.',
               'x'.repeat(3000)].join('\n\n');
  const chunks = P.chunkText(doc);
  ok('chunks produced', chunks.length >= 2, 'n=' + chunks.length);
  ok('no chunk wildly over budget', chunks.every(c => c.length <= 1300), JSON.stringify(chunks.map(c => c.length)));
  const pasted = 'This is pasted text with no blank lines. '.repeat(80);
  ok('wall of pasted text still chunks', P.chunkText(pasted).length > 1);
  ok('tiny input yields nothing', P.chunkText('hi').length === 0);
}

console.log('\n== tier-sized excerpt budget ==');
{
  // topic40 is genuinely discussed in many places, as a real concept in a real
  // document is — so a larger budget has more qualifying material to spend on.
  const doc = [...Array(60)].map((_, i) => {
    const t = (i % 3 === 0) ? 40 : i;
    return `Paragraph ${i} concerns topic${t} and describes the mechanism of topic${t} in detail `
      + `with supporting evidence and worked reasoning about how topic${t} behaves in practice.`;
  }).join('\n\n');
  const concept = { name: 'topic40', description: 'the mechanism of topic40', importance: 'core', examples: [] };

  P.setPlan('basic');
  const basic = P.retrieveExcerpt(concept, doc);
  P.setPlan('max');
  const max = P.retrieveExcerpt(concept, doc);

  ok('basic excerpt within basic budget', basic.length <= 2400, 'len=' + basic.length);
  ok('max excerpt within max budget', max.length <= 16000, 'len=' + max.length);
  ok('max reads more than basic', max.length > basic.length, `${max.length} vs ${basic.length}`);
  ok('excerpt is on-topic', basic.includes('topic40'), basic.slice(0, 120));

  P.setPlan(null);
  ok('signed-out falls back to the smallest budget', P.excerptBudget() === 2400 && P.planReadChars() === 5000);
  P.setPlan('max');
  ok('max plan read budget', P.planReadChars() === 120000);
}

console.log('\n== cacheable course context ==');
{
  // The shared context block is only worth sending because the API caches it,
  // and caching is a prefix match: one differing character on the second lesson
  // turns a ~10%-price read into a fresh full-price write. Nothing about the
  // digest may vary between calls on the same document.
  const doc = [...Array(80)].map((_, i) =>
    `Section ${i} explains mechanism${i} and its consequences at some length, `
    + `with examples of mechanism${i} drawn from practice and a note on limits.`).join('\n\n');

  const a = P.buildSourceDigest(doc, 24000);
  const b = P.buildSourceDigest(doc, 24000);
  ok('the digest is byte-identical when recomputed', a === b,
     a === b ? '' : `${a.length} vs ${b.length}`);

  ok('the digest respects its budget', a.length <= 24000, 'len=' + a.length);
  ok('a different budget is a different block', P.buildSourceDigest(doc, 8000) !== a);

  // Rebuilt after a reload, from the same stored source, it has to match — the
  // cache entry written in the previous session is only reusable if it does.
  ok('a rebuild from the same source matches', P.buildSourceDigest(doc.slice(0), 24000) === a);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

/*
 * The end-to-end check these stand in for
 * ---------------------------------------
 * The cases above drive the pipeline with hand-built geometry. That is enough to
 * pin the logic down, but it cannot prove the geometry itself is read correctly,
 * so the pipeline was also run against real PDFs rendered by Chromium and parsed
 * by real PDF.js (the same 3.11.174 the app loads). Worth repeating by hand
 * after any change to the extraction code:
 *
 *   - A 27-page English textbook with a running header, page-number footers, a
 *     title page, a table of contents and twelve chapters. Confirms the header
 *     and folios are stripped, paragraphs are rebuilt, hyphenated line-wraps are
 *     rejoined, and the digest quotes 8 of 12 chapters at Basic's 5,000-char
 *     budget and all 12 at Pro's 40,000 — where substring(0, 5000) reached 1.
 *
 *   - A Hebrew (RTL) document, because that is what much of the source material
 *     here actually is. This is where the run-ordering bug lived: PDF.js emits
 *     runs in visual order, so every numbered heading ("פרק 2: המיטוכונדריה")
 *     came out inside out, and the outline was empty as a result.
 *
 * Both are reproduced by generating the PDFs with Playwright, loading pdfjs-dist
 * in a page, injecting the functions named in `names` above, and calling
 * extractConceptsFromPDF on the bytes.
 *
 * The upload box, in a real browser
 * ---------------------------------
 * The cases above call the functions; they never open the page. The three kinds
 * of upload were driven through the real DOM once, and are worth repeating after
 * any change to handleFileUpload:
 *
 *   - a bundle from `tools/pdf_prep --bundle`  → read, then the sign-up prompt
 *   - a plain .txt file                        → read, then the sign-up prompt
 *   - a .json that is not a bundle             → "isn't a document bundle", no course
 *
 * The .txt case is a regression guard: .txt was in the picker's accept list but
 * went through the PDF reader, and came back as "make sure it's a valid PDF".
 *
 * Doing it needs a local copy of the two CDN scripts, because index.html loads
 * pdf.js and supabase-js from CDNs that a sandbox usually blocks — and because
 * file:// refuses cross-directory scripts, it has to be served over http:
 *
 *   npm i @supabase/supabase-js@2 pdfjs-dist@3.11.174
 *   cp index.html app.js -t site/ && cp -r fonts site/     # then point the two
 *   #   <script src> tags in site/index.html at the local copies
 *   (cd site && python3 -m http.server 8731)
 *   # Playwright: goto localhost:8731, setInputFiles('#fileInput', file),
 *   # then assert on #authModal.classList.contains('active') — not on
 *   # offsetParent, which is null for any position:fixed modal.
 *
 * Signed-in flows (building a course, generating a lesson) were not driven this
 * way: they need an account and spend real tokens.
 */
