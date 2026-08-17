/*
 * The lesson flow — the parts of app.js that decide *when* work happens rather
 * than what it looks like:
 *
 *   - the SSE scanner, which turns a stream of bytes into the model's words;
 *   - the progress readers, which say what is being written from a half-written
 *     lesson;
 *   - the prefetch guards, which decide whether to spend one of the month's
 *     lessons on a bet that the learner will open the next one;
 *   - the warm-up question, and the second look at a question that went wrong.
 *
 *     node tests/lesson-flow.js
 *
 * Same trick as the other two: app.js is a plain browser script with no module
 * system, so the functions under test are lifted out by name and compiled on
 * their own, and the tests run the shipping code rather than a copy.
 *
 * The prefetch guards are the reason this file exists. Every one of them
 * protects against spending money on a lesson nobody asked for, and every one
 * of them fails silently — a prefetch that fires when it should not costs a
 * lesson from the monthly quota and says nothing at all.
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'app.js'), 'utf8');

// Grab a top-level `function name(...) {...}` or `const NAME = ...;` by matching braces.
function grab(decl) {
  const idx = src.indexOf(decl);
  if (idx < 0) throw new Error('not found: ' + decl);

  if (decl.startsWith('function')) {
    // Walk past the parameter list first: a default value — `function f(a = {})`
    // — otherwise looks like the body and gets matched shut one character in.
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
  'function sseScanner',
  'const LESSON_PARTS', 'function lessonProgress', 'function pathProgress',
  'const PLAN_LIMITS', 'function planLessonCount',
  'const prefetching =', 'function monthlyLessonsLeft', 'function prefetchLesson',
  'function shuffle', 'function reshuffleOptions',
  'function pickWarmUp', 'function nudgeReviewSooner',
];

// The app around the functions, in as few lines as it takes. `showProgress`
// writes to the loading overlay in the browser; here it records what it was
// told, which is the thing being asserted on.
let code = `
let courseData = null;
let progress = {};
let activeCourseId = 'course-1';
let currentUser = { id: 'u1' };
let entitlement = { planKey: 'max' };
let usage = { loaded: true, lessonsMonth: 0 };
let saved = 0;
let generated = [];
let lastProgress = null;

function saveProgress() { saved++; }
function showProgress(detail, fraction = null) { lastProgress = { detail, fraction }; }
// Stands in for the real generator: records what it was asked for and hands
// back a lesson, so the guards above it are what is under test.
function generateLesson(concept, opts) {
  generated.push({ concept, opts });
  return Promise.resolve({ title: concept.name });
}
const navigator = { onLine: true };
`;
for (const n of names) code += '\n' + grab(n) + '\n';
code += `
module.exports = {
  sseScanner, lessonProgress, pathProgress, LESSON_PARTS,
  monthlyLessonsLeft, prefetchLesson, prefetching,
  reshuffleOptions, pickWarmUp, nudgeReviewSooner,
  read: () => lastProgress,
  generated: () => generated,
  saves: () => saved,
  reset: (state = {}) => {
    courseData = state.courseData ?? { concepts: [] };
    progress = state.progress ?? {};
    entitlement = 'entitlement' in state ? state.entitlement : { planKey: 'max' };
    usage = state.usage ?? { loaded: true, lessonsMonth: 0 };
    currentUser = 'currentUser' in state ? state.currentUser : { id: 'u1' };
    activeCourseId = state.activeCourseId ?? 'course-1';
    navigator.onLine = state.online ?? true;
    generated = []; saved = 0; lastProgress = null;
    prefetching.clear();
  },
  setCourseId: id => { activeCourseId = id; },
  progressRow: i => progress[i],
};
`;

const m = new module.constructor();
m._compile(code, '/lesson-flow.js');
const P = m.exports;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
};

const concepts = n => Array.from({ length: n }, (_, i) => ({ name: 'C' + i }));
const DAY = 86400000;

// ------------------------------------------------------------- the SSE stream
console.log('\n== reading the stream ==');
{
  const frame = obj => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
  const delta = text => frame({ type: 'content_block_delta', delta: { type: 'text_delta', text } });

  const scan = P.sseScanner();
  ok('a whole frame is one event', scan(delta('hello')).length === 1);

  // The case that matters: the network splits wherever it likes, and half a
  // frame parsed as a whole one is a lesson with a hole in it.
  const split = P.sseScanner();
  const whole = delta('world');
  const cut = Math.floor(whole.length / 2);
  ok('half a frame yields nothing yet', split(whole.slice(0, cut)).length === 0);
  const rest = split(whole.slice(cut));
  ok('and the other half completes it', rest.length === 1);
  ok('with the text intact', rest[0].delta.text === 'world');

  const many = P.sseScanner();
  ok('three frames in one chunk are three events',
     many(delta('a') + delta('b') + delta('c')).length === 3);
  ok('a comment keep-alive is not an event', P.sseScanner()(': keep-alive\n\n').length === 0);
  ok('a frame that is not JSON is skipped rather than thrown',
     P.sseScanner()('data: <html>502</html>\n\n').length === 0);
}

// ---------------------------------------------------------------- the progress
console.log('\n== what is being written right now ==');
{
  // Every answer here is a key that genuinely arrived. It is allowed to lag
  // the truth by a chunk; it is not allowed to invent one.
  P.reset();
  P.lessonProgress('');
  ok('before anything arrives, the honest answer is "reading"',
     P.read().detail === 'Reading your material');

  P.lessonProgress('{"title":"Area","hook":{"text":"Su');
  ok('the opening is reported as the opening', P.read().detail === 'Writing the opening');

  P.lessonProgress('{"title":"x","hook":{},"prediction":{},"cards":[{"idea"');
  ok('and the explanation once the cards start', P.read().detail === 'Writing the explanation');

  const early = (P.lessonProgress('{"hook":{}'), P.read().fraction);
  const late = (P.lessonProgress('{"hook":{},"prediction":{},"explore":{},"cards":[],'
    + '"workedExample":{},"practice":{},"quiz":['), P.read().fraction);
  ok('and the bar only ever moves forward', late > early);
  ok('it never reaches the end while bytes are still coming', late < 1);

  // The last key wins, not the first: a lesson mentioning "cards" inside a
  // later string must not drag the label backwards.
  P.lessonProgress('{"hook":{},"cards":[],"quiz":[{"text":"which of these cards"}]');
  ok('a later key beats an earlier one whatever the prose says',
     P.read().detail === 'Writing the questions');
}

console.log('\n== the course plan, as it arrives ==');
{
  P.reset({ entitlement: { planKey: 'max' } });
  P.pathProgress('{"courseName":"x","concepts":[');
  ok('nothing found yet is not a count of zero',
     P.read().detail === 'Reading the whole document');

  P.pathProgress('{"concepts":[{"id":1,"name":"A"},{"id":2,"name":"B"}');
  ok('two concepts are two concepts', P.read().detail === 'Found 2 concepts');
  ok('measured against what this tier will return',
     Math.abs(P.read().fraction - 2 / 15) < 1e-9, String(P.read().fraction));

  P.pathProgress('{"concepts":[{"name":"A"}');
  ok('and one is singular', P.read().detail === 'Found 1 concept');

  P.reset({ entitlement: null });
  P.pathProgress('{"concepts":[{"name":"A"}');
  ok('a signed-out reader falls back to the smallest course',
     Math.abs(P.read().fraction - 1 / 10) < 1e-9);
}

// ----------------------------------------------------------------- prefetching
console.log('\n== spending a lesson before it is asked for ==');
{
  P.reset({ courseData: { concepts: concepts(5) } });
  P.prefetchLesson(1);
  ok('the next lesson is written ahead of time', P.generated().length === 1);
  ok('quietly, because nobody is looking at it yet', P.generated()[0].opts.quiet === true);

  P.prefetchLesson(1);
  ok('and only once, however many times the step re-renders', P.generated().length === 1);

  P.reset({ courseData: { concepts: concepts(5) }, progress: { 2: { lesson: { title: 'have it' } } } });
  P.prefetchLesson(2);
  ok('a lesson already in hand is not written again', P.generated().length === 0);

  P.reset({ courseData: { concepts: concepts(3) } });
  P.prefetchLesson(3);
  ok('there is nothing after the last concept', P.generated().length === 0);

  P.reset({ courseData: { concepts: concepts(5) }, online: false });
  P.prefetchLesson(1);
  ok('an offline browser does not start one', P.generated().length === 0);

  P.reset({ courseData: { concepts: concepts(5) }, currentUser: null });
  P.prefetchLesson(1);
  ok('and neither does a signed-out one', P.generated().length === 0);

  // The one that costs real money. Max is 8 courses x 15 lessons = 120 a
  // month; at 119 spent, the last one belongs to whatever the learner chooses
  // to open, not to a guess about what that will be.
  P.reset({ courseData: { concepts: concepts(5) }, usage: { loaded: true, lessonsMonth: 119 } });
  ok('the last lesson of the month is left for the learner to spend',
     (P.prefetchLesson(1), P.generated().length === 0));

  P.reset({ courseData: { concepts: concepts(5) }, usage: { loaded: true, lessonsMonth: 100 } });
  ok('with room to spare it goes ahead', (P.prefetchLesson(1), P.generated().length === 1));

  // Usage that has not loaded yet is unknown, and unknown is not "none" — the
  // server is the one that enforces the quota, and it will refuse if it must.
  P.reset({ courseData: { concepts: concepts(5) }, usage: { loaded: false, lessonsMonth: 0 } });
  ok('an unknown quota is not read as an exhausted one',
     P.monthlyLessonsLeft() === Infinity && (P.prefetchLesson(1), P.generated().length === 1));
}

console.log('\n== a course switched away from mid-flight ==');
{
  (async () => {
    P.reset({ courseData: { concepts: concepts(5) } });
    P.prefetchLesson(1);
    // The learner opens a different course before the lesson lands. Storing it
    // now would file this course's lesson 1 as that one's lesson 1.
    P.setCourseId('course-2');
    await Promise.resolve(); await Promise.resolve();
    ok('a lesson that lands after the switch is discarded',
       P.progressRow(1) === undefined);
    ok('and nothing was saved for it', P.saves() === 0);

    // ------------------------------------------------------- the warm-up
    console.log('\n== one question from an earlier lesson ==');
    {
      const quiz = i => ({ quiz: [{ text: 'q' + i, options: ['a', 'b'], correct: 0 }] });

      P.reset({ courseData: { concepts: concepts(4) }, progress: {} });
      ok('a first lesson has nothing to warm up on', P.pickWarmUp(0) === null);

      P.reset({
        courseData: { concepts: concepts(4) },
        progress: { 0: { completed: true, lesson: quiz(0) } },
      });
      const warm = P.pickWarmUp(1);
      ok('a finished lesson supplies one', warm && warm.lessonIndex === 0);
      ok('and the question comes from its own quiz', warm.question.text === 'q0');

      P.reset({
        courseData: { concepts: concepts(4) },
        progress: {
          0: { completed: true, lesson: quiz(0), srs: { dueAt: Date.now() - 9 * DAY } },
          1: { completed: true, lesson: quiz(1), srs: { dueAt: Date.now() + 5 * DAY } },
          2: { completed: true, lesson: quiz(2), srs: { dueAt: Date.now() - 2 * DAY } },
        },
      });
      ok('the most overdue lesson is the one that comes back',
         P.pickWarmUp(3).lessonIndex === 0);

      P.reset({
        courseData: { concepts: concepts(4) },
        progress: {
          0: { completed: true, lesson: quiz(0) },
          1: { completed: false, lesson: quiz(1) },
          2: { completed: true, lesson: { quiz: [] } },
        },
      });
      const only = P.pickWarmUp(3);
      ok('an unfinished lesson is not asked about, nor an empty one',
         only.lessonIndex === 0);

      // A lesson never reviewed still counts: treating "no schedule yet" as
      // "not due" would mean a course with no reviews behind it never warms up.
      P.reset({
        courseData: { concepts: concepts(3) },
        progress: {
          0: { completed: true, lesson: quiz(0) },
          1: { completed: true, lesson: quiz(1), srs: { dueAt: Date.now() + 30 * DAY } },
        },
      });
      ok('a lesson with no schedule yet is treated as due now',
         P.pickWarmUp(2).lessonIndex === 0);
    }

    console.log('\n== a missed warm-up moves the schedule, gently ==');
    {
      P.reset({ progress: { 0: { srs: { ease: 2.5, interval: 30, reps: 4, dueAt: Date.now() + 30 * DAY } } } });
      P.nudgeReviewSooner(0);
      const srs = P.progressRow(0).srs;
      ok('a lesson due next month comes back tomorrow',
         Math.abs(srs.dueAt - (Date.now() + DAY)) < 5000);
      ok('but the ease it earned is left alone', srs.ease === 2.5 && srs.reps === 4);

      // Already due sooner than tomorrow: dragging it *later* would be the one
      // thing a missed question must never do.
      const soon = Date.now() + 3600_000;
      P.reset({ progress: { 0: { srs: { ease: 2.5, interval: 1, reps: 1, dueAt: soon } } } });
      P.nudgeReviewSooner(0);
      ok('one already due sooner is not pushed back', P.progressRow(0).srs.dueAt === soon);

      P.reset({ progress: { 0: {} } });
      ok('a lesson with no schedule at all does not throw',
         (P.nudgeReviewSooner(0), true));
    }

    console.log('\n== the second look at a question that went wrong ==');
    {
      const q = { type: 'choice', text: 'q', options: ['a', 'b', 'c', 'd'], correct: 2 };
      for (let i = 0; i < 40; i++) {
        const moved = P.reshuffleOptions(q);
        if (moved.options[moved.correct] !== 'c') {
          ok('the right answer follows its option when they move', false,
             JSON.stringify(moved));
          break;
        }
        if (i === 39) ok('the right answer follows its option when they move', true);
      }
      ok('the original is left untouched', q.correct === 2 && q.options[2] === 'c');

      // Not every question has options to move. A typed number, an ordering,
      // a tap on a diagram: reshuffling those means nothing, and inventing a
      // `correct` index for them would break the grading.
      const numeric = { type: 'numeric', text: 'how many', answer: 42, tolerance: 0.5 };
      ok('a question with no options is handed back as it was',
         P.reshuffleOptions(numeric) === numeric);
      ok('and so is a true/false', P.reshuffleOptions({ type: 'boolean', answer: true }).answer === true);
      ok('a single option is not shuffled',
         P.reshuffleOptions({ options: ['only'], correct: 0 }).options.length === 1);
    }

    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
  })();
}
