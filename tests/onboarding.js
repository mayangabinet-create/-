/*
 * The first run — the intro a new account sees once, and never again.
 *
 *     node tests/onboarding.js
 *
 * Same trick as the other suites: app.js is a plain browser script with no
 * module system, so the pieces under test are lifted out by name and compiled
 * on their own against a few stubs, and what runs here is the shipping code
 * rather than a copy of it.
 *
 * Three things are worth a test and the rest is markup.
 *
 * The **starter material** is the first thing a brand-new account is offered,
 * and it goes through the same suitability gate as an upload. A starter the
 * gate refuses would greet a new user with "this doesn't read like study
 * material" about a document the app itself wrote, so every starter is run
 * through `assessMaterial` here — the real one, lifted out of app.js.
 *
 * The **once** part. An intro that reappears is worse than one nobody saw, and
 * every path that decides whether to show it (a cached flag, the account row, a
 * library that already has courses in it, a read that failed) is a path where
 * getting it wrong is invisible in development, where the flag is always set.
 *
 * The **step machine**: which step is next, when Continue is allowed to be
 * pressed, and that skipping still records the answers already given.
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'app.js'), 'utf8');

// Grab a top-level `function name(...) {...}` or `const NAME = ...;` by matching braces.
function grab(decl) {
  const idx = src.indexOf(decl);
  if (idx < 0) throw new Error('not found: ' + decl);
  // `async function f()` is asked for as `function f` like any other, and the
  // keyword in front of it has to come along or the body stops compiling.
  const start = src.slice(idx - 6, idx) === 'async ' ? idx - 6 : idx;

  if (decl.startsWith('function')) {
    let i = src.indexOf('(', idx), parens = 0;
    for (; i < src.length; i++) {
      if (src[i] === '(') parens++;
      else if (src[i] === ')' && --parens === 0) { i++; break; }
    }
    i = src.indexOf('{', i);
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
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
  'const MATERIAL_MIN_CHARS', 'const MATERIAL_MIN_WORDS',
  'function materialStats', 'function assessMaterial',
  'const ONBOARDING_STORAGE', 'const onboardingKey =',
  'const ONBOARDING_VALUES', 'const ONBOARDING_GOALS', 'const INTERESTS',
  'const STARTER_COURSES', 'function starterPicks', 'function interestSummary',
  'function cleanTitle',
  'let onboarding =', 'let onboardingRun =', 'const ONBOARDING_STEPS',
  'function readLocalOnboarding', 'function writeLocalOnboarding',
  'function loadOnboarding', 'function saveOnboarding', 'function maybeShowOnboarding',
  'function onboardingStepId', 'function onboardingCanContinue', 'function onboardingNextLabel',
  'function onboardingNext(', 'function onboardingBack', 'function finishOnboarding',
];

// The app around them, in as few lines as it takes. Everything that would touch
// a screen, a network or a browser records what it was asked for instead.
let code = `
let currentUser = { id: 'u1' };
let library = [];
let screenShown = null;
let starts = [];
let renders = 0;
let closes = 0;
let built = [];
let toasts = [];
let accountRenders = 0;
let upserts = [];
let errors = [];
let remoteRow = null;      // what user_stats holds for this account
let selectError = null;    // e.g. the column not deployed yet
let upsertError = null;

const store = new Map();
const localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

const supabaseClient = {
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () =>
      selectError ? { data: null, error: selectError } : { data: remoteRow, error: null } }) }),
    upsert: async (row) => {
      upserts.push(row);
      if (upsertError) return { error: upsertError };
      remoteRow = { onboarding: row.onboarding };
      return { error: null };
    },
  }),
};

// The step machine moves focus to the top of each new step; here that is one
// element with one method on it.
let focused = 0;
const document = { getElementById: () => ({ focus: () => { focused++; } }) };

// The topic path writes its own material before it builds anything.
let primerFor = null;
let primerText = 'A long enough piece of prose about the subject. It has sentences.';
function generateInterestPrimer(topic) { primerFor = topic; return Promise.resolve(primerText); }
function showStages() {}
function showMessage() {}
function hideMessage() {}
function showError(msg) { errors.push(msg); }
const BUILD_STAGES = [];

function setScreen(name) { screenShown = name; }
function startOnboarding(opts) { starts.push(opts || {}); }
function renderOnboarding() { renders++; }
function closeOnboarding() { closes++; onboardingRun = null; }
function processLearningMaterial(text, title, chosen) { built.push({ text, title, chosen }); return Promise.resolve(); }
function renderAccount() { accountRenders++; }
function toast(message, kind) { toasts.push({ message, kind }); }
const console = { error: () => {}, log: () => {} };
`;
for (const n of names) code += '\n' + grab(n) + '\n';
code += `
module.exports = {
  assessMaterial, materialStats,
  INTERESTS, ONBOARDING_GOALS, ONBOARDING_VALUES, STARTER_COURSES, ONBOARDING_STEPS,
  starterPicks, interestSummary,
  primerFor: () => primerFor,
  errors: () => errors,
  setPrimer: t => { primerText = t; },
  readLocalOnboarding, writeLocalOnboarding, loadOnboarding, saveOnboarding, maybeShowOnboarding,
  onboardingStepId, onboardingCanContinue, onboardingNextLabel, onboardingNext, onboardingBack,
  finishOnboarding,
  state: () => onboarding,
  run: () => onboardingRun,
  setRun: r => { onboardingRun = r; },
  setState: s => { onboarding = s; },
  starts: () => starts,
  built: () => built,
  toasts: () => toasts,
  upserts: () => upserts,
  screen: () => screenShown,
  accountRenders: () => accountRenders,
  cache: () => [...store.entries()],
  focused: () => focused,
  reset: (o = {}) => {
    store.clear();
    onboarding = { done: false };
    onboardingRun = null;
    currentUser = 'currentUser' in o ? o.currentUser : { id: 'u1' };
    library = o.library ?? [];
    remoteRow = o.remoteRow ?? null;
    selectError = o.selectError ?? null;
    upsertError = o.upsertError ?? null;
    starts = []; built = []; toasts = []; upserts = []; errors = [];
    primerFor = null; primerText = 'A long enough piece of prose about the subject. It has sentences.';
    renders = 0; closes = 0; accountRenders = 0; screenShown = null; focused = 0;
  },
};
`;

const m = new module.constructor();
m._compile(code, '/onboarding.js');
const O = m.exports;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
};

// ------------------------------------------------------- the starter material
console.log('\n== the courses we hand a brand-new account ==');
{
  O.reset();

  for (const s of O.STARTER_COURSES) {
    const verdict = O.assessMaterial(s.text);
    ok(`"${s.title}" passes the same gate as an upload`, verdict === null,
       verdict ? `${verdict.code}: ${verdict.title}` : '');
  }

  // The gate's floor is 600 characters, which is the point below which there is
  // no course at all. A starter is the app's own demonstration of what it does
  // with a document, and ten concepts do not come out of a paragraph.
  const short = O.STARTER_COURSES.filter(s => s.text.length < 2000).map(s => s.id);
  ok('every starter is long enough to plan ten concepts from', short.length === 0, short.join(', '));

  const words = s => O.materialStats(s.text).realWords;
  ok('and is prose, not an outline',
     O.STARTER_COURSES.every(s => O.materialStats(s.text).wordsPerSentence >= 10),
     O.STARTER_COURSES.map(s => `${s.id}:${O.materialStats(s.text).wordsPerSentence.toFixed(1)}`).join(' '));
  ok('longest starter is still one document, not a book',
     Math.max(...O.STARTER_COURSES.map(words)) < 1200);

  const ids = O.STARTER_COURSES.map(s => s.id);
  ok('ids are unique', new Set(ids).size === ids.length);
  ok('every starter names an interest that exists',
     O.STARTER_COURSES.every(s => O.INTERESTS.some(i => i.id === s.interest)));

  // The last screen offers a course per interest picked. An interest with no
  // starter behind it is a tile that leads to somebody else's subject.
  const uncovered = O.INTERESTS
    .filter(i => i.id !== 'other')
    .filter(i => !O.STARTER_COURSES.some(s => s.interest === i.id))
    .map(i => i.id);
  ok('every interest except "something else" has a course behind it',
     uncovered.length === 0, uncovered.join(', '));
}

// ------------------------------------------------------------ what gets offered
console.log('\n== choosing what to offer ==');
{
  const picks = O.starterPicks(['money']);
  ok('the interest they picked comes first', picks[0].interest === 'money');
  ok('and the screen is still filled out', picks.length === 3);

  const two = O.starterPicks(['mind', 'math']);
  ok('two interests, both of theirs first',
     two.slice(0, 2).every(s => ['mind', 'math'].includes(s.interest)));
  ok('in the order the tiles are laid out, not the order they were tapped',
     two[0].interest === 'math');

  ok('nothing picked still offers something', O.starterPicks([]).length === 3);
  ok('"something else" has no starter of its own, so it falls back',
     O.starterPicks(['other']).length === 3);
  const ids = O.starterPicks(['math', 'money', 'mind', 'tech']).map(s => s.id);
  ok('never the same course twice', new Set(ids).size === ids.length);
  ok('and never more than the screen holds', ids.length === 3);
}

// -------------------------------------------------------------- the step machine
console.log('\n== the steps ==');
{
  O.reset();
  O.setRun({ step: 0, goal: null, interests: [], starter: null, replay: false });

  ok('it opens on what the app does', O.onboardingStepId() === 'welcome');
  ok('which needs no answer to leave', O.onboardingCanContinue() === true);

  O.onboardingNext();
  ok('then asks what they are here for', O.onboardingStepId() === 'goal');
  ok('and waits for an answer', O.onboardingCanContinue() === false);
  O.onboardingNext();
  ok('Continue does nothing until there is one', O.onboardingStepId() === 'goal');

  O.run().goal = 'exam';
  ok('answered, it may go on', O.onboardingCanContinue() === true);
  O.onboardingNext();
  ok('to the interests', O.onboardingStepId() === 'interests');
  ok('which also waits', O.onboardingCanContinue() === false);

  O.run().interests.push('math');
  ok('one is enough', O.onboardingCanContinue() === true);
  O.onboardingNext();
  ok('and then the course to start on', O.onboardingStepId() === 'starter');
  ok('waiting on which one', O.onboardingCanContinue() === false);
  ok('the button says what pressing it does', O.onboardingNextLabel() === 'Build this course');
  O.run().topic = 'Roman roads';
  ok('a typed subject answers the step as well as a card does', O.onboardingCanContinue() === true);
  O.run().topic = '   ';
  ok('but whitespace is not a subject', O.onboardingCanContinue() === false);

  O.onboardingBack();
  ok('back goes back', O.onboardingStepId() === 'interests');
  ok('and keeps the answer that was given', O.run().interests.includes('math'));
  O.onboardingBack(); O.onboardingBack(); O.onboardingBack();
  ok('back from the first step stays put', O.onboardingStepId() === 'welcome');
  // Every step change, and no other render, moves focus to the top of the new
  // step — otherwise a screen reader is left on a button whose screen changed
  // underneath it, and a long step opens halfway down.
  const moves = O.focused();
  O.run().interests.push('mind');
  ok('picking an answer does not move focus', O.focused() === moves);
}

// ------------------------------------------------------------------- shown once
(async () => {
  console.log('\n== shown once, and only once ==');
  {
    O.reset();
    ok('a brand-new account gets the intro', (await O.maybeShowOnboarding()) === true);
    ok('and the screen under it is the one it will uncover', O.screen() === 'home');

    O.reset({ remoteRow: { onboarding: { done: true, interests: ['math'] } } });
    ok('an account that has seen it does not see it again',
       (await O.maybeShowOnboarding()) === false);
    ok('and its answers come back with it', O.state().interests.includes('math'));
    ok('cached locally, so the next load does not wait on the row',
       O.cache().some(([k, v]) => k === 'onboarding:u1' && JSON.parse(v).done === true));

    // The row is the truth across devices, but the cache is what stops the
    // intro flashing up in front of it on a slow connection.
    O.reset();
    O.writeLocalOnboarding({ done: true, interests: ['money'] });
    ok('a cached flag is believed without a round trip',
       (await O.maybeShowOnboarding()) === false);
    ok('and nothing was written back', O.upserts().length === 0);

    // Someone who signed up before any of this existed. Touring them round an
    // app they have been using for a month is worse than saying nothing.
    O.reset({ library: [{ id: 'c1' }] });
    ok('an account with courses in it is not a new account',
       (await O.maybeShowOnboarding()) === false);
    ok('and is marked done rather than left to be asked next time',
       O.state().done === true && O.state().skipped === 'had-courses');

    // The column may not be deployed yet, or the network may be out. Neither is
    // a reason to replay the intro at someone who has already been through it.
    O.reset({ selectError: { message: 'column user_stats.onboarding does not exist' } });
    O.writeLocalOnboarding({ done: true });
    ok('a failed read leaves the cache in charge',
       (await O.maybeShowOnboarding()) === false);

    O.reset({ selectError: { message: 'network' } });
    ok('with no cache either, it shows — better twice than never',
       (await O.maybeShowOnboarding()) === true);

    // Signed out: nothing to read, nothing to show.
    O.reset({ currentUser: null });
    ok('signed out, there is no first run to have', (await O.maybeShowOnboarding()) === false);
  }

  console.log('\n== finishing, skipping, replaying ==');
  {
    O.reset();
    O.setRun({ step: 3, goal: 'exam', interests: ['math'], starter: 'pythagoras', replay: false });
    await O.finishOnboarding({ starterId: 'pythagoras' });
    ok('picking a course builds it', O.built().length === 1);
    ok('through the same path an upload takes',
       O.built()[0].text === O.STARTER_COURSES.find(s => s.id === 'pythagoras').text);
    ok('named after the course, not "Untitled"',
       O.built()[0].chosen === O.STARTER_COURSES.find(s => s.id === 'pythagoras').title);
    ok('and the intro is done', O.state().done === true);
    ok('with the answers kept', O.state().goal === 'exam' && O.state().interests[0] === 'math');
    ok('written to the account, not just this browser', O.upserts().length === 1);

    O.reset();
    O.setRun({ step: 2, goal: 'work', interests: ['money'], starter: null, replay: false });
    await O.finishOnboarding({ skipped: true });
    ok('skipping halfway still records what was answered',
       O.state().interests[0] === 'money' && O.state().goal === 'work');
    ok('and never comes back', O.state().done === true && O.state().skipped === true);
    ok('nothing is built behind their back', O.built().length === 0);
    ok('and they land on the upload screen', O.screen() === 'home');

    O.reset();
    O.setRun({ step: 3, goal: 'curious', interests: ['tech'], starter: null, replay: false });
    await O.finishOnboarding({ starterId: null });
    ok('"I\'ll upload my own" builds nothing', O.built().length === 0);
    ok('and says what to do next', O.toasts().length === 1);

    // A subject nobody has a document for: the app writes the material and
    // then builds from it exactly as it would from an upload.
    const settle = () => new Promise(r => setTimeout(r, 5));

    O.reset();
    O.setRun({ step: 3, goal: 'curious', interests: ['other'], starter: null, topic: '  Roman roads ', replay: false });
    O.onboardingNext();          // the button, not the handler — it trims on the way
    await settle();
    ok('a typed subject is written up first', O.primerFor() === 'Roman roads');
    ok('and the writing is what the course is built from',
       O.built().length === 1 && O.built()[0].text.startsWith('A long enough piece'));
    ok('named after the subject they typed', O.built()[0].chosen === 'Roman roads');
    ok('the intro is done either way', O.state().done === true);

    // A typed subject wins over a card left selected from before, and a card is
    // only used when nothing was typed.
    O.reset();
    O.setRun({ step: 3, goal: null, interests: [], starter: 'pythagoras', topic: 'Roman roads', replay: false });
    O.onboardingNext();
    await settle();
    ok('what they typed last is what gets built', O.primerFor() === 'Roman roads' && O.built().length === 1);

    O.reset();
    O.setPrimer('');
    O.setRun({ step: 3, goal: null, interests: [], starter: null, topic: 'a subject', replay: false });
    O.onboardingNext();
    await settle();
    ok('material that never arrives builds nothing', O.built().length === 0);
    ok('and says so instead of failing silently', O.errors().length === 1);
    ok('leaving them somewhere they can act', O.screen() === 'home');

    // Replaying it from the Account screen changes the answers and nothing else.
    O.reset();
    O.setState({ done: true, goal: 'exam', interests: ['math'], completedAt: 1000 });
    O.setRun({ step: 2, goal: 'curious', interests: ['mind'], starter: null, replay: true });
    await O.finishOnboarding({ starterId: null });
    ok('a replay updates the answers', O.state().interests[0] === 'mind' && O.state().goal === 'curious');
    ok('and leaves the date the account actually finished', O.state().completedAt === 1000);
    ok('landing back on the screen it was opened from', O.accountRenders() === 1);
    ok('rather than throwing them at the upload box', O.screen() === null);
  }

  console.log('\n== the answers, shown back ==');
  {
    O.reset();
    O.setState({ done: true, interests: [] });
    ok('no answer yet reads as an invitation', /tap/i.test(O.interestSummary()));
    O.setState({ done: true, interests: ['math', 'money'] });
    ok('two are listed by name', O.interestSummary().startsWith('Maths & logic, Money & business'));
    O.setState({ done: true, interests: ['math', 'money', 'mind', 'tech', 'life'] });
    ok('five are not', /and 2 more/.test(O.interestSummary()));
    O.setState({ done: true, interests: ['nonsense-that-was-removed'] });
    ok('an interest that no longer exists is dropped, not printed',
       !/nonsense/.test(O.interestSummary()));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
