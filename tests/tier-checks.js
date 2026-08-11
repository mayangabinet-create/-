/*
 * Tier checks — the two things SQL can't prove.
 *
 * Both need a real signed-in session, because both are about what the
 * ai-proxy Edge Function does with a request that a real JWT is attached to.
 * Paste this whole file into the browser console on the app, signed in, then:
 *
 *     await tierCheck('basic')
 *
 * Set the account's plan first (no Stripe yet, so this part is SQL):
 *
 *     update subscriptions set status='active', plan='basic',
 *            current_period_end = now() + interval '30 days'
 *      where user_id = '<uuid>';
 *
 * Then re-run for 'pro' and 'max', switching the plan row between runs.
 * Run them in that order: each call spends one course from the monthly
 * allowance (basic 3 / pro 5 / max 8) and the counter does not reset when
 * the plan changes, so basic → pro → max fits in one month's quota.
 *
 * What each run proves
 *   1. Sabotage — a client that ignores its own budget and sends 120,000
 *      chars gets clamped server-side to the tier's readChars. Observable in
 *      usage.input_tokens: ~4.3k on basic vs ~30k on max, from the same doc.
 *   2. Course size — the returned concept count is 10 / 12 / 15, because
 *      fixCourseSize() rewrites the client's "10-20" to the tier's number.
 *
 * Cost: basic/pro are cents. The max run is Opus reading ~30k tokens and
 * writing 4k — roughly $0.75. Run it once.
 */

const TIER_EXPECT = {
  trial: { concepts: 10, model: /haiku/,  docChars:   5000 },
  basic: { concepts: 10, model: /haiku/,  docChars:   5000 },
  pro:   { concepts: 12, model: /sonnet/, docChars:  40000 },
  max:   { concepts: 15, model: /opus/,   docChars: 120000 },
};

const TEMPLATE_ALLOWANCE = 12000;  // must match ai-proxy/index.ts

// Plausible English prose: ~4 chars/token, so the token counts below are
// predictable. Filler in Hebrew tokenizes at ~2 chars/token and the expected
// numbers would all double.
function buildDoc(chars) {
  const para =
    'Cellular respiration is the process by which cells release energy stored ' +
    'in glucose. It begins with glycolysis in the cytoplasm, which splits a ' +
    'six-carbon sugar into two molecules of pyruvate and yields a small net ' +
    'gain of ATP. The pyruvate then enters the mitochondrion, where the citric ' +
    'acid cycle strips it of electrons and loads them onto carrier molecules. ' +
    'Those carriers deliver the electrons to the transport chain embedded in ' +
    'the inner membrane, and the resulting proton gradient drives ATP synthase. ';
  let out = '';
  while (out.length < chars) out += para;
  return out.slice(0, chars);
}

// The real course-planning prompt shape, so fixCourseSize()'s regex matches
// the way it does in production rather than falling through to its fallback.
function coursePrompt(doc) {
  return `Analyse the study material below and extract its key concepts.

STUDY MATERIAL:
${doc}

TASK:
1. Identify 10-20 core concepts a learner must understand from this material.
2. Order them so that prerequisites come first.
3. For each concept give: name, description, importance.

Return JSON only: { "concepts": [ { "name": "", "description": "", "importance": "" } ] }`;
}

function extractJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  try { return JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)); }
  catch (_) { return null; }
}

async function tierCheck(plan) {
  const expect = TIER_EXPECT[plan];
  if (!expect) throw new Error(`unknown plan: ${plan}`);

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) throw new Error('not signed in — sign in first, then re-run');

  // 120,000 chars every time. That is the sabotage: the honest client would
  // have cut this to its tier's budget before sending, so anything above the
  // tier's readChars that survives is the server failing to clamp.
  const doc = buildDoc(120000);
  const message = coursePrompt(doc);

  const t0 = performance.now();
  const { data, error } = await supabaseClient.functions.invoke('ai-proxy', {
    body: {
      messages: [{ role: 'user', content: message }],
      max_tokens: 4000,   // >= 3500 → classified as a course call
      task: 'path',
    },
  });
  const secs = ((performance.now() - t0) / 1000).toFixed(1);

  if (error) {
    let payload = {};
    try { payload = await error.context.json(); } catch (_) {}
    console.error(`[${plan}] FAILED`, error.context?.status, payload);
    return { plan, ok: false, status: error.context?.status, payload };
  }

  const text = (data.content || []).filter(p => p.type === 'text').map(p => p.text).join('');
  const parsed = extractJson(text);
  const concepts = parsed?.concepts?.length ?? null;
  const inputTokens = data.usage?.input_tokens ?? null;

  // Chars the server let through, inferred from tokens. Compared against the
  // tier's budget plus the template allowance, with room for tokenizer drift.
  const budgetChars = expect.docChars + TEMPLATE_ALLOWANCE;
  const estChars = inputTokens * 4;
  const withinBudget = estChars <= budgetChars * 1.25;
  const sentTooLittle = estChars < budgetChars * 0.55;

  const results = {
    plan,
    seconds: secs,
    model: data.model,
    modelOk: expect.model.test(data.model || ''),
    inputTokens,
    estCharsThrough: Math.round(estChars),
    budgetChars,
    clampOk: withinBudget,
    fullBudgetUsed: !sentTooLittle,
    concepts,
    conceptsOk: concepts === expect.concepts,
    stopReason: data.stop_reason,
  };
  results.ok = results.modelOk && results.clampOk && results.fullBudgetUsed && results.conceptsOk;

  console.table(results);
  if (!results.clampOk) {
    console.error(`[${plan}] SABOTAGE GOT THROUGH: ~${Math.round(estChars)} chars reached the ` +
                  `model against a ${budgetChars} budget.`);
  }
  if (!results.fullBudgetUsed && plan !== 'trial') {
    console.warn(`[${plan}] clamped harder than the tier allows — this plan is ` +
                 `paying for ${expect.docChars} chars of reading and getting ~${Math.round(estChars)}.`);
  }
  if (!results.conceptsOk) {
    console.error(`[${plan}] expected ${expect.concepts} concepts, got ${concepts}.`);
  }
  if (results.stopReason === 'max_tokens') {
    console.warn(`[${plan}] response hit max_tokens — the concept count may be a ` +
                 `truncation artefact rather than what the model chose. Re-run before trusting it.`);
  }
  return results;
}
