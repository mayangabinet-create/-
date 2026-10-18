// The answer check run on every finished lesson (`verifyLesson` in app.js).
// Lifts the pure parts out of the shipping source — the same way the other
// app.js suites do — and checks what gets taken out of a lesson and what is
// left alone. Run: node tests/lesson-verify.js
const fs = require('fs');
const src = fs.readFileSync(process.argv[2] || require('path').join(__dirname, '..', 'app.js'), 'utf8');

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
  'const VERIFIABLE', 'const MIN_QUIZ_AFTER_VERIFY', 'const VERIFY_EXCERPT_CHARS',
  'function verifiableItems', 'function buildVerifyPrompt',
  'function disputedItems', 'function withoutDisputed',
];
let code = '';
for (const n of names) code += grab(n) + '\n';
code += 'module.exports = { verifiableItems, buildVerifyPrompt, disputedItems, withoutDisputed, VERIFY_EXCERPT_CHARS };';
const P = new Function('module', code + '\nreturn module.exports;')({});

let passed = 0, failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
}

// Shaped like the one real lesson in the database (factoring, Hebrew).
const lesson = () => ({
  quiz: [
    { type: 'choice', text: 'איזה מהביטויים הבאים הוא פירוק של 7x² − 63?',
      options: ['7(x − 3)(x + 3)', '7x(x − 9)', '(7x − 9)(x + 7)', '7(x² − 9)'], correct: 0 },
    { type: 'numeric', text: 'מה a + b?', answer: -5, tolerance: 0, unit: '' },
    { type: 'boolean', text: '400x² + 240x + 36 = 4(10x + 3)²', answer: true },
    { type: 'order', text: 'סדר', items: ['a', 'b'] },
  ],
  challenge: { type: 'choice', text: 'פרק', options: ['−24(3x − 2)²', '−24(3x + 2)²'], correct: 0 },
  practice: { problem: 'פרק x² − 10x + 25', options: ['(x − 5)²', '(x + 5)²'], correct: 0 },
});

console.log('\n== what gets checked ==');
{
  const items = P.verifiableItems(lesson());
  ok('choice, numeric and boolean quiz items are checked', items.filter(i => i.key.startsWith('quiz:')).length === 3);
  ok('an ordering question is not', !items.some(i => i.key === 'quiz:3'));
  ok('the challenge and the practice are checked too',
     items.some(i => i.key === 'challenge') && items.some(i => i.key === 'practice'));

  const prompt = P.buildVerifyPrompt(items, 'x'.repeat(50_000));
  ok('the prompt never shows the answer key', !prompt.includes('"correct"') && !prompt.includes('-5'));
  ok('questions come before the material', prompt.indexOf('QUESTIONS:') < prompt.indexOf('MATERIAL:'));
  ok('the material is capped', prompt.length < P.VERIFY_EXCERPT_CHARS + 3000, String(prompt.length));
}

console.log('\n== what gets taken out ==');
{
  const l = lesson();
  const items = P.verifiableItems(l);
  // The reader agrees with every key but says the unexpanded form is also
  // a right answer — exactly the question a learner was wrongly marked on.
  const reply = { answers: [
    { q: 1, answer: 0, alsoCorrect: [3] },
    { q: 2, answer: -5 },
    { q: 3, answer: true },
    { q: 4, answer: 0, alsoCorrect: [] },
    { q: 5, answer: 0 },
  ] };
  const disputed = P.disputedItems(items, reply);
  ok('a question with a second right answer is disputed', disputed.has('quiz:0'));
  ok('agreed answers are not', disputed.size === 1, [...disputed].join(','));

  const out = P.withoutDisputed(l, disputed);
  ok('the disputed question is removed', out.quiz.length === 3 && !out.quiz.some(q => q.text.includes('7x²')));
  ok('everything else is kept', out.challenge && out.practice);

  const wrongKey = P.disputedItems(items, { answers: [{ q: 2, answer: 5 }, { q: 3, answer: 'false' }, { q: 4, answer: 1 }] });
  ok('a numeric answer off by more than the tolerance is disputed', wrongKey.has('quiz:1'));
  ok('a boolean answered the other way is disputed, even as a string', wrongKey.has('quiz:2'));
  ok('a disputed challenge is dropped, not shown with a bad key',
     P.withoutDisputed(l, wrongKey).challenge === null);
}

console.log('\n== failing open ==');
{
  const l = lesson();
  const items = P.verifiableItems(l);
  ok('no reply disputes nothing', P.disputedItems(items, null).size === 0);
  ok('junk disputes nothing', P.disputedItems(items, { answers: 'nope' }).size === 0);
  ok('a skipped question is kept', P.disputedItems(items, { answers: [{ q: 2, answer: -5 }] }).size === 0);
  ok('nothing disputed returns the same lesson', P.withoutDisputed(l, new Set()) === l);

  const all = new Set(['quiz:0', 'quiz:1', 'quiz:2', 'quiz:3']);
  ok('a check that would empty the quiz leaves the lesson as written', P.withoutDisputed(l, all) === l);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
