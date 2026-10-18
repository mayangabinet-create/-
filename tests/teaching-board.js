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
  'const BOARD_WORD_MS', 'const BOARD_NOTE_GAP_MS',
  'function inkWords(', 'function wordCount(', 'const BOARD_ARROW', 'const BOARD_UNDERLINE',
  'const BOARD_ANSWER_LABEL', 'function renderBoard(', 'function boardController(', 'function sketchSvg(',
  'const PRACTICE_SHEET_SIZE', 'function normalisePracticeSheet(',
];
let code = `
const document = { createElement: () => ({ textContent: '', get innerHTML() {
  return String(this.textContent).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }) };
const prefersReducedMotion = () => true;
const courseLanguage = () => 'Hebrew';
`;
for (const n of names) code += grab(n) + '\n';
code += 'module.exports = { inkWords, wordCount, renderBoard, boardController, sketchSvg, normalisePracticeSheet, PRACTICE_SHEET_SIZE };';
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
  ok('the text is escaped', html.includes('&lt;b&gt;') && !html.includes('<b>'));
  ok('spaces stay between the words', /<\/span> <span/.test(html));
  ok('numbering can continue from an earlier run', P.inkWords('a b', 5).includes('--i:6'));
  ok('nothing in, nothing out', P.inkWords('') === '' && P.inkWords(null) === '');
}

console.log('\n== the board ==');
const lines = [{ text: 'x² − 9', note: 'הפרש ריבועים' }, { text: '(x − 3)(x + 3)' }];
{
  const html = P.renderBoard({ id: 'b', problem: 'פרקו x² − 9', lines, answer: '(x − 3)(x + 3)' });
  ok('the problem is shown from the start', /class="board-problem">פרקו x² − 9</.test(html));
  ok('every line starts hidden', (html.match(/data-board-line[^>]*hidden/g) || []).length === 2);
  ok('a note comes with a drawn arrow', (html.match(/board-arrow/g) || []).length === 1);
  ok('a line without a note gets no arrow', !/board-num[^]*2[^]*board-arrow/.test(html.split('data-board-line').pop()));
  ok('the answer is last, hidden, and underlined', /data-board-answer[^>]*hidden/.test(html) && html.includes('board-underline'));
  ok("a note waits for its line's words", html.includes('--note-delay:385ms'), html.match(/--note-delay:\d+ms/)?.[0]);
  ok('no answer, no answer block', !P.renderBoard({ lines }).includes('data-board-answer'));
}

console.log('\n== writing it one tap at a time ==');
{
  const parts = [0, 1, 2].map(() => ({ hidden: true }));
  const root = { querySelectorAll: () => parts };
  let changes = 0;
  const ctl = P.boardController(root, { onChange: () => changes++ });
  ok('nothing is written before the first tap', parts.every(p => p.hidden) && ctl.written() === 0);
  ctl.step();
  ok('one tap writes one line', !parts[0].hidden && parts[1].hidden && ctl.written() === 1 && changes === 1);
  ctl.all();
  ok('"show all" writes the rest', parts.every(p => !p.hidden) && ctl.done());
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
