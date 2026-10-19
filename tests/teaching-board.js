// The teaching board and the practice sheet (app.js: renderBoard,
// boardController, sketchSvg, normalisePracticeSheet). Lifts the pure parts
// out of the shipping source, the way the other app.js suites do, and runs
// the controller against a minimal stand-in for the DOM.
// Run: node tests/teaching-board.js
const fs = require('fs');
const src = fs.readFileSync(process.argv[2] || require('path').join(__dirname, '..', 'app.js'), 'utf8');

function grab(decl) {
  const idx = src.indexOf(decl);
  if (idx < 0) throw new Error('not found: ' + decl);
  if (decl.startsWith('function')) {
    let i = src.indexOf('{', src.indexOf(')', idx)), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
    }
    throw new Error('unbalanced: ' + decl);
  }
  let depth = 0, inTpl = false;
  for (let i = idx; i < src.length; i++) {
    const c = src[i];
    if (c === '`') inTpl = !inTpl;
    if (inTpl) continue;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0) return src.slice(idx, i + 1);
  }
  throw new Error('no statement end: ' + decl);
}

const names = [
  'function esc(', 'function escAttr(',
  'const BOARD_WORD_MS', 'const ARROW_MS', 'const WRITE_MS_PER_CHAR', 'const WRITE_MIN_MS',
  'const FORMULA_RUN', 'const FORMULA_SIGN', 'function formulaRuns(', 'function inkWords(', 'function wordCount(', 'function writingDir(', 'function writeMs(', 'function penText(',
  'const BOARD_ANSWER_LABEL', 'const sameWorking', 'function renderBoard(', 'function boardController(', 'function sketchSvg(',
  'const PRACTICE_SHEET_SIZE', 'function normalisePracticeSheet(',
];
let code = `
const document = { createElement: () => ({ textContent: '', get innerHTML() {
  return String(this.textContent).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }) };
const prefersReducedMotion = () => true;
const courseLanguage = () => 'Hebrew';
`;
for (const n of names) code += grab(n) + '\n';
code += 'module.exports = { formulaRuns, inkWords, wordCount, writingDir, writeMs, renderBoard, boardController, sketchSvg, normalisePracticeSheet, PRACTICE_SHEET_SIZE };';
const P = new Function('module', code + '\nreturn module.exports;')({});

let passed = 0, failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
}

console.log('\n== writing word by word ==');
{
  const html = P.inkWords('מוציאים גורם 3 <b>');
  ok('each word gets its own numbered span', (html.match(/class="ink"/g) || []).length === 4 && html.includes('--i:3'));
  ok('the text is escaped', html.includes('&lt;') && html.includes('&gt;') && !html.includes('<b>'));
  ok('spaces stay between the words', /<\/span> <span/.test(html));
  ok('numbering can continue from an earlier run', P.inkWords('a b', 5).includes('--i:6'));
  ok('nothing in, nothing out', P.inkWords('') === '' && P.inkWords(null) === '');
}

console.log('\n== formulas in a right-to-left line ==');
{
  const runs = t => P.formulaRuns(t).map(r => t.slice(r.start, r.end));
  ok('a formula inside a Hebrew sentence is found whole', runs('הופך סכום למכפלה: מ־3x + 12 אל 3(x + 4).').join('|') === '3x + 12|3(x + 4)');
  ok("the sentence's full stop stays outside it", !runs('אל 3(x + 4).')[0].endsWith('.'));
  ok('a bare number or word is left alone', runs('את 6 ואת 9').length === 0 && runs('Answer').length === 0);
  ok('an option that is all formula is one run', runs('4(x − 3)').join('|') === '4(x − 3)');
  ok('a squared term and an equation count', runs('x² − 9 = 0').join('|') === 'x² − 9 = 0');
  const html = P.inkWords('מ־3x + 12 אל 3(x + 4)');
  ok('the word-by-word reveal keeps a formula in one piece', html.includes('>3(x + 4)</span>') && html.includes('>3x + 12</span>'));
}

console.log('\n== which way the pen writes ==');
{
  ok('a formula is written left to right', P.writingDir('(x − 3)(x + 3)') === 'ltr' && P.writingDir('4x − 12') === 'ltr');
  ok('Hebrew is written right to left', P.writingDir('מוציאים את 3') === 'rtl');
  ok('a Hebrew sentence that starts with a number is still Hebrew', P.writingDir('3 מחלק את שניהם') === 'rtl');
  ok('a long line is written slower than a short one, within limits',
     P.writeMs('x') >= 300 && P.writeMs('x'.repeat(20)) > P.writeMs('x') && P.writeMs('x'.repeat(500)) <= 1500);
}

console.log('\n== the board ==');
const lines = [{ text: 'x² − 9', note: 'הפרש ריבועים' }, { text: '(x − 3)(x + 3)', note: 'לפי הנוסחה' }];
{
  const html = P.renderBoard({ id: 'b', problem: 'פרקו x² − 9', lines, answer: '(x − 3)(x + 3)' });
  ok('the exercise is written at the top', /class="board-problem">.*פרקו x² − 9/.test(html));
  ok('every step starts hidden', (html.match(/data-board-line[^>]*hidden/g) || []).length === 2);
  ok('the reason for each step is written above its arrow', (html.match(/bd-label/g) || []).length === 2 && html.indexOf('הפרש ריבועים') < html.indexOf('>x² − 9<'));
  ok('the steps alternate sides, so the arrows cross the board',
     html.indexOf('side-start') < html.indexOf('side-end'));
  ok('an answer that is the last line again is not written twice',
     (html.match(/data-board-line/g) || []).length === 2 && /is-final/.test(html));
  const separate = P.renderBoard({ lines, answer: 'x = ±3' });
  ok('a different answer is its own last step, labelled in the lesson language',
     (separate.match(/data-board-line/g) || []).length === 3 && separate.includes('תשובה') && /is-final[^]*x = ±3/.test(separate));
  ok('the reason is written after the arrow, and the expression after the reason',
     /--label-at:500ms; --label-ms:\d+ms; --expr-at:(\d+)ms/.test(html) && Number(html.match(/--expr-at:(\d+)ms/)[1]) > 500);
  ok('a formula and a Hebrew reason get their own writing direction',
     /dir="rtl"><span class="pen-text">הפרש ריבועים/.test(html) && /dir="ltr"><span class="pen-text">x² − 9/.test(html));
  ok('everything is escaped', !P.renderBoard({ lines: [{ text: '<b>x</b>' }] }).includes('<b>'));
}

console.log('\n== playing it one tap at a time ==');
{
  const parts = [0, 1, 2].map(() => ({ hidden: true, classList: { add() {} }, querySelector: () => null }));
  const root = { querySelectorAll: () => parts, querySelector: () => null };
  let changes = 0;
  const ctl = P.boardController(root, { onChange: () => changes++ });
  ok('nothing is drawn before the first tap', parts.every(p => p.hidden) && ctl.written() === 0);
  ctl.step();
  ok('one tap plays one step', !parts[0].hidden && parts[1].hidden && ctl.written() === 1 && changes === 1);
  ctl.all();
  ok('"show all" plays the rest', parts.every(p => !p.hidden) && ctl.done());
  ok('and a tap past the end does nothing', ctl.step() === false);
  ok('a missing board is an empty one, not a crash', P.boardController(null).done());
}

console.log('\n== figures that look drawn ==');
{
  const one = P.sketchSvg('<svg viewBox="0 0 10 10"><line/></svg>');
  ok('an SVG is wrapped in the sketch filter', one === '<svg viewBox="0 0 10 10"><g filter="url(#sketchy)"><line/></g></svg>');
  const two = P.sketchSvg('<div><svg a="1"><x/></svg><svg><y/></svg></div>');
  ok('each of several SVGs gets its own group', (two.match(/<g filter/g) || []).length === 2 && (two.match(/<\/g><\/svg>/g) || []).length === 2);
  ok('an HTML figure passes through untouched', P.sketchSvg('<table><tr><td>1</td></tr></table>') === '<table><tr><td>1</td></tr></table>');
}

console.log('\n== a practice sheet ==');
{
  const sheet = P.normalisePracticeSheet({ exercises: [
    { problem: 'פרקו 5x − 15', steps: [{ line: '5(x − 3)', why: 'גורם משותף 5' }], answer: '5(x − 3)', answerNumber: null },
    { problem: 'פתרו x² = 4x', steps: ['x² − 4x = 0', { action: 'x(x − 4) = 0' }], answer: 'x = 0 או x = 4', answerNumber: 'abc' },
    { problem: 'כמה זה 2+3', steps: [{ line: '5' }], answer: '5', answerNumber: '5' },
    { problem: '', steps: [{ line: 'x' }], answer: '1' },
    { problem: 'no working', steps: [], answer: '1' },
  ] });
  ok('exercises with no problem or no working are dropped', sheet.exercises.length === 3);
  ok('steps given as plain strings or as actions are read', sheet.exercises[1].steps.map(s => s.line).join('|') === 'x² − 4x = 0|x(x − 4) = 0');
  ok('a numeric answer is kept as a number', sheet.exercises[2].answerNumber === 5);
  ok('a non-number answerNumber becomes null, so it is not checked', sheet.exercises[1].answerNumber === null && sheet.exercises[0].answerNumber === null);
  ok('the sheet is dated', typeof sheet.createdAt === 'string');
  ok('nothing usable is no sheet', P.normalisePracticeSheet({ exercises: [{ problem: 'x' }] }) === null && P.normalisePracticeSheet(null) === null);
  const many = P.normalisePracticeSheet({ exercises: Array.from({ length: 20 }, (_, i) => ({ problem: 'p' + i, steps: ['s'], answer: 'a' })) });
  ok('and an overlong one is cut to size', many.exercises.length === P.PRACTICE_SHEET_SIZE + 2);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
