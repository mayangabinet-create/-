/*
 * The parts of app.js that decide *what a learner is told is true* about their
 * own progress, and the parsers that stand between a model's raw output (or a
 * typed answer) and the app trusting it:
 *
 *   - the SM-2 review scheduler, which decides when a finished lesson comes
 *     back and how much easier or harder it gets each time;
 *   - extractJSON, which turns a possibly-truncated model response into an
 *     object without the caller ever seeing a parse error;
 *   - parseLearnerNumber, which reads a typed answer — fractions, comma
 *     decimals, RTL minus signs — before it is compared to the right one;
 *   - the material-report queue, and a handful of small pure numbers (XP,
 *     cost, plan budgets) nothing else exercises.
 *
 *     node tests/learning-state.js
 *
 * Same trick as the other suites: app.js is a plain browser script with no
 * module system, so the functions under test are lifted out by name and
 * compiled on their own, and the tests run the shipping code rather than a
 * copy of it.
 *
 * Every one of these fails silently. A wrong ease factor does not throw, it
 * just reviews a concept too often or too rarely forever. A mis-parsed "1/2"
 * does not throw, it marks a correct answer wrong.
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'app.js'), 'utf8');

// Grab a top-level `function name(...) {...}` or `const NAME = ...;` by
// matching braces/parens over the *code*, not the raw characters — a naive
// counter desyncs on comments with an apostrophe ("SM-2's", "doesn't") and
// on regex literals with a literal `{}` in them (parseLearnerNumber's
// `\d{3}`), both of which appear in the functions this suite lifts out.
// `next(i)` walks past whatever opaque token (string/template/comment/regex)
// starts at src[i], or returns null if src[i] is ordinary code.
function next(i) {
  const c = src[i], c2 = src[i + 1];
  if (c === '/' && c2 === '/') {
    const nl = src.indexOf('\n', i);
    return nl === -1 ? src.length : nl + 1;
  }
  if (c === '/' && c2 === '*') {
    const end = src.indexOf('*/', i + 2);
    return end === -1 ? src.length : end + 2;
  }
  if (c === '"' || c === "'" || c === '`') {
    let j = i + 1;
    for (; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (src[j] === c) return j + 1;
    }
    return src.length;
  }
  return null;
}
// A `/` is a regex literal rather than division based on what code precedes
// it — division follows a value (identifier, number, `)`, `]`), a regex
// follows an operator, an opener, or nothing at all.
function isRegexStart(lastSig) {
  return !lastSig || !/[A-Za-z0-9_$)\]]/.test(lastSig);
}
function skipRegex(i) {
  let j = i + 1, inClass = false;
  for (; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === '\n') return i + 1;   // not actually a regex; bail out
    if (src[j] === '[') inClass = true;
    else if (src[j] === ']') inClass = false;
    else if (src[j] === '/' && !inClass) { j++; break; }
  }
  while (j < src.length && /[a-z]/i.test(src[j])) j++;
  return j;
}

function grab(decl) {
  const idx = src.indexOf(decl);
  if (idx < 0) throw new Error('not found: ' + decl);
  // `async function f()` is asked for as `function f` like any other, and the
  // keyword in front of it has to come along or the body stops compiling.
  const start = src.slice(idx - 6, idx) === 'async ' ? idx - 6 : idx;

  if (decl.startsWith('function')) {
    // First skip the parameter list itself (paren-depth only, so a default
    // like `function f(a = {})` doesn't hand its brace to the body counter),
    // then count braces from the body's opening `{`.
    let i = idx, lastSig = '', parens = 0, started = false;
    for (; i < src.length; i++) {
      const skip = next(i);
      if (skip !== null) { i = skip - 1; continue; }
      const c = src[i];
      if (c === '/' && isRegexStart(lastSig)) { i = skipRegex(i) - 1; lastSig = '/'; continue; }
      if (c === '(') { parens++; started = true; }
      else if (c === ')') { parens--; if (started && parens === 0) { i++; break; } }
      if (!/\s/.test(c)) lastSig = c;
    }
    i = src.indexOf('{', i);
    let depth = 0;
    for (; i < src.length; i++) {
      const skip = next(i);
      if (skip !== null) { i = skip - 1; continue; }
      const c = src[i];
      if (c === '/' && isRegexStart(lastSig)) { i = skipRegex(i) - 1; lastSig = '/'; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
      if (!/\s/.test(c)) lastSig = c;
    }
    throw new Error('unbalanced: ' + decl);
  }

  let i = idx, lastSig = '', depth = 0;
  for (; i < src.length; i++) {
    const skip = next(i);
    if (skip !== null) { i = skip - 1; continue; }
    const c = src[i];
    if (c === '/' && isRegexStart(lastSig)) { i = skipRegex(i) - 1; lastSig = '/'; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0) return src.slice(idx, i + 1);
    if (!/\s/.test(c)) lastSig = c;
  }
  throw new Error('no statement end: ' + decl);
}

const names = [
  'function scheduleReview', 'function isDueForReview',
  'function getDueLessons', 'function getPracticeLessons',
  'const PLAN_LIMITS', 'function totalXp', 'const PRICE_IN', 'const PRICE_OUT', 'function totalCost',
  'function extractJSON', 'function firstPlannedConcept', 'function parseLearnerNumber',
  'const REPORT_QUEUE', 'function queueReport', 'function sendReports', 'function flushReports',
  'function reportMisjudged',
  'function courseProgressPct', 'const UNIT_SIZE', 'function unitNumber',
  'function maxCourses', 'function planReadChars', 'function contextBudget', 'function excerptBudget',
];

// The app around them, in as few lines as it takes. Everything that would
// touch a screen or a network records what it was asked for instead.
let code = `
let currentUser = { id: 'u1' };
let courseData = null;
let progress = {};
let activeCourseId = 'course-1';
let activeStructure = null;
let entitlement = null;
let library = [];
let xpByCourse = {};
let usage = { inputTokens: 0, outputTokens: 0 };
const MAX_COURSES = 8;

const store = new Map();
const localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

let reportInserts = [];
const supabaseClient = {
  from: (table) => ({
    insert: async (rows) => {
      reportInserts.push(...rows);
      return { error: null };
    },
  }),
};
`;
for (const n of names) code += '\n' + grab(n) + '\n';
code += `
module.exports = {
  scheduleReview, isDueForReview, getDueLessons, getPracticeLessons,
  totalXp, totalCost, extractJSON, firstPlannedConcept, parseLearnerNumber,
  queueReport, sendReports, flushReports, reportMisjudged,
  courseProgressPct, unitNumber, maxCourses, planReadChars, contextBudget, excerptBudget,
  reset: (state = {}) => {
    courseData = 'courseData' in state ? state.courseData : null;
    progress = state.progress ?? {};
    activeCourseId = state.activeCourseId ?? 'course-1';
    activeStructure = 'activeStructure' in state ? state.activeStructure : null;
    currentUser = 'currentUser' in state ? state.currentUser : { id: 'u1' };
    entitlement = 'entitlement' in state ? state.entitlement : null;
    library = state.library ?? [];
    xpByCourse = state.xpByCourse ?? {};
    usage = state.usage ?? { inputTokens: 0, outputTokens: 0 };
    store.clear();
    for (const [k, v] of Object.entries(state.storage ?? {})) store.set(k, v);
    reportInserts = [];
  },
  progressRow: i => progress[i],
  storageGet: k => (store.has(k) ? store.get(k) : null),
  storageHas: k => store.has(k),
  reportRows: () => reportInserts,
};
`;

const m = new module.constructor();
m._compile(code, '/learning-state.js');
const P = m.exports;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
};

const DAY = 86400000;
const near = (a, b, tol = 5000) => Math.abs(a - b) < tol;

(async () => {

// ------------------------------------------------------------ SM-2 scheduling
console.log('\n== the review schedule (SM-2) ==');
{
  P.reset({ progress: {} });
  P.scheduleReview(0, 100);   // accuracy 100 -> quality 5
  let srs = P.progressRow(0).srs;
  ok('a first correct review sets reps to 1', srs.reps === 1);
  ok('and the interval to one day', srs.interval === 1);
  ok('due tomorrow', near(srs.dueAt, Date.now() + DAY));
  ok('ease grows from the 2.5 default', srs.ease > 2.5);
  ok('lastReviewed is stamped', near(srs.lastReviewed, Date.now()));

  P.scheduleReview(0, 100);   // second correct review
  srs = P.progressRow(0).srs;
  ok('a second correct review is a fixed six-day interval', srs.interval === 6);

  P.scheduleReview(0, 100);   // third correct review: interval = round(prior interval * ease)
  srs = P.progressRow(0).srs;
  ok('a third review grows the interval by the ease factor, not another fixed step',
     srs.interval === 16, 'interval=' + srs.interval + ' ease=' + srs.ease);
  ok('and ease keeps climbing', near(srs.ease, 2.8, 0.01), 'ease=' + srs.ease);

  // Quality bands: accuracy -> quality -> whether reps resets.
  const qualityOf = pct => {
    P.reset({ progress: { 0: { srs: { ease: 2.5, interval: 10, reps: 4, dueAt: 0 } } } });
    P.scheduleReview(0, pct);
    return P.progressRow(0).srs;
  };
  ok('90%+ keeps building on the existing schedule (quality 5)', qualityOf(95).reps === 5);
  ok('75-89% still counts as a pass (quality 4)', qualityOf(80).reps === 5);
  ok('60-74% still counts as a pass (quality 3)', qualityOf(65).reps === 5);
  ok('40-59% resets the schedule (quality 2, below the pass line)',
     qualityOf(50).reps === 0 && qualityOf(50).interval === 1);
  ok('below 40% also resets it (quality 1)',
     qualityOf(20).reps === 0 && qualityOf(20).interval === 1);

  // A missed review must never leave the concept harder than it already was.
  P.reset({ progress: { 0: { srs: { ease: 2.5, interval: 10, reps: 4, dueAt: 0 } } } });
  P.scheduleReview(0, 30);
  ok('ease is left untouched on a failed review', P.progressRow(0).srs.ease === 2.5);

  // The ease factor never drops below SM-2's floor, even after repeated
  // middling (quality 3) reviews that each nudge it down.
  P.reset({ progress: { 0: { srs: { ease: 1.35, interval: 5, reps: 3, dueAt: 0 } } } });
  P.scheduleReview(0, 65);   // quality 3 lowers ease by 0.14 -> would be 1.21
  ok('ease is clamped at 1.3, never lower', P.progressRow(0).srs.ease === 1.3);

  // A concept reviewed for the first time has no `progress[index]` entry yet.
  P.reset({ progress: {} });
  ok('scheduling a concept with no progress row does not throw',
     (P.scheduleReview(2, 100), P.progressRow(2) !== undefined));
  ok('and starts from the documented defaults (ease 2.5 seed)',
     P.progressRow(2).srs.ease > 2.5 && P.progressRow(2).srs.ease < 2.7);
}

console.log('\n== which lessons are due ==');
{
  P.reset({ progress: {
    0: { completed: true, lesson: {}, srs: { dueAt: Date.now() - DAY } },
    1: { completed: true, lesson: {}, srs: { dueAt: Date.now() + DAY } },
    2: { completed: false, lesson: {}, srs: { dueAt: Date.now() - DAY } },
  } });
  ok('overdue and completed is due', P.isDueForReview(0));
  ok('overdue but not yet due (future dueAt) is not', !P.isDueForReview(1));
  ok('overdue but never completed is not', !P.isDueForReview(2));
  ok('no courseData means no due lessons at all',
     (P.reset({ courseData: null, progress: { 0: { completed: true, lesson: {}, srs: { dueAt: 0 } } } }),
      P.getDueLessons().length === 0));

  P.reset({
    courseData: { concepts: [{}, {}, {}, {}] },
    progress: {
      0: { completed: true, lesson: {}, srs: { dueAt: Date.now() - DAY } },
      1: { completed: true, lesson: {}, srs: { dueAt: Date.now() + DAY } },
      2: { completed: true, lesson: {}, srs: { dueAt: Date.now() - DAY } },
      3: { completed: false, lesson: {} },
    },
  });
  ok('getDueLessons lists exactly the overdue completed ones',
     JSON.stringify(P.getDueLessons()) === '[0,2]');
  ok('getPracticeLessons lists every completed lesson regardless of schedule',
     JSON.stringify(P.getPracticeLessons()) === '[0,1,2]');

  // Completed and overdue is not enough on its own — the lesson itself has
  // to have actually been generated, or there is nothing to review.
  P.reset({
    courseData: { concepts: [{}] },
    progress: { 0: { completed: true, srs: { dueAt: Date.now() - DAY } } },
  });
  ok('due but with no lesson generated is left out of the due list',
     P.getDueLessons().length === 0);
}

// -------------------------------------------------------------------- totals
console.log('\n== xp and cost ==');
{
  P.reset({
    activeCourseId: 'open',
    xpByCourse: { open: 999, other: 40, third: 10 },
    progress: { 0: { xp: 5 }, 1: { xp: 7 }, 2: {} },
  });
  ok('the open course counts live progress, not its own stale xpByCourse entry',
     P.totalXp() === 40 + 10 + 5 + 7);

  P.reset({ usage: { inputTokens: 2_000_000, outputTokens: 100_000 } });
  // $1/M input, $5/M output: 2M in + 100k out = $2.00 + $0.50.
  ok('cost combines input and output tokens at their own per-token rates',
     Math.abs(P.totalCost() - 2.5) < 1e-9, String(P.totalCost()));
}

// ---------------------------------------------------------------- extractJSON
console.log('\n== pulling JSON out of a model response ==');
{
  ok('a clean object parses as-is', P.extractJSON('{"a":1}').a === 1);
  ok('a fenced code block is stripped',
     P.extractJSON('```json\n{"a":1}\n```').a === 1);
  ok('trailing prose after the object is ignored',
     P.extractJSON('{"a":1}\n\nHope that helps!').a === 1);
  ok('leading prose before the object is skipped',
     P.extractJSON('Sure, here is the JSON:\n{"a":1}').a === 1);
  ok('nothing that looks like an object at all is null', P.extractJSON('no json here') === null);
  ok('empty input is null', P.extractJSON('') === null && P.extractJSON(null) === null);

  // The case the function exists for: the stream cut off mid-value.
  const full = '{"title":"x","concepts":[{"name":"A","ok":true},{"name":"B","ok":false}]}';
  for (let cut = 10; cut < full.length; cut += 3) {
    const partial = full.slice(0, cut);
    const got = P.extractJSON(partial);
    // cut mid-string/mid-token (null), or before "concepts" has arrived at
    // all: both are honest answers, not what this loop is checking.
    if (got === null || !got.concepts) continue;
    // Whatever it recovered must be a real prefix of the finished array —
    // never a fabricated or corrupted concept.
    const okPrefix = got.concepts.every((c, i) => {
      const real = JSON.parse(full).concepts[i];
      return real && c.name === real.name;
    });
    if (!okPrefix) {
      ok('every recovered concept matches the finished document', false,
         'cut at ' + cut + ': ' + JSON.stringify(got));
      break;
    }
    if (cut + 3 >= full.length) ok('every recovered concept matches the finished document', true);
  }
  ok('a value cut inside a string recovers nothing rather than a truncated string',
     P.extractJSON('{"title":"Some Ti') === null);
  // "3" has no delimiter after it yet — it could still be "35" mid-stream, so
  // only the elements already confirmed complete by a following comma count.
  ok('an array cut mid-element recovers only the elements confirmed complete',
     JSON.stringify(P.extractJSON('{"xs":[1,2,3').xs) === '[1,2]');
}

console.log('\n== the first concept, while the plan is still streaming ==');
{
  ok('no "concepts" key yet is null, not a guess', P.firstPlannedConcept('{"title":"x"') === null);
  const partial = '{"language":"English","concepts":[{"name":"A","description":"d","importance"';
  ok('an incomplete first concept is null, not a half-built one',
     P.firstPlannedConcept(partial) === null);
  const complete = '{"language":"English","concepts":[{"name":"A","description":"d","importance":"i"},{"name":"B"';
  const first = P.firstPlannedConcept(complete);
  ok('a fully-arrived first concept is returned as soon as it closes',
     first && first.concept.name === 'A' && first.language === 'English');
}

// ----------------------------------------------------------- parseLearnerNumber
console.log('\n== reading a typed numeric answer ==');
{
  ok('a plain integer', P.parseLearnerNumber('42') === 42);
  ok('a plain decimal', P.parseLearnerNumber('3.5') === 3.5);
  ok('a comma as the decimal separator', P.parseLearnerNumber('3,5') === 3.5);
  ok('a comma thousands separator', P.parseLearnerNumber('1,200') === 1200);
  ok('a fraction is divided, not read as its numerator',
     P.parseLearnerNumber('1/2') === 0.5);
  ok('a negative fraction', P.parseLearnerNumber('-3/4') === -0.75);
  ok('a unicode minus sign (RTL keyboards) reads as negative',
     P.parseLearnerNumber('−5') === -5);
  ok('an en dash also reads as negative', P.parseLearnerNumber('–10') === -10);
  ok('surrounding whitespace and quotes are ignored', P.parseLearnerNumber(" '7' ") === 7);
  ok('a fraction by zero does not throw or return Infinity',
     P.parseLearnerNumber('5/0') === null);
  ok('nothing numeric at all is null', P.parseLearnerNumber('banana') === null);
  ok('empty/undefined input is null', P.parseLearnerNumber('') === null && P.parseLearnerNumber(undefined) === null);
}

// -------------------------------------------------------------- report queue
console.log('\n== material-report queue ==');
{
  P.reset({ currentUser: null, storage: {} });
  for (let i = 0; i < 8; i++) P.queueReport({ code: 'x' + i });
  const queued = JSON.parse(P.storageGet('material-reports-pending'));
  ok('the queue keeps only the most recent five', queued.length === 5);
  ok('and they are the last five pushed, in order',
     queued.map(r => r.code).join(',') === 'x3,x4,x5,x6,x7');

  P.reset({ currentUser: { id: 'u1' }, storage: {} });
  await P.flushReports();
  ok('flushing an empty queue sends nothing', P.reportRows().length === 0);

  P.reset({ currentUser: { id: 'u1' },
            storage: { 'material-reports-pending': JSON.stringify([{ code: 'a' }, { code: 'b' }]) } });
  await P.flushReports();
  ok('a non-empty queue is sent', P.reportRows().length === 2);
  ok('every row is stamped with the signed-in user', P.reportRows().every(r => r.user_id === 'u1'));
  ok('and the local queue is cleared once handed off', P.storageGet('material-reports-pending') === null);

  P.reset({ currentUser: null, storage: {} });
  const verdict = { code: 'too_short', stats: {
    chars: 100, realWords: 20, letterShare: 0.501, digitShare: 0.101,
    sentences: 3, wordsPerSentence: 6.666, vocabulary: 0.7501,
  } };
  await P.reportMisjudged(verdict);
  ok('signed out, a misjudged-material report is queued locally instead of lost',
     JSON.parse(P.storageGet('material-reports-pending') || '[]').length === 1);
  ok('and not sent anywhere while signed out', P.reportRows().length === 0);

  P.reset({ currentUser: { id: 'u1' }, activeStructure: { some: 'bundle' } });
  await P.reportMisjudged(verdict);
  const row = P.reportRows()[0];
  ok('signed in, it is sent immediately', row.code === 'too_short');
  ok('percentages are rounded to sane precision', row.stats.letterShare === 0.5 && row.stats.digitShare === 0.1);
  ok('the source reflects the active bundle vs. a plain upload', row.source === 'bundle');

  P.reset({ currentUser: { id: 'u1' }, activeStructure: null });
  await P.reportMisjudged(verdict);
  ok('no active bundle means the source is recorded as an upload', P.reportRows()[0].source === 'upload');
}

// -------------------------------------------------------------- plan budgets
console.log('\n== small pure numbers ==');
{
  P.reset({ library: [{ id: 'c1', conceptCount: 8, completedCount: 3 }] });
  ok('course progress rounds to a whole percent', P.courseProgressPct('c1') === 38);
  ok('a course with no concepts yet is 0%, not NaN or a throw',
     (P.reset({ library: [{ id: 'c2', conceptCount: 0, completedCount: 0 }] }), P.courseProgressPct('c2') === 0));
  ok('an unknown course id is 0%', P.courseProgressPct('missing') === 0);

  ok('unit numbers group concepts in fixed-size bands',
     P.unitNumber(0) === 1 && P.unitNumber(4) === 1 && P.unitNumber(5) === 2);

  P.reset({ entitlement: null });
  ok('signed-out / unknown plan falls back to the smallest budget',
     P.maxCourses() === 8 && P.planReadChars() === 5000 &&
     P.contextBudget() === 0 && P.excerptBudget() === 2400);

  P.reset({ entitlement: { planKey: 'pro' } });
  ok('a known plan reads its own budget, not the fallback',
     P.maxCourses() === 5 && P.planReadChars() === 40000 && P.contextBudget() === 24000);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

})().catch(e => { console.error(e); process.exit(1); });
