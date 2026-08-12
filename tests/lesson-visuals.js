/*
 * The lesson toolkit: the figures a lesson can draw, the interactive widgets it
 * can carry, the question types it can be graded on, and the prompt that asks
 * for all of it.
 *
 *     node tests/lesson-visuals.js
 *
 * Same trick as tests/pdf-pipeline.js — app.js is a plain browser script with no
 * module system, so the functions under test are lifted out of the source by
 * name and compiled on their own. The tests then run the shipping code rather
 * than a copy of it that can drift.
 *
 * The one thing shimmed is the browser: `esc()` escapes by round-tripping
 * through a DOM node, so the harness supplies the two DOM methods it uses and
 * nothing else. Everything above that line — geometry, arithmetic, gematria,
 * validation, markup — is the real thing.
 *
 * Why this file exists at all: every one of these is a place where a wrong
 * answer is silent. A triangle drawn from lengths that cannot close, a slider
 * whose formula does not evaluate, a gematria total that is off by one, a
 * prompt that overruns the server's allowance and loses its own schema — none
 * of them throw. They just teach the learner something false.
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'app.js'), 'utf8');

// Grab a top-level `function name(...) {...}` or `const NAME = ...;` by matching braces.
function grab(decl) {
  const idx = src.indexOf(decl);
  if (idx < 0) throw new Error('not found: ' + decl);

  if (decl.startsWith('function')) {
    // Walk past the parameter list before looking for the body. A default value
    // — `function visShape(v, opts = {})` — otherwise looks like the body, and
    // gets matched shut on the spot, one character in.
    let i = src.indexOf('(', idx), parens = 0;
    for (; i < src.length; i++) {
      if (src[i] === '(') parens++;
      else if (src[i] === ')' && --parens === 0) { i++; break; }
    }
    i = src.indexOf('{', i);
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
    }
    throw new Error('unbalanced: ' + decl);
  }
  let depth = 0, inStr = null;
  for (let i = idx; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0) return src.slice(idx, i + 1);
  }
  throw new Error('no statement end: ' + decl);
}

const names = [
  // escaping and formatting
  'function esc(s)', 'function escAttr', 'function fmtNum', 'const num =',
  // the safe evaluator
  'const EXPR_FUNCS', 'const EXPR_CONSTS', 'function evalExpr', 'function tryExpr',
  // geometry
  'const SHAPE_W', 'function regularPolygon', 'function triangleFromSides',
  'function shapeGeometry', 'function fitPoints', 'const unit = ([x, y])', 'function vertexAngles',
  // renderers, old and new
  'function visFlow', 'function visCompare', 'function visHierarchy', 'function visTimeline',
  'function visTable', 'function visBar', 'function visShape', 'function visFormula',
  'function visEquation', 'function visNumberline', 'const plotPoints', 'function visPlot',
  'function visPie', 'function visVenn', 'function visCycle', 'function visGrid',
  // gematria
  'const GEMATRIA_LETTERS', 'const GEMATRIA_FINALS', 'const GEMATRIA_FINAL_HIGH',
  'const GEMATRIA_BASE', 'const GEMATRIA_ORDINAL', 'const GEMATRIA_METHOD_NAMES',
  'function gematriaValue', 'function gematriaBreakdown', 'function gematriaTiles',
  'function visGematria',
  // interactive
  'function visReveal', 'function sliderSpec', 'function visSlider',
  // templates
  'function tNum', 'function tStr', 'function tList', 'function tWords',
  'const withUnit', 'function polynomial', 'function samplePoints', 'function evalBool',
  'const TEMPLATES', 'function expandTemplate', 'function templateCatalogue',
  // the registries and what reads them
  'const VISUALS', 'function drawSpec', 'function validVisual', 'function visualCatalogue',
  'const QUESTION_TYPES', 'function questionCatalogue', 'const KIND_PLAYBOOK',
  'function normaliseQuestion',
  // the prompt
  'const RTL_LANGUAGES', 'function courseLanguage', 'function languageRule',
  'function buildLessonPrompt',
];

// The browser, in as few lines as it takes: esc() sets textContent and reads
// innerHTML back, which is exactly the escaping being relied on.
let code = `
let visualSeq = 0;
let courseData = { language: 'English' };
const document = {
  createElement: () => ({
    textContent: '',
    get innerHTML() {
      return String(this.textContent)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  }),
};
`;
for (const n of names) code += '\n' + grab(n) + '\n';
code += `
module.exports = { evalExpr, tryExpr, fmtNum, triangleFromSides, shapeGeometry, fitPoints,
  vertexAngles, regularPolygon, gematriaValue, gematriaBreakdown, sliderSpec, validVisual,
  normaliseQuestion, visShape, visSlider, visGematria, visPie, visNumberline, visEquation,
  VISUALS, QUESTION_TYPES, KIND_PLAYBOOK, visualCatalogue, questionCatalogue,
  TEMPLATES, expandTemplate, templateCatalogue, evalBool, tNum, tList, drawSpec,
  buildLessonPrompt, setLanguage: l => { courseData = { language: l }; } };
`;

const m = new module.constructor();
m._compile(code, '/lesson-visuals.js');
const P = m.exports;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
};
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------- evaluator
console.log('\n== the expression evaluator ==');
{
  ok('arithmetic, with precedence', P.evalExpr('2 + 3 * 4') === 14);
  ok('parentheses beat precedence', P.evalExpr('(2 + 3) * 4') === 20);
  ok('unary minus', P.evalExpr('-3 + 10') === 7);
  ok('variables', P.evalExpr('b * h / 2', { b: 4, h: 6 }) === 12);
  ok('powers are right-associative', P.evalExpr('2 ^ 3 ^ 2') === 512);
  ok('** is read as a power, not two stars', P.evalExpr('3 ** 2') === 9);
  ok('functions from the allowed list', P.evalExpr('sqrt(16) + max(1, 5)') === 9);
  ok('typographic operators are normalised', P.evalExpr('3 × 4 ÷ 2') === 6);

  // The reason this parser exists rather than `new Function`.
  const hostile = [
    'process.exit(1)',
    'globalThis.x = 1',
    'constructor.constructor("return 1")()',
    'fetch("http://example.com")',
    '(() => 1)()',
  ];
  ok('nothing outside the grammar evaluates',
     hostile.every(s => P.tryExpr(s, {}) === null),
     hostile.filter(s => P.tryExpr(s, {}) !== null).join(', '));
  ok('an unknown name is an error, not a silent zero', P.tryExpr('x + y', { x: 1 }) === null);
  ok('division by zero is not a number', P.tryExpr('1 / 0') === null);
  ok('trailing junk is rejected', P.tryExpr('2 + 2 oops') === null);

  ok('numbers are formatted for a reader', P.fmtNum(6.0) === '6' && P.fmtNum(2.4999999999) === '2.5');
}

// ---------------------------------------------------------------- geometry
console.log('\n== geometry ==');
{
  const t = P.triangleFromSides([3, 4, 5]);
  ok('a 3-4-5 triangle closes', !!t);
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  ok('and is drawn at its own measurements',
     close(len(t[0], t[1]), 3) && close(len(t[1], t[2]), 4) && close(len(t[2], t[0]), 5));

  const angles = P.vertexAngles(t);
  // 3-4-5: the right angle is between the sides of 3 and 4, at vertex 1.
  ok('so the right angle really is 90 degrees', close(angles[1], 90, 1e-6),
     JSON.stringify(angles.map(a => a.toFixed(2))));

  ok('lengths that cannot close are refused', P.triangleFromSides([1, 2, 10]) === null);
  ok('a degenerate triangle is refused', P.triangleFromSides([1, 2, 3]) === null);
  ok('negative and non-numeric lengths are refused',
     P.triangleFromSides([-3, 4, 5]) === null && P.triangleFromSides(['a', 4, 5]) === null);

  // Bad measurements must not lose the figure: the shape still draws, unscaled.
  const fallback = P.shapeGeometry({ shape: 'triangle', sides: [1, 2, 10] });
  ok('a triangle with impossible sides still draws as a triangle',
     fallback && fallback.points.length === 3);

  const sq = P.shapeGeometry({ shape: 'square', sides: [2] });
  const sqAngles = P.vertexAngles(P.fitPoints(sq.points));
  ok('a square has four right angles', sqAngles.length === 4 && sqAngles.every(a => close(a, 90, 1e-6)));

  const hex = P.shapeGeometry({ shape: 'polygon', n: 6 });
  ok('a polygon takes the number of sides asked for', hex.points.length === 6);
  ok('an absurd side count is clamped, not obeyed',
     P.shapeGeometry({ shape: 'polygon', n: 900 }).points.length === 12);

  const box = P.fitPoints(P.regularPolygon(5));
  ok('every point lands inside the drawing box',
     box.every(([x, y]) => x >= 0 && x <= 320 && y >= 0 && y <= 230));

  const svg = P.visShape({ shape: 'right-triangle', sides: [3, 4, 5],
                           sideLabels: ['a', 'b', 'c'], vertices: ['A', 'B', 'C'] });
  ok('the drawn figure marks its right angle', svg.includes('geo-right-angle'));
  ok('and labels every side', ['>a<', '>b<', '>c<'].every(s => svg.includes(s)));
  ok('a static figure has no touch targets', !svg.includes('geo-edge-hit'));
  ok('an interactive one does',
     P.visShape({ shape: 'triangle' }, { interactive: true }).includes('geo-edge-hit'));

  // A label is model output and lands inside an SVG attribute and a text node.
  const nasty = P.visShape({ shape: 'square', caption: '"><script>x</script>', sideLabels: ['<b>'] });
  ok('a caption cannot break out of the attribute it is written into',
     !nasty.includes('<script>') && nasty.includes('&quot;&gt;&lt;script&gt;'), nasty.slice(0, 200));
  ok('and a side label cannot inject a tag', !nasty.includes('<b>') && nasty.includes('&lt;b&gt;'));
}

// ---------------------------------------------------------------- gematria
console.log('\n== gematria ==');
{
  const std = P.gematriaBreakdown('אמת');
  ok('א+מ+ת = 441', std.total === 441, JSON.stringify(std));
  ok('and every letter is broken out', std.letters.length === 3);

  ok('a final letter takes its base value by default', P.gematriaValue('ם') === 40);
  ok('mispar gadol is where it takes 600', P.gematriaValue('ם', 'gadol') === 600);
  ok('ordinal counts places, not values', P.gematriaValue('ת', 'ordinal') === 22);
  ok('katan drops the trailing zeros',
     P.gematriaValue('ת', 'katan') === 4 && P.gematriaValue('כ', 'katan') === 2
     && P.gematriaValue('ז', 'katan') === 7);

  ok('vowels, spaces and punctuation are skipped, not counted',
     P.gematriaBreakdown('שָׁלוֹם!').total === P.gematriaBreakdown('שלום').total);
  ok('a word with no Hebrew in it has nothing to add up',
     P.gematriaBreakdown('hello').letters.length === 0);

  // The whole point of computing rather than quoting: the model's own sum is
  // never shown, so a lesson cannot teach 442.
  const html = P.visGematria({ words: [{ word: 'אמת', note: 'truth', total: 999 }] });
  ok('the app shows its own total, not the model\'s', html.includes('>441<') && !html.includes('999'));
}

// ---------------------------------------------------------------- validation
console.log('\n== what survives validation ==');
{
  // `group` is produced by templates, never asked of the model, so it is the
  // one type held to the first rule and not the rest.
  const offered = Object.entries(P.VISUALS).filter(([, d]) => !d.internal);
  ok('every type can be validated and drawn',
     Object.entries(P.VISUALS).every(([, d]) => typeof d.check === 'function' && typeof d.draw === 'function'
                                                && typeof d.use === 'string' && typeof d.spec === 'string'));
  ok('every spec in the catalogue is valid JSON',
     offered.every(([, d]) => { try { JSON.parse(d.spec); return true; } catch (_) { return false; } }));
  const broken = offered.filter(([name, d]) => {
    const spec = JSON.parse(d.spec);
    return !(P.validVisual(spec) && spec.type === name && d.draw(spec, {}).length > 0);
  }).map(([n]) => n);
  ok('and every spec passes its own check and draws something', !broken.length, broken.join(', '));
  ok('an internal type is never offered to the model',
     !P.visualCatalogue().includes('"group"'));
  ok('and a group cannot contain a group',
     P.validVisual({ type: 'group', items: [{ type: 'group', items: [] }] }) === null);

  ok('an unknown type is dropped', P.validVisual({ type: 'sculpture' }) === null);
  ok('a type with nothing in it is dropped', P.validVisual({ type: 'flow', steps: ['only one'] }) === null);
  ok('a hostile spec fails closed rather than throwing',
     P.validVisual({ type: 'bar', get bars() { throw new Error('boom'); } }) === null);

  // A slider whose formula cannot be evaluated would show a live "—" forever.
  ok('a slider with an unevaluable formula is not a slider',
     P.sliderSpec({ min: 0, max: 10, outputs: [{ label: 'x', expr: 'window.location' }] }) === null);
  ok('a slider with an inverted range is refused',
     P.sliderSpec({ min: 10, max: 1, outputs: [{ label: 'x', expr: 'x' }] }) === null);
  const slider = P.sliderSpec({ variable: 'b', min: 1, max: 12, value: 4,
                                constants: { h: 6 }, outputs: [{ label: 'Area', expr: 'b * h / 2' }] });
  ok('a good one keeps its constants and computable outputs',
     slider && slider.constants.h === 6 && slider.outputs.length === 1);
  ok('and its starting value is inside its own range',
     slider.value >= slider.min && slider.value <= slider.max);
}

// ---------------------------------------------------------------- templates
console.log('\n== templates ==');
{
  const ids = Object.keys(P.TEMPLATES);
  ok(`there are ${ids.length} of them, each with a domain, a use and params`,
     ids.every(id => { const t = P.TEMPLATES[id];
       return Array.isArray(t.domains) && t.domains.length && t.use && t.params && typeof t.build === 'function'; }));

  // The point of the whole layer: a template asked for by name, with no
  // parameters at all, still produces something drawable.
  const emptyFail = ids.filter(id => !P.validVisual({ template: id }));
  ok('every template builds from its defaults alone', !emptyFail.length, emptyFail.join(', '));

  const drawFail = ids.filter(id => { const spec = P.validVisual({ template: id });
    return !spec || !P.drawSpec(spec, {}).length; });
  ok('and everything it builds actually draws', !drawFail.length, drawFail.join(', '));

  // Model output is not to be trusted with types. Nothing here may throw.
  const junk = [{}, { a: 'x' }, { values: 'not a list' }, { n: 1e9 }, { r: -5 },
                { a: null, b: undefined }, { values: [] }, { expression: '((' }];
  const threw = [];
  for (const id of ids) for (const params of junk) {
    try { P.validVisual({ template: id, params }); } catch (e) { threw.push(id + ': ' + e.message); }
  }
  ok('junk parameters are survived, never thrown on', !threw.length, threw.slice(0, 3).join('; '));

  ok('an unknown template is dropped', P.validVisual({ template: 'teleporter' }) === null);
  ok('a template that cannot build returns nothing, not a broken figure',
     P.validVisual({ template: 'triangle', params: { a: 1, b: 2, c: 99 } }) === null);
  ok('a stored lesson keeps the expansion, not the call',
     P.validVisual({ template: 'circle', params: { r: 2 } }).type === 'group');

  // What the layer exists for: the arithmetic is the app's.
  const rt = P.validVisual({ template: 'right-triangle', params: { a: 6, b: 8 } });
  ok('the hypotenuse is computed, not quoted',
     JSON.stringify(rt).includes('"10"') || JSON.stringify(rt).includes('10'),
     JSON.stringify(rt).slice(0, 200));
  ok('and the triangle is built at those measurements',
     rt.items[0].sides[2] === 10);

  const solved = P.validVisual({ template: 'solve-linear', params: { a: 3, b: -6, c: 9 } });
  ok('the algebra is worked by the app', solved.lines.at(-1).expr === 'x = 5', JSON.stringify(solved.lines));

  const compound = P.validVisual({ template: 'compound-interest', params: { principal: 1000, ratePercent: 10, years: 2 } });
  ok('compound interest lands on the right figure',
     JSON.stringify(compound).includes('1210'), JSON.stringify(compound).slice(-160));

  const bin = P.validVisual({ template: 'binary-number', params: { value: 42 } });
  ok('a number is converted to binary correctly', bin.caption.includes('101010'), bin.caption);

  const search = P.validVisual({ template: 'binary-search', params: { values: [1, 3, 5, 7, 9, 11], target: 11 } });
  ok('a binary search is actually run, and finds what is there',
     JSON.stringify(search).includes('found it'));
  ok('and reports honestly when it is not',
     JSON.stringify(P.validVisual({ template: 'binary-search', params: { values: [1, 3, 5], target: 4 } }))
       .includes('not in the list'));

  const stats = P.validVisual({ template: 'summary-stats', params: { values: [2, 4, 4, 4, 5, 5, 7, 9] } });
  ok('mean and standard deviation are computed',
     JSON.stringify(stats).includes('mean = 5') && JSON.stringify(stats).includes('deviation 2'),
     JSON.stringify(stats).slice(-220));

  const poly = P.validVisual({ template: 'polygon-angles', params: { n: 8 } });
  ok('an octagon knows its interior angle', poly.caption.includes('135'), poly.caption);
}

console.log('\n== boolean logic ==');
{
  const t = { A: true, B: false };
  ok('and / or / not', P.evalBool('A and not B', t) === true && P.evalBool('B or (A and B)', t) === false);
  ok('symbols read the same as words', P.evalBool('A ∧ ¬B', t) === true);
  ok('implication is not conjunction', P.evalBool('A -> B', t) === false && P.evalBool('B -> A', t) === true);
  ok('xor and iff', P.evalBool('A xor B', t) === true && P.evalBool('A iff B', t) === false);
  ok('precedence: and binds tighter than or',
     P.evalBool('F or T and T', { T: true, F: false }) === true);
  ok('"android" is a variable, not "and"', P.evalBool('android', { android: true }) === true);
  let threw = false;
  try { P.evalBool('A and', t); } catch (_) { threw = true; }
  ok('an unfinished expression is an error', threw);

  const table = P.validVisual({ template: 'truth-table', params: { expression: 'A or B', variables: ['A', 'B'] } });
  ok('a truth table has a row per combination', table.cells.length === 4);
  // Rows count up in binary, F F first, which is the order the rest of the
  // course's own tables will be in.
  ok('and every row is right',
     JSON.stringify(table.cells) === JSON.stringify([['F','F','F'],['F','T','T'],['T','F','T'],['T','T','T']]),
     JSON.stringify(table.cells));
  ok('an expression that will not parse produces no table',
     P.validVisual({ template: 'truth-table', params: { expression: 'A nand B' } }) === null);
}

// ---------------------------------------------------------------- questions
console.log('\n== questions ==');
{
  const numeric = P.normaliseQuestion({ type: 'numeric', text: 'Area?', answer: 6, tolerance: 0.5, unit: ' cm²' });
  ok('a numeric question keeps its answer and tolerance',
     numeric && numeric.answer === 6 && numeric.tolerance === 0.5);
  ok('one with no number to grade against is dropped',
     P.normaliseQuestion({ type: 'numeric', text: 'Area?', answer: 'six' }) === null);
  ok('a negative tolerance cannot widen into a negative window',
     P.normaliseQuestion({ type: 'numeric', text: 'x', answer: 1, tolerance: -5 }).tolerance === 5);

  const hot = P.normaliseQuestion({
    type: 'hotspot', text: 'Tap the hypotenuse', target: 'side:2',
    visual: { type: 'shape', shape: 'right-triangle', sides: [3, 4, 5] },
  });
  ok('a hotspot question keeps its figure and target', hot && hot.target === 'side:2');
  ok('a target that names no part of the figure is dropped',
     P.normaliseQuestion({ type: 'hotspot', text: 'x', target: 'side:9',
                           visual: { type: 'shape', shape: 'triangle' } }) === null);
  ok('a hotspot on something that is not a shape is dropped',
     P.normaliseQuestion({ type: 'hotspot', text: 'x', target: 'side:0',
                           visual: { type: 'flow', steps: ['a', 'b'] } }) === null);
  ok('a malformed target is dropped',
     P.normaliseQuestion({ type: 'hotspot', text: 'x', target: 'the long one',
                           visual: { type: 'shape', shape: 'triangle' } }) === null);

  const withFigure = P.normaliseQuestion({
    type: 'choice', text: 'Which?', options: ['a', 'b'], correct: 1,
    visual: { type: 'formula', expression: 'A = b·h/2' },
  });
  ok('any question may carry a figure', withFigure.visual?.type === 'formula');
  ok('an unusable figure is dropped and the question survives',
     P.normaliseQuestion({ type: 'choice', text: 'Which?', options: ['a', 'b'],
                           visual: { type: 'nonsense' } })?.visual === null);
  ok('a legacy question with no type is still a choice',
     P.normaliseQuestion({ text: 'q', options: ['a', 'b'], correct: 0 }).type === 'choice');
}

// ---------------------------------------------------------------- the prompt
console.log('\n== the lesson prompt ==');
(async () => {
  const { PLANS, TEMPLATE_ALLOWANCE } = await import('../supabase/functions/ai-proxy/policy.mjs');

  const concept = { name: 'Area of a triangle', description: 'Half the base times the height.',
                    importance: 'It underlies every polygon area.', kind: 'geometry' };

  ok('the catalogue lists every type the app offers',
     Object.entries(P.VISUALS).filter(([, d]) => !d.internal)
       .every(([t]) => P.visualCatalogue().includes(`"${t}"`)));
  ok('and every type it can grade',
     Object.keys(P.QUESTION_TYPES).every(t => P.questionCatalogue().includes(`"${t}"`)));

  const prompt = P.buildLessonPrompt(concept, 'SOURCE');
  ok('the concept kind brings its playbook into the prompt',
     prompt.includes(P.KIND_PLAYBOOK.geometry));
  ok('an unknown kind is left out rather than passed through',
     !P.buildLessonPrompt({ ...concept, kind: 'interpretive dance' }, 'S').includes('interpretive dance'));
  ok('a course with no kind at all still builds a prompt',
     P.buildLessonPrompt({ name: 'x', description: 'y', importance: 'z' }, 'S').length > 0);

  P.setLanguage('Hebrew');
  ok('the language rule follows the course', P.buildLessonPrompt(concept, 'S').includes('Hebrew'));
  P.setLanguage('English');

  // Only the concept's own subject reaches the prompt, so the size to guard is
  // the largest shelf — whichever domain has the most templates.
  const domains = [...new Set(Object.values(P.TEMPLATES).flatMap(t => t.domains))];
  ok('every template is reachable from the domain it claims',
     domains.every(d => P.templateCatalogue(d).length > 0));
  ok('a concept with no domain is offered no templates', P.templateCatalogue('other') === '');
  ok('and one with a domain is offered its own',
     P.buildLessonPrompt({ ...concept, domain: 'math' }, 'S').includes('"right-triangle"'));
  ok('but not another subject\'s',
     !P.buildLessonPrompt({ ...concept, domain: 'math' }, 'S').includes('"ohms-law"'));

  const widest = domains.map(d => ({ d, n: P.buildLessonPrompt({ ...concept, domain: d }, '').length }))
                        .sort((a, b) => b.n - a.n)[0];

  // The prompt and the retrieved passage share one block, and the server
  // clamps that block. Overrun it and the tail is cut — which is the JSON
  // schema, the quantities, and the language rule.
  for (const [name, plan] of Object.entries(PLANS)) {
    const total = widest.n + plan.excerptChars;
    ok(`the ${name} prompt fits inside what the server will forward`,
       total <= plan.excerptChars + TEMPLATE_ALLOWANCE,
       `template ${widest.n} + excerpt ${plan.excerptChars} = ${total} > ${plan.excerptChars + TEMPLATE_ALLOWANCE}`);
  }
  // Headroom, so the next few templates are caught here rather than by a
  // learner opening a lesson whose prompt lost its own schema.
  ok('with room left for the templates after these',
     TEMPLATE_ALLOWANCE - widest.n >= 500, `only ${TEMPLATE_ALLOWANCE - widest.n} chars spare`);
  console.log(`       (widest prompt is ${widest.d}, ${widest.n} chars of the ${TEMPLATE_ALLOWANCE} allowed)`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
