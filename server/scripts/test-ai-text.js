// aiText (server/services/aiText.js) — the one Gemini call every paid lane makes, and what it does when a model
// is busy, hung, gone, or the key is dead.
//   node server/scripts/test-ai-text.js
//
// ⚠️ WHY: 2026-09-18, user 1, Home → Cover letters → Amazon. gemini-2.5-flash answered 503 "high demand" twice,
// back to back, and the letter lane gave up: "That cover letter didn't finish". Every rule tested here is one that
// incident (or the orchestrator's measurements that day) proved necessary: a pause before the primary's second
// try, a fallback chain, a 404 that is skipped rather than fatal, a quota/auth failure that stops at ONE call and
// pages the operator, a hang that is ABORTED at its cap, one budget for the whole chain, and a progress hook that
// cannot break the build it reports on.
// NO NETWORK: a fake GoogleGenerativeAI is injected through `sdk` (and, for the lazy-require case, through
// require.cache), and adminNotifier is stubbed so the REAL aiHealth can page without a database. Waits are tiny
// real ones (the 2 s pause is shrunk to 30 ms through _internals.settings; its default is asserted first).
'use strict';
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
process.env.GEMINI_API_KEY = 'test-key-not-used';
delete process.env.AI_TEXT_FALLBACK_MODELS;

let pass = 0, fail = 0;
const print = console.log.bind(console);
const ok = (n, c, x) => { if (c) pass++; else { fail++; print('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 400) : '')); } };

// ── the operator's pager: the REAL aiHealth, with adminNotifier stubbed underneath it ─────────────────────
const pages = [];
const stubAt = (abs, exports) => { const p = require.resolve(abs); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stubAt(path.join(ROOT, 'server/services/adminNotifier.js'), { notifyAdmins: async (category, title, body, data) => { pages.push({ category, title, data }); } });

const AT = require(path.join(ROOT, 'server/services/aiText.js'));
const { generateText, fallbackModels, AiUnavailableError, isAiBusy, _internals } = AT;
const { settings, chainFor, capFor, floorFor, retryWaitFor, classify, planNext } = _internals;

// ── the log: every [aiText] / [aiHealth] line is captured, so the suite can read what an operator would read ──
const logs = [];
for (const k of ['log', 'warn', 'error']) console[k] = (...a) => { logs.push(a.map(String).join(' ')); };
const logsSince = (i) => logs.slice(i);

let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

const P = 'gemini-2.5-flash', F1 = 'gemini-2.5-flash-lite', F2 = 'gemini-3.1-flash-lite';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the failures Google actually sends (shapes from the SDK: GoogleGenerativeAIFetchError carries .status) ────
const sdkErr = (model, status, statusText, text) => Object.assign(
  new Error(`[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent: [${status} ${statusText}] ${text}`),
  { status, statusText });
const E503 = (m = P) => sdkErr(m, 503, 'Service Unavailable', 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.');
// The lanes' own suites throw message-only errors (no .status): the text alone must classify the same way.
const E503_TEXT = () => new Error('[503 Service Unavailable] This model is currently experiencing high demand');
const E404 = (m) => sdkErr(m, 404, 'Not Found', `models/${m} is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.`);
const E429 = (m = P) => sdkErr(m, 429, 'Too Many Requests', 'Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing. [RESOURCE_EXHAUSTED]');
// ONE MODEL's rate limit under load — the 429 that is NOT the key running dry (no "prepayment credits" text).
const ERATE = (m = P) => sdkErr(m, 429, 'Too Many Requests', 'Resource has been exhausted (e.g. check quota). [RESOURCE_EXHAUSTED]');
const EKEY = (m = P) => sdkErr(m, 400, 'Bad Request', 'API key not valid. Please pass a valid API key. [{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID"}]');
const E403 = (m = P) => sdkErr(m, 403, 'Forbidden', 'Method doesn\'t allow unregistered callers. [PERMISSION_DENIED]');
const E400 = (m) => sdkErr(m, 400, 'Bad Request', 'Invalid JSON payload received. Unknown name "thinkingBudget" at \'generation_config.thinking_config\'.');
const HANG = { hang: true };
const DEAF = { deaf: true };   // hangs AND ignores its abort signal: only the race can end the wait
const TRUNC = { truncated: true };

/**
 * A fake GoogleGenerativeAI. `script` maps a model id to its answers, in order: a string is the text (padded, so
 * the trim is proven), an Error is thrown, HANG never answers until the request's signal aborts it (as the real
 * fetch does), DEAF never answers at all (it ignores the signal), TRUNC finishes with MAX_TOKENS. An empty script
 * answers 'OK <model>'.
 */
function fakeSdk(script = {}) {
  const calls = [];
  class FakeGenAI {
    constructor(key) { this.key = key; }
    getGenerativeModel(params) {
      const key = this.key;
      return {
        generateContent(prompt, opts) {
          const call = { model: params.model, cfg: params.generationConfig, prompt, opts, key, t: Date.now(), aborted: false };
          calls.push(call);
          const q = script[params.model] || [];
          const step = q.length ? q.shift() : `OK ${params.model}`;
          if (step instanceof Error) return Promise.reject(step);
          if (step === HANG) {
            return new Promise((_, reject) => {
              const sig = opts && opts.signal;
              if (sig) sig.addEventListener('abort', () => { call.aborted = true; reject(new Error(`Request aborted when fetching https://generativelanguage.googleapis.com/v1beta/models/${params.model}:generateContent: This operation was aborted`)); });
            });
          }
          if (step === DEAF) return new Promise(() => {});
          if (step === TRUNC) return Promise.resolve({ response: { candidates: [{ finishReason: 'MAX_TOKENS' }], text: () => '{"cover_letter":"cut off mid-' } });
          return Promise.resolve({ response: { candidates: [{ finishReason: 'STOP' }], text: () => `  ${step}\n` } });
        },
      };
    }
  }
  FakeGenAI.calls = calls;
  return FakeGenAI;
}

// A watchdog on every call: a build that never settles is a FAILED case, not a hung suite. Cleared on settle, so
// the timer count in the hygiene case sees only the module's own timers.
const run = (opts, ms = 4000) => {
  let dog = null;
  return Promise.race([
    generateText(opts).then((r) => ({ r }), (e) => ({ e })),
    new Promise((resolve) => { dog = setTimeout(() => resolve({ watchdog: true }), ms); }),
  ]).finally(() => clearTimeout(dog));
};
const modelsOf = (sdk) => sdk.calls.map((c) => c.model);
// Guarded reads, so a broken implementation shows up as a ✗ line rather than a TypeError that ends the suite.
const gap = (sdk, a, b) => (sdk.calls[a] && sdk.calls[b] ? sdk.calls[b].t - sdk.calls[a].t : NaN);
const att = (e) => (e && Array.isArray(e.attempts) ? e.attempts : []);
const STEP_RE = /^\[aiText\] [a-z_]+: [a-z0-9.-]+ (transient|gone|quota|rate|auth|truncated|other) in \d+ms -> /;

// Safety net: whatever happens, the suite ends.
setTimeout(() => { print('TEST TIMEOUT'); process.exit(2); }, 60 * 1000).unref();

(async () => {
  print('── the contract surface and its defaults ──');
  ok('exports exactly generateText, fallbackModels, AiUnavailableError, isAiBusy, _internals',
    JSON.stringify(Object.keys(AT).sort()) === JSON.stringify(['AiUnavailableError', '_internals', 'fallbackModels', 'generateText', 'isAiBusy']), Object.keys(AT));
  ok('the primary is gemini-2.5-flash, and the VERIFIED default fallbacks are exactly [gemini-2.5-flash-lite, gemini-3.1-flash-lite]',
    _internals.DEFAULT_PRIMARY === P && JSON.stringify(fallbackModels()) === JSON.stringify([F1, F2]) && JSON.stringify(chainFor('letter')) === JSON.stringify([P, F1, F2]), fallbackModels());
  ok('default timing: a 2000 ms pause + up to 800 ms jitter, an 8 s floor, a 180 s budget, caps 60 s first / 40 s after',
    settings.retryWaitMs === 2000 && settings.retryJitterMs === 800 && settings.minAttemptMs === 8000 && _internals.DEFAULT_BUDGET_MS === 180000
    && capFor(undefined, 0) === 60000 && [1, 2, 3, 9].every((i) => capFor(undefined, i) === 40000), settings);
  ok('the pause is ~2 s + jitter: rand 0 → 2000, rand ≈1 → 2800, never outside [2000, 2800]',
    retryWaitFor(() => 0) === 2000 && retryWaitFor(() => 0.99999) === 2800 && Array.from({ length: 200 }, () => retryWaitFor()).every((w) => w >= 2000 && w <= 2800));
  ok('capFor: a number caps every attempt, [first, later] repeats its last entry, { first, later } works, junk → the default',
    capFor(5000, 3) === 5000 && capFor([100, 50], 0) === 100 && capFor([100, 50], 7) === 50 && capFor({ first: 10, later: 5 }, 0) === 10 && capFor({ first: 10, later: 5 }, 4) === 5
    && capFor([-1], 0) === 60000 && capFor('x', 2) === 40000 && capFor([], 0) === 60000);
  ok('floorFor: never start with less than 8 s — or than the attempt\'s own cap, when that is smaller', floorFor(60000) === 8000 && floorFor(40000) === 8000 && floorFor(50) === 50);
  ok('classify: the incident 503 (status AND text-only), a hang, an abort → transient; 404 → gone; DEPLETED credits → quota; ONE model\'s 429 → rate; bad key / 403 → auth; MAX_TOKENS → truncated; a 400 bad request → other',
    classify(E503()) === 'transient' && classify(E503_TEXT()) === 'transient' && classify(new Error('AI_TIMEOUT')) === 'transient'
    && classify(new Error('Request aborted when fetching https://x: This operation was aborted')) === 'transient' && classify(new Error('fetch failed')) === 'transient'
    && classify(E404('gemini-2.5-pro')) === 'gone' && classify(new Error('models/gemini-2.5-pro is not found for API version v1beta')) === 'gone'
    && classify(E429()) === 'quota' && classify(new Error('Your prepayment credits are depleted. [RESOURCE_EXHAUSTED]')) === 'quota'
    && classify(ERATE()) === 'rate' && classify(new Error('429 RESOURCE_EXHAUSTED')) === 'rate'
    && classify(EKEY()) === 'auth' && classify(E403()) === 'auth' && classify(new Error('TRUNCATED_OUTPUT')) === 'truncated' && classify(E400(F2)) === 'other',
    [E503(), E404('x'), E429(), EKEY(), E403(), E400('x')].map(classify));
  ok('⚠️ a 503 WITH A STATUS is transient even when its text happens to contain "403" (aiHealth\'s bare 401|403 would call it auth and stop the chain)',
    classify(Object.assign(new Error('[503 Service Unavailable] overloaded, request 4031977'), { status: 503 })) === 'transient');

  // The real pause would make this suite 20 s long; its default is asserted above. No jitter below: exact numbers.
  settings.retryWaitMs = 30; settings.retryJitterMs = 0;

  print('── the incident: the primary 503s, then answers — ONE pause, no fallback ──');
  {
    const sdk = fakeSdk({ [P]: [E503(), 'Dear Amazon'] });
    const retries = []; const mark = logs.length;
    const out = await run({ lane: 'letter', prompt: 'write it', config: { temperature: 0.7 }, sdk, onRetry: (i) => retries.push(i) });
    ok('it answers: text trimmed, model = the primary, attempts 2, fellBack false', out.r && out.r.text === 'Dear Amazon' && out.r.model === P && out.r.attempts === 2 && out.r.fellBack === false, out);
    ok('two calls, both to the primary, with the ~2 s pause (30 ms here) between them — not back to back',
      JSON.stringify(modelsOf(sdk)) === JSON.stringify([P, P]) && gap(sdk, 0, 1) >= 28, { models: modelsOf(sdk), gap: gap(sdk, 0, 1) });
    ok('onRetry once, with exactly { model, attempt, kind, nextModel, waitMs }', retries.length === 1
      && JSON.stringify(Object.keys(retries[0]).sort()) === JSON.stringify(['attempt', 'kind', 'model', 'nextModel', 'waitMs'])
      && JSON.stringify(retries[0]) === JSON.stringify({ model: P, attempt: 1, kind: 'transient', nextModel: P, waitMs: 30 }), retries);
    const step = logsSince(mark).filter((l) => l.startsWith('[aiText]'));
    ok('one log line for the retry, in the house format "[aiText] letter: gemini-2.5-flash transient in Nms -> retrying gemini-2.5-flash in 30ms", with Google\'s words and NOT its 130-char URL prefix',
      step.length === 2 && STEP_RE.test(step[0]) && /-> retrying gemini-2\.5-flash in 30ms \| \[503 Service Unavailable\] This model is currently experiencing high demand/.test(step[0]) && !/generativelanguage/.test(step[0]), step);
    ok('…and the success after a retry says who answered: "[aiText] letter: answered by gemini-2.5-flash after 2 attempts"', step[1] === '[aiText] letter: answered by gemini-2.5-flash after 2 attempts', step);

    const sdk2 = fakeSdk({ [P]: [E503_TEXT(), 'ok'] });
    const out2 = await run({ lane: 'letter', prompt: 'p', sdk: sdk2 });
    ok('the same with a message-only 503 (the lanes\' own stubs carry no status)', out2.r && out2.r.model === P && sdk2.calls.length === 2, out2);

    const sdk3 = fakeSdk({});
    const mark3 = logs.length; let told = 0;
    const out3 = await run({ lane: 'letter', prompt: 'p', sdk: sdk3, onRetry: () => { told++; } });
    ok('a first-try answer: ONE call, attempts 1, fellBack false, no onRetry, not a single log line', out3.r && out3.r.attempts === 1 && out3.r.fellBack === false && sdk3.calls.length === 1 && told === 0 && logsSince(mark3).length === 0, { out3, logs: logsSince(mark3) });
  }

  print('── 503 twice → the first fallback answers ──');
  {
    const sdk = fakeSdk({ [P]: [E503(), E503()], [F1]: ['From lite'] });
    const retries = []; const mark = logs.length;
    const out = await run({ lane: 'letter', prompt: 'p', sdk, onRetry: (i) => retries.push(i) });
    ok('answered by gemini-2.5-flash-lite: model recorded, fellBack true, attempts 3', out.r && out.r.model === F1 && out.r.fellBack === true && out.r.attempts === 3 && out.r.text === 'From lite', out);
    ok('calls: primary, primary, flash-lite — and gemini-3.1-flash-lite never called', JSON.stringify(modelsOf(sdk)) === JSON.stringify([P, P, F1]), modelsOf(sdk));
    ok('the move to the fallback is immediate (waitMs 0, no pause between the calls)', retries.length === 2 && JSON.stringify(retries[1]) === JSON.stringify({ model: P, attempt: 2, kind: 'transient', nextModel: F1, waitMs: 0 }) && gap(sdk, 1, 2) < 25, { retries, gap: gap(sdk, 1, 2) });
    const lines = logsSince(mark);
    ok('logs "-> falling back to gemini-2.5-flash-lite" and "answered by gemini-2.5-flash-lite after 3 attempts"',
      lines.some((l) => STEP_RE.test(l) && l.includes(`${P} transient`) && l.includes(`-> falling back to ${F1}`)) && lines.includes(`[aiText] letter: answered by ${F1} after 3 attempts`), lines);

    const sdk2 = fakeSdk({ [P]: [E503(), E503()], [F1]: [E503(F1)], [F2]: ['From 3.1'] });
    const out2 = await run({ lane: 'resume_doc', prompt: 'p', sdk: sdk2 });
    ok('a busy fallback is not retried: straight on to gemini-3.1-flash-lite (4 calls, one on flash-lite)', out2.r && out2.r.model === F2 && JSON.stringify(modelsOf(sdk2)) === JSON.stringify([P, P, F1, F2]) && out2.r.attempts === 4, { out2, m: modelsOf(sdk2) });
  }

  print('── a model that is GONE (404) is skipped, never fatal ──');
  {
    const pagesBefore = pages.length; const mark = logs.length;
    const sdk = fakeSdk({ [P]: [E503(), E503()], [F1]: [E404(F1)], [F2]: ['From 3.1'] });
    const out = await run({ lane: 'letter', prompt: 'p', sdk });
    ok('a gone fallback is skipped and the next model answers', out.r && out.r.model === F2 && JSON.stringify(modelsOf(sdk)) === JSON.stringify([P, P, F1, F2]), { out, m: modelsOf(sdk) });
    ok('…with ONE call to the gone model (no same-model retry for a 404)', modelsOf(sdk).filter((m) => m === F1).length === 1);
    const lines = logsSince(mark);
    ok('…logged "-> skipped (gone), falling back to gemini-3.1-flash-lite" plus a loud line naming AI_TEXT_FALLBACK_MODELS — and NO page (a skipped fallback is not an outage)',
      lines.some((l) => STEP_RE.test(l) && l.includes(`${F1} gone`) && l.includes(`-> skipped (gone), falling back to ${F2}`)) && lines.some((l) => /fallback gemini-2\.5-flash-lite no longer exists — fix AI_TEXT_FALLBACK_MODELS/.test(l)) && pages.length === pagesBefore, { lines, pages });

    const sdk2 = fakeSdk({ [P]: [E404(P)], [F1]: ['From lite'] });
    const retries = [];
    const out2 = await run({ lane: 'letter', prompt: 'p', sdk: sdk2, onRetry: (i) => retries.push(i) });
    ok('a gone PRIMARY: skipped at once (no pause, no second try) and the fallback answers', out2.r && out2.r.model === F1 && out2.r.fellBack && JSON.stringify(modelsOf(sdk2)) === JSON.stringify([P, F1]) && retries.length === 1 && retries[0].kind === 'gone' && retries[0].waitMs === 0, { out2, retries });
    await sleep(5);
    ok('…and a gone primary DOES page the operator (every build now runs on fallbacks): aiHealth → adminNotifier, kind gone',
      pages.length === pagesBefore + 1 && pages[pages.length - 1].data && pages[pages.length - 1].data.kind === 'gone' && pages[pages.length - 1].data.type === 'ai_outage', pages);

    const sdk3 = fakeSdk({ [P]: [E404(P)], [F1]: [E404(F1)], [F2]: [E404(F2)] });
    const out3 = await run({ lane: 'letter', prompt: 'p', sdk: sdk3 });
    ok('EVERY model gone: kind "other" (a config fault, not a busy provider), the 404 text as the message, 3 calls',
      out3.e instanceof AiUnavailableError && out3.e.kind === 'other' && !isAiBusy(out3.e) && /is not found for API version/.test(out3.e.message) && sdk3.calls.length === 3, out3.e && { kind: out3.e.kind, msg: out3.e.message });
  }

  print('── ⚠️ ONE model\'s 429 is not the key running dry: walk the chain, do not page ──');
  {
    // The spike this module exists for: Google meters per model, so flash-lite can be rate-limited while the next
    // model has room. Reading that 429 as "credits exhausted" failed a build one more model would have finished,
    // told the user the provider was DOWN (no retry), and paged the operator to top up credits that were fine.
    // The page REQUEST is read off a spy on aiHealth.noteAiFailure, not off the pager: aiHealth throttles one alert
    // per kind per process, so a real quota page here would swallow the fail-fast block's own page below.
    const AH = require(path.join(ROOT, 'server/services/aiHealth.js'));
    const realNote = AH.noteAiFailure;
    const noted = [];
    AH.noteAiFailure = (err, where, override) => { noted.push({ kind: (override && override.kind) || AH.classifyAiError(err), where, title: override && override.title, human: override && override.human }); };
    const sdk = fakeSdk({ [P]: [ERATE()], [F1]: ['{"ok":1}'] });
    const out = await run({ lane: 'letter', prompt: 'p', sdk });
    ok('a rate-limited PRIMARY falls to the first fallback at once (no pause) and the letter lands',
      out.r && out.r.model === F1 && out.r.fellBack === true && JSON.stringify(modelsOf(sdk)) === JSON.stringify([P, F1]) && gap(sdk, 0, 1) < 1000,
      { models: modelsOf(sdk), r: out.r, e: out.e && out.e.message });
    ok('…and NOBODY was paged — a per-model limit is not an outage', noted.length === 0, noted);

    const sdk2 = fakeSdk({ [P]: [E503(), E503()], [F1]: [ERATE(F1)], [F2]: ['{"ok":2}'] });
    const out2 = await run({ lane: 'resume_doc', prompt: 'p', sdk: sdk2 });
    ok('a rate-limited FALLBACK hands on to the next model (the incident chain: 503, 503, 429, then an answer)',
      out2.r && out2.r.model === F2 && JSON.stringify(modelsOf(sdk2)) === JSON.stringify([P, P, F1, F2]), { models: modelsOf(sdk2), e: out2.e && out2.e.message });

    const sdk3 = fakeSdk({ [P]: [E503(), E503()], [F1]: [ERATE(F1)], [F2]: [E503(F2)] });
    const out3 = await run({ lane: 'letter', prompt: 'p', sdk: sdk3 });
    ok('overload and a rate limit together, nothing answered → BUSY (retryable: try again in a minute)',
      out3.e instanceof AiUnavailableError && out3.e.kind === 'busy' && isAiBusy(out3.e) && out3.e.retryable !== false, out3.e && { kind: out3.e.kind });

    ok('…nor for overload mixed with a rate limit (that is a busy provider, not the key)', noted.length === 0, noted);
    const sdk4 = fakeSdk({ [P]: [ERATE()], [F1]: [ERATE(F1)], [F2]: [ERATE(F2)] });
    const out4 = await run({ lane: 'letter', prompt: 'p', sdk: sdk4 });
    // ⚠️ Still BUSY: a 429 without the depletion text is a per-minute limit that clears on its own, so the user is told
    // to try again in a minute — not "unavailable" with no retry (a key with no credit says so, and fails fast above).
    ok('⚠️ rate-limited on EVERY model → BUSY (retryable: it clears), all three tried — never "unavailable"',
      out4.e instanceof AiUnavailableError && out4.e.kind === 'busy' && isAiBusy(out4.e) && out4.e.retryable !== false && sdk4.calls.length === 3, out4.e && { kind: out4.e.kind, calls: sdk4.calls.length });
    ok('…and only THEN is the operator paged — once, as a RATE LIMIT in its own words, never "top up credits"',
      noted.length === 1 && noted[0].kind === 'rate' && noted[0].where === 'aiText.letter'
      && /rate-limited/i.test(noted[0].title || '') && /429/.test(noted[0].human || '') && !/top up/i.test(noted[0].human || ''), noted);

    // One model's limit is a burst, not an outage: a one-model chain (AI_TEXT_FALLBACK_MODELS=none, or a caller that
    // names one model) or a chain the clock cut short answers busy and pages NOBODY.
    const noted1 = noted.length;
    const sdk5 = fakeSdk({ [P]: [ERATE()] });
    const out5 = await run({ lane: 'letter', prompt: 'p', sdk: sdk5, models: [P] });
    ok('a ONE-model chain rate-limited → busy (retryable), one call, and NOT paged',
      out5.e instanceof AiUnavailableError && out5.e.kind === 'busy' && out5.e.retryable !== false && sdk5.calls.length === 1 && noted.length === noted1,
      { kind: out5.e && out5.e.kind, calls: sdk5.calls.length, noted: noted.slice(noted1) });
    ok('…and each step logs as "rate", naming the fallback it moved to',
      logs.some((l) => /\[aiText\] letter: gemini-2\.5-flash rate in \d+ms -> rate-limited, falling back to gemini-2\.5-flash-lite/.test(l)));
    AH.noteAiFailure = realNote;
  }

  print('── aiHealth.noteAiFailure: an override names the failure; without one nothing changed ──');
  {
    // The REAL pager (adminNotifier stubbed underneath): the override is what makes the rate-limit page accurate.
    const AH = require(path.join(ROOT, 'server/services/aiHealth.js'));
    const p0 = pages.length;
    const k = AH.noteAiFailure(ERATE(F2), 'aiText.test_override', { kind: 'rate', title: 'AI models are rate-limited', human: 'every model answered 429' });
    await sleep(5);
    ok('with an override it pages in the CALLER\'s words and kind (not "AI credits are exhausted")',
      k === 'rate' && pages.length === p0 + 1 && pages[pages.length - 1].title === 'AI models are rate-limited'
      && pages[pages.length - 1].data.kind === 'rate' && pages[pages.length - 1].data.type === 'ai_outage', pages.slice(p0));
    const p1 = pages.length;
    const k2 = AH.noteAiFailure(E503(), 'aiText.test_override');
    await sleep(5);
    ok('…without one it is exactly as before: a 503 is transient, logged, never paged', k2 === 'transient' && pages.length === p1, pages.slice(p1));
    const k3 = AH.noteAiFailure(ERATE(F2), 'aiText.test_override', { kind: 'rate', human: 'again' });
    await sleep(5);
    ok('…and the override is throttled per ITS kind like any other page (one per window)', k3 === 'rate' && pages.length === p1, pages.slice(p1));
  }

  print('── ⚠️ a progress reporter that never settles cannot hang the build ──');
  {
    const sdk = fakeSdk({ [P]: [E503(), E503()], [F1]: ['{"ok":1}'] });
    let calls = 0;
    const t0 = Date.now();
    const out = await run({ lane: 'letter', prompt: 'p', sdk, onRetry: () => { calls++; return new Promise(() => {}); } }, 20000);
    ok('the build still lands on the fallback although onRetry never resolves',
      out.r && out.r.model === F1 && !out.watchdog && calls >= 1, { r: out.r, watchdog: out.watchdog, calls });
    ok('…having waited at most the reporter cap per retry (not for ever)', Date.now() - t0 < _internals.TELL_RETRY_CAP_MS * calls + 6000, Date.now() - t0);
  }

  print('── quota and auth FAIL FAST after one call, and page the operator ──');
  {
    const pagesBefore = pages.length; let told = 0;
    const sdk = fakeSdk({ [P]: [E429()] });
    const out = await run({ lane: 'letter', prompt: 'p', sdk, onRetry: () => { told++; } });
    const e = out.e;
    ok('quota: AiUnavailableError kind "quota" after exactly ONE call — every model shares the key', e instanceof AiUnavailableError && e.kind === 'quota' && sdk.calls.length === 1 && told === 0, e && { kind: e.kind, calls: sdk.calls.length });
    ok('…attempts lists that one call, retryable false, not busy, lane recorded', att(e).length === 1 && att(e)[0].model === P && att(e)[0].kind === 'quota' && typeof att(e)[0].ms === 'number' && e.retryable === false && !isAiBusy(e) && e.lane === 'letter', e && e.attempts);
    await sleep(5);
    ok('…and aiHealth paged the operator (kind quota, the ai_outage alarm)', pages.length === pagesBefore + 1 && pages[pages.length - 1].data.kind === 'quota' && pages[pages.length - 1].data.type === 'ai_outage', pages);

    const sdkF = fakeSdk({ [P]: [E503(), E503()], [F1]: [E429(F1)] });
    const outF = await run({ lane: 'letter', prompt: 'p', sdk: sdkF });
    ok('quota on a FALLBACK stops the chain there too (gemini-3.1-flash-lite never called)', outF.e && outF.e.kind === 'quota' && JSON.stringify(modelsOf(sdkF)) === JSON.stringify([P, P, F1]), modelsOf(sdkF));

    const pagesBefore2 = pages.length;
    const sdk2 = fakeSdk({ [P]: [EKEY()] });
    const out2 = await run({ lane: 'resume_builder', prompt: 'p', sdk: sdk2 });
    ok('auth ("400 API key not valid"): kind "auth" after exactly ONE call, retryable false', out2.e instanceof AiUnavailableError && out2.e.kind === 'auth' && sdk2.calls.length === 1 && out2.e.retryable === false, out2.e && { kind: out2.e.kind, calls: sdk2.calls.length });
    await sleep(5);
    ok('…and paged (kind auth)', pages.length === pagesBefore2 + 1 && pages[pages.length - 1].data.kind === 'auth', pages);
    const sdk3 = fakeSdk({ [P]: [E403()] });
    const out3 = await run({ lane: 'letter', prompt: 'p', sdk: sdk3 });
    ok('a 403 PERMISSION_DENIED is auth too, after one call', out3.e && out3.e.kind === 'auth' && sdk3.calls.length === 1, out3.e && out3.e.kind);

    const sdk4 = fakeSdk({ [P]: [Object.assign(new Error('[503 Service Unavailable] overloaded, request 4031977'), { status: 503 }), 'still here'] });
    const out4 = await run({ lane: 'letter', prompt: 'p', sdk: sdk4 });
    ok('⚠️ a 503 whose text contains "403" does NOT stop the chain as auth: the primary is retried and answers', out4.r && out4.r.model === P && sdk4.calls.length === 2, out4);

    const key = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
    const pagesBefore5 = pages.length;
    const sdk5 = fakeSdk({});
    const out5 = await run({ lane: 'letter', prompt: 'p', sdk: sdk5 });
    process.env.GEMINI_API_KEY = key;
    ok('no key: kind auth with the message EXACTLY "GEMINI_API_KEY not set" (the lanes test for it), no SDK call, no page',
      out5.e instanceof AiUnavailableError && out5.e.kind === 'auth' && out5.e.message === 'GEMINI_API_KEY not set' && sdk5.calls.length === 0 && pages.length === pagesBefore5, out5.e && out5.e.message);
    ok('the key reaches the SDK constructor', sdk4.calls.every((c) => c.key === 'test-key-not-used'));
  }

  print('── a HANG is aborted at its cap and becomes a transient ──');
  {
    const sdk = fakeSdk({ [P]: [HANG, HANG], [F1]: ['From lite'] });
    const t0 = Date.now();
    const out = await run({ lane: 'letter', prompt: 'p', sdk, attemptCapsMs: [120, 80] });
    const took = Date.now() - t0;
    ok('two hung primary calls, then the fallback answers', out.r && out.r.model === F1 && JSON.stringify(modelsOf(sdk)) === JSON.stringify([P, P, F1]), { out, m: modelsOf(sdk) });
    ok('⚠️ both hung requests were ABORTED through their signal (a real cancel, not just "stop waiting")', sdk.calls.length >= 2 && sdk.calls[0].aborted === true && sdk.calls[1].aborted === true && sdk.calls[0].opts && sdk.calls[0].opts.signal && sdk.calls[0].opts.signal.aborted === true, sdk.calls.map((c) => c.aborted));
    ok(`each attempt kept ITS cap (first 120 ms, then 80 ms) plus the 30 ms pause: ${took} ms in [225, 600)`, took >= 225 && took < 600 && gap(sdk, 0, 1) >= 145 && gap(sdk, 1, 2) >= 75 && gap(sdk, 1, 2) < 200,
      { took, g1: gap(sdk, 0, 1), g2: gap(sdk, 1, 2) });
    const sdkD = fakeSdk({ [P]: [DEAF, DEAF], [F1]: ['From lite'] });
    const tD = Date.now();
    const outD = await run({ lane: 'letter', prompt: 'p', sdk: sdkD, attemptCapsMs: [60, 40] });
    ok(`a request that IGNORES its abort still ends at its cap: the wait is raced, not just signalled (${Date.now() - tD} ms)`, outD.r && outD.r.model === F1 && JSON.stringify(modelsOf(sdkD)) === JSON.stringify([P, P, F1]) && Date.now() - tD < 400, { outD, m: modelsOf(sdkD) });
    const e = await run({ lane: 'letter', prompt: 'p', sdk: fakeSdk({ [P]: [HANG, HANG], [F1]: [HANG], [F2]: [HANG] }), attemptCapsMs: 40 });
    ok('hangs everywhere: kind busy, 4 attempts, every one transient', isAiBusy(e.e) && att(e.e).length === 4 && att(e.e).every((a) => a.kind === 'transient' && a.ms >= 35), e.e ? att(e.e) : e);
  }

  print('── ONE budget for the whole chain ──');
  {
    const sdk = fakeSdk({ [P]: [HANG, HANG], [F1]: [HANG], [F2]: [HANG] });
    const t0 = Date.now(); const mark = logs.length;
    const out = await run({ lane: 'letter', prompt: 'p', sdk, budgetMs: 150, attemptCapsMs: [100, 100] });
    const took = Date.now() - t0;
    ok('budget 150 ms, caps 100 ms: after the first hang no attempt can finish in the ~50 ms left, so NONE is started (1 call)', isAiBusy(out.e) && sdk.calls.length === 1 && att(out.e).length === 1, { calls: modelsOf(sdk), e: out.e && out.e.message });
    ok(`…and the call ends inside its budget (${took} ms < 190)`, took < 190, took);
    ok('…logged "-> giving up (budget spent)"', logsSince(mark).some((l) => STEP_RE.test(l) && l.includes('-> giving up (budget spent)')), logsSince(mark));

    settings.minAttemptMs = 40;
    const sdk2 = fakeSdk({ [P]: [HANG, HANG], [F1]: [HANG] });
    const t1 = Date.now();
    const out2 = await run({ lane: 'letter', prompt: 'p', sdk: sdk2, budgetMs: 200, attemptCapsMs: [100, 100] });
    const took2 = Date.now() - t1;
    settings.minAttemptMs = 8000;
    ok(`with a 40 ms floor the retry still fits, but SHORTENED to what is left (${att(out2.e)[1] && att(out2.e)[1].ms} ms < its 100 ms cap), and the chain ends at the budget (${took2} ms < 240)`,
      isAiBusy(out2.e) && sdk2.calls.length === 2 && att(out2.e).length === 2 && att(out2.e)[1].ms < 90 && took2 < 240, { took2, a: att(out2.e) });

    const sdk3 = fakeSdk({});
    const out3 = await run({ lane: 'letter', prompt: 'p', sdk: sdk3, budgetMs: 5, attemptCapsMs: 100 });
    ok('a budget smaller than any attempt: NO call at all, kind busy, attempts []', out3.e && isAiBusy(out3.e) && sdk3.calls.length === 0 && Array.isArray(out3.e.attempts) && out3.e.attempts.length === 0, out3.e && out3.e.message);

    // planNext is pure: the same inputs give the same move, and the "does it fit" test uses the LONGEST wait.
    const chain = [P, F1, F2];
    const now = 1e6;
    settings.retryJitterMs = 10;
    const fit = planNext({ chain, at: { index: 0, tries: 1 }, kind: 'transient', nextIndex: 1, caps: 100, deadline: now + 30 + 10 + 100, now });
    const noFit = planNext({ chain, at: { index: 0, tries: 1 }, kind: 'transient', nextIndex: 1, caps: 100, deadline: now + 30 + 10 + 99, now });
    settings.retryJitterMs = 0;
    ok('planNext: the primary retry is planned only when the LONGEST pause (wait + all the jitter) still leaves a full floor; one ms short → the next model at once',
      fit.index === 0 && fit.waitMs >= 30 && fit.waitMs <= 40 && noFit.index === 1 && noFit.waitMs === 0, { fit, noFit });
    const again = planNext({ chain, at: { index: 0, tries: 2 }, kind: 'transient', nextIndex: 2, caps: 100, deadline: now + 10000, now });
    const fb = planNext({ chain, at: { index: 1, tries: 1 }, kind: 'transient', nextIndex: 3, caps: 100, deadline: now + 10000, now });
    const last = planNext({ chain, at: { index: 2, tries: 1 }, kind: 'transient', nextIndex: 4, caps: 100, deadline: now + 10000, now });
    ok('planNext: a second primary transient → fallback 1; a transient fallback → the next at once (no second try); the last model → stop "no model left"',
      again.index === 1 && again.waitMs === 0 && fb.index === 2 && fb.waitMs === 0 && last.stop === 'no model left', { again, fb, last });
  }

  print('── every model busy → kind busy, every attempt listed ──');
  {
    const sdk = fakeSdk({ [P]: [E503(), E503()], [F1]: [E503(F1)], [F2]: [E503(F2)] });
    const retries = []; const mark = logs.length;
    const out = await run({ lane: 'letter', prompt: 'p', sdk, onRetry: (i) => retries.push(i) });
    const e = out.e;
    ok('AiUnavailableError, kind busy, isAiBusy true, retryable true, lane "letter", an Error', e instanceof AiUnavailableError && e instanceof Error && e.name === 'AiUnavailableError' && e.kind === 'busy' && isAiBusy(e) && e.retryable === true && e.lane === 'letter', e && { kind: e.kind, lane: e.lane });
    ok('attempts lists EVERY call in order: primary ×2, flash-lite, 3.1-flash-lite — all transient, each with its ms',
      JSON.stringify(att(e).map((a) => [a.model, a.kind])) === JSON.stringify([[P, 'transient'], [P, 'transient'], [F1, 'transient'], [F2, 'transient']]) && att(e).every((a) => Number.isFinite(a.ms) && a.ms >= 0), att(e));
    ok('the message says AI_BUSY and names the models; the cause is the last provider error', e && /^AI_BUSY: letter got no answer from gemini-2\.5-flash, gemini-2\.5-flash-lite, gemini-3\.1-flash-lite \(4 attempts, no model left\)/.test(e.message) && e.cause instanceof Error, e && e.message);
    ok('onRetry three times (one per retry/fallback), never after the last failure', retries.length === 3 && retries.map((r) => r.nextModel).join() === [P, F1, F2].join(), retries);
    const steps = logsSince(mark).filter((l) => STEP_RE.test(l));
    ok('one log line per failed attempt (4), the last one "-> giving up (no model left)"', steps.length === 4 && steps[3].includes('-> giving up (no model left)'), steps);
    ok('isAiBusy is false for anything else', !isAiBusy(new Error('AI_BUSY')) && !isAiBusy(null) && !isAiBusy(new AiUnavailableError('quota')) && isAiBusy(Object.assign(new Error('x'), { name: 'AiUnavailableError', kind: 'busy' })));
  }

  print('── TRUNCATED_OUTPUT: one more try on the same model, then the next ──');
  {
    const retries = [];
    const sdk = fakeSdk({ [P]: [TRUNC, 'whole'] });
    const out = await run({ lane: 'letter', prompt: 'p', sdk, onRetry: (i) => retries.push(i) });
    ok('truncated then whole: the primary answers on its second try, with NO pause (it is not an overload)', out.r && out.r.model === P && out.r.text === 'whole' && sdk.calls.length === 2 && retries.length === 1 && retries[0].kind === 'truncated' && retries[0].nextModel === P && retries[0].waitMs === 0, { out, retries });
    const sdk2 = fakeSdk({ [P]: [TRUNC, TRUNC], [F1]: ['from lite'] });
    const out2 = await run({ lane: 'letter', prompt: 'p', sdk: sdk2 });
    ok('truncated twice → the next model', out2.r && out2.r.model === F1 && JSON.stringify(modelsOf(sdk2)) === JSON.stringify([P, P, F1]), modelsOf(sdk2));
    const sdk3 = fakeSdk({ [P]: [E503(), E503()], [F1]: [TRUNC, 'lite, second try'] });
    const out3 = await run({ lane: 'letter', prompt: 'p', sdk: sdk3 });
    ok('a FALLBACK\'s truncation gets its one retry too', out3.r && out3.r.model === F1 && out3.r.text === 'lite, second try' && modelsOf(sdk3).filter((m) => m === F1).length === 2, modelsOf(sdk3));
    const sdk4 = fakeSdk({ [P]: [TRUNC, TRUNC], [F1]: [TRUNC, TRUNC], [F2]: [TRUNC, TRUNC] });
    const out4 = await run({ lane: 'letter', prompt: 'p', sdk: sdk4 });
    ok('truncated everywhere: kind "other" whose message is EXACTLY "TRUNCATED_OUTPUT" (as the lanes throw today), 6 calls, not busy',
      out4.e instanceof AiUnavailableError && out4.e.kind === 'other' && out4.e.message === 'TRUNCATED_OUTPUT' && sdk4.calls.length === 6 && !isAiBusy(out4.e), out4.e && { kind: out4.e.kind, msg: out4.e.message, n: sdk4.calls.length });
  }

  print('── AI_TEXT_FALLBACK_MODELS ──');
  {
    const withEnv = (v, fn) => { if (v === undefined) delete process.env.AI_TEXT_FALLBACK_MODELS; else process.env.AI_TEXT_FALLBACK_MODELS = v; try { return fn(); } finally { delete process.env.AI_TEXT_FALLBACK_MODELS; } };
    const J = (x) => JSON.stringify(x);
    ok('spaces trimmed, duplicates and empty entries dropped, order kept', withEnv(' gemini-2.5-flash-lite , gemini-2.5-flash-lite,, gemini-3.1-flash-lite ', () => J(fallbackModels())) === J([F1, F2]));
    ok('unset, empty, blank and all-commas → the verified default', [undefined, '', '   ', ' , ,, '].every((v) => withEnv(v, () => J(fallbackModels())) === J([F1, F2])));
    ok('the primary listed again: fallbackModels returns it, but the chain never tries it twice', withEnv('gemini-2.5-flash, gemini-2.5-flash-lite', () => J(fallbackModels()) === J([P, F1]) && J(chainFor('letter')) === J([P, F1])));
    ok('"models/" and capitals are normalised: " models/Gemini-2.5-Flash-Lite " → gemini-2.5-flash-lite', withEnv(' models/Gemini-2.5-Flash-Lite ', () => J(fallbackModels())) === J([F1]));
    ok('junk ids are ignored (spaces inside, symbols, > 48 chars — the stored model column is VARCHAR(48)); nothing usable → the default',
      withEnv('gemini 2.5, $$$, ' + 'g'.repeat(49), () => J(fallbackModels())) === J([F1, F2]) && withEnv('gemini-x, ' + 'g'.repeat(49), () => J(fallbackModels())) === J(['gemini-x']));
    ok('"none" / "off" → no fallback at all: the chain is the primary alone', withEnv('none', () => J(fallbackModels()) === '[]' && J(chainFor('letter')) === J([P])) && withEnv(' OFF ', () => J(fallbackModels())) === '[]');
    ok('a fresh array every time: editing one cannot change the default', (() => { try { const a = fallbackModels(); a.push('evil'); a[0] = 'x'; return J(fallbackModels()) === J([F1, F2]); } catch { return false; } })());

    process.env.AI_TEXT_FALLBACK_MODELS = 'gemini-3.1-flash-lite';
    const sdk = fakeSdk({ [P]: [E503(), E503()] });
    const out = await run({ lane: 'letter', prompt: 'p', sdk });
    process.env.AI_TEXT_FALLBACK_MODELS = 'none';
    const sdk2 = fakeSdk({ [P]: [E503(), E503()] });
    const out2 = await run({ lane: 'letter', prompt: 'p', sdk: sdk2 });
    delete process.env.AI_TEXT_FALLBACK_MODELS;
    ok('read at CALL time: the env chain is the one walked (primary ×2 → gemini-3.1-flash-lite)', out.r && out.r.model === F2 && JSON.stringify(modelsOf(sdk)) === JSON.stringify([P, P, F2]), modelsOf(sdk));
    ok('"none": two primary tries, then busy', out2.e && isAiBusy(out2.e) && sdk2.calls.length === 2, modelsOf(sdk2));
    const sdk3 = fakeSdk({ 'model-a': [E503('model-a'), E503('model-a')] });
    const out3 = await run({ lane: 'letter', prompt: 'p', sdk: sdk3, models: [' Model-A ', 'model-a', 'model-b'] });
    ok('an explicit `models` list IS the chain (cleaned, deduped): model-a ×2 → model-b', out3.r && out3.r.model === 'model-b' && out3.r.fellBack === true && JSON.stringify(modelsOf(sdk3)) === JSON.stringify(['model-a', 'model-a', 'model-b']), modelsOf(sdk3));
  }

  print('── the config and the prompt reach EVERY model unchanged ──');
  {
    const config = { temperature: 0.7, maxOutputTokens: 32768, responseMimeType: 'application/json', responseSchema: { type: 'object', properties: { cover_letter: { type: 'string' } }, required: ['cover_letter'] }, thinkingConfig: { thinkingBudget: 1024 } };
    const snap = JSON.stringify(config);
    const prompt = { contents: [{ role: 'user', parts: [{ text: 'Write to Amazon' }] }], tools: [{ googleSearch: {} }] };
    const sdk = fakeSdk({ [P]: [E503(), E503()], [F1]: [E400(F1)], [F2]: ['{"cover_letter":"x"}'] });
    const out = await run({ lane: 'letter', prompt, config, sdk });
    ok('a 400 on a fallback (it refused the request) moves on at once: flash-lite called ONCE, then 3.1-flash-lite answers', out.r && out.r.model === F2 && JSON.stringify(modelsOf(sdk)) === JSON.stringify([P, P, F1, F2]), modelsOf(sdk));
    ok('every model got the same generationConfig — temperature, maxOutputTokens, responseMimeType, responseSchema, thinkingConfig — and the caller\'s object is not mutated',
      sdk.calls.length === 4 && sdk.calls.every((c) => JSON.stringify(c.cfg) === snap) && JSON.stringify(config) === snap, sdk.calls.map((c) => c.cfg));
    ok('the prompt is passed through untouched: the SAME request object (contents + tools) to every model', sdk.calls.every((c) => c.prompt === prompt));
    const sdk2 = fakeSdk({ [P]: [E503()] });
    await run({ lane: 'letter', prompt: 'plain string', config: { temperature: 0.55 }, sdk: sdk2 });
    ok('a string prompt stays that string, and the lane temperature (0.55) reaches the retry too', sdk2.calls.length === 2 && sdk2.calls.every((c) => c.prompt === 'plain string' && c.cfg.temperature === 0.55), sdk2.calls.map((c) => [c.prompt, c.cfg]));
    ok('every call carries an AbortSignal (the per-attempt cap can cancel it)', sdk.calls.every((c) => c.opts && c.opts.signal && typeof c.opts.signal.addEventListener === 'function'));
  }

  print('── onRetry cannot break a build ──');
  {
    const mark = logs.length;
    const out = await run({ lane: 'letter', prompt: 'p', sdk: fakeSdk({ [P]: [E503(), E503()] }), onRetry: () => { throw new Error('reporter down'); } });
    ok('a THROWING onRetry: the build still answers (from the fallback), and the throw is logged, not raised', out.r && out.r.model === F1 && logsSince(mark).some((l) => /onRetry threw, ignored: reporter down/.test(l)), { out, l: logsSince(mark) });
    const out2 = await run({ lane: 'letter', prompt: 'p', sdk: fakeSdk({ [P]: [E503()] }), onRetry: async () => { throw new Error('async reporter down'); } });
    ok('a REJECTING async onRetry: the build still answers', out2.r && out2.r.model === P, out2);
    const order = [];
    const sdk3 = fakeSdk({ [P]: [E503(), E503()] });
    const out3 = await run({ lane: 'letter', prompt: 'p', sdk: sdk3, onRetry: async (i) => { order.push('report ' + i.nextModel); await sleep(15); order.push('reported'); } });
    ok('an async onRetry is AWAITED: each report lands before the next call starts', out3.r && order.join('|') === `report ${P}|reported|report ${F1}|reported` && gap(sdk3, 1, 2) >= 13, { order, gap: gap(sdk3, 1, 2) });
  }

  print('── the SDK is required on EVERY call (the per-suite stubs and test-employer-docs\' mid-run swap) ──');
  {
    const genaiPath = require.resolve('@google/generative-ai', { paths: [ROOT] });
    const saved = require.cache[genaiPath];
    const A = fakeSdk({ [P]: ['from A'] }), B = fakeSdk({ [P]: ['from B'] });
    require.cache[genaiPath] = { id: genaiPath, filename: genaiPath, loaded: true, exports: { GoogleGenerativeAI: A } };
    const a = await run({ lane: 'letter', prompt: 'p' });
    require.cache[genaiPath] = { id: genaiPath, filename: genaiPath, loaded: true, exports: { GoogleGenerativeAI: B } };
    const b = await run({ lane: 'letter', prompt: 'p' });
    if (saved) require.cache[genaiPath] = saved; else delete require.cache[genaiPath];
    ok('with no `sdk`, the require.cache copy in place AT THE CALL is used — swapped between calls, the second call sees the new one',
      a.r && a.r.text === 'from A' && b.r && b.r.text === 'from B' && A.calls.length === 1 && B.calls.length === 1, { a, b });
  }

  print('── hygiene ──');
  {
    const timers = () => (typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length : 0);
    await sleep(20);
    const before = timers();
    const r1 = await generateText({ lane: 'letter', prompt: 'p', sdk: fakeSdk({}) });            // default 60 s cap
    const r2 = await generateText({ lane: 'letter', prompt: 'p', sdk: fakeSdk({ [P]: [E503()] }) }).catch((e) => e);
    ok('a settled call leaves NO timer behind (the 60 s cap is cleared, not left to run out)', r1.text && r2.text && timers() === before, { before, after: timers() });
    await sleep(30);
    ok('no unhandled rejection anywhere (abandoned capped calls, rejecting onRetry)', unhandled === 0, unhandled);
  }

  console.log = print;
  print(`\nai text: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { print('TEST ERROR:', e); process.exit(2); });
