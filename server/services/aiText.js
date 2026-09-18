// One way to ask Gemini for text that survives a busy model. Every paid lane's AI call goes through here.
//
// ⚠️ WHY THIS EXISTS — 2026-09-18. User 1 built a cover letter for Amazon from Home → Cover letters and the app
// said "That cover letter didn't finish". Production logged:
//
//     [employerLetter] letter attempt 1/2 for "Amazon" failed: ... gemini-2.5-flash:generateContent:
//         [503 Service Unavailable] This model is currently experiencing high demand.
//     [employerLetter] letter attempt 2/2 for "Amazon" failed: (the same 503)
//
// The letter lane retried TWICE, BACK TO BACK, on the SAME model, so a demand spike that lasted longer than one
// round trip beat it every time. Both résumé lanes did the same (three tries, zero delay, one model). Nobody was
// charged (the AI runs before the charge in every lane), but the user got nothing and was told nothing useful.
//
// What the orchestrator measured against the production key that day, with the letter lane's real config
// (responseSchema, 32768 tokens, temperature 0.7):
//   gemini-2.5-flash        OK 7.5 s / 12.3 s   the primary, and the model that 503'd
//   gemini-2.5-flash-lite   OK 2.3 s / 2.4 s    valid JSON
//   gemini-3.1-flash-lite   OK 8.8 s / 2.2 s    valid JSON
//   gemini-2.5-pro          404                 LISTED by the models API, NOT callable on this key
//   gemini-flash-latest     OK after 257 SECONDS for a one-word answer: a model can fail by HANGING, not only by 503
// Hence the three rules this module is built on: listed ≠ callable (a 404 is skipped, never fatal while another
// model remains); every attempt has a REAL cap (an abort through the SDK's signal, not just "stop waiting"); and
// the whole chain runs on ONE budget, which the caller sets from its own build deadline (the app gives a build
// 6 minutes, so per-model caps must never simply add up).
//
// THE POLICY. The decisions are deterministic; only the length of the ~2 s wait is jittered.
//   transient on the PRIMARY  → wait ~2 s, try the primary once more; transient again → the next model.
//   transient on a FALLBACK   → the next model at once. A fallback that is also busy is not worth a wait.
//   gone (404)                → skip that model. Never fatal while another model remains.
//   quota / auth              → FAIL FAST. Every model shares the key, so a second model is wasted time; and page
//                               the operator through aiHealth (throttled there).
//   TRUNCATED_OUTPUT          → one more try on the same model, then the next model.
//   anything else the SDK throws (a 400, a blocked candidate) → the next model at once.
// Output the CALLER rejects (bad JSON, too short, placeholders) is NOT this module's business: it only sees what
// the SDK throws plus a MAX_TOKENS finish. The lanes keep their own validation loops on top of this one.
//
// ⚠️ MONEY. The model that answered is RETURNED (`model`) so a lane can store who actually wrote the document, in
// the place it already stores a model id. It must NEVER enter an input fingerprint: a letter a fallback wrote has
// to be a free cache hit next time, exactly like one the primary wrote. Every attempt here happens BEFORE any
// lane's charge, and a failure here charges nothing and stores nothing.
//
// ⚠️ THE SDK IS REQUIRED ON EVERY CALL, never at load. test-employer-docs swaps the require.cache entry for
// '@google/generative-ai' in the middle of a run, and each lane's suite injects its own fake the same way; a
// module-level require would bind the first copy forever and walk straight past those stubs.
'use strict';

const aiHealth = require('./aiHealth');

/** The RESEARCH lanes' primary, and the head of the default chain for any caller that names no models. The paid DOCUMENT
 *  lanes do not use it since 2026-09-18 — they walk writing() (see WRITING_PRIMARY). */
const DEFAULT_PRIMARY = 'gemini-2.5-flash';
/**
 * The RESEARCH / default fallback chain (2026-09-18, production key, letter config). Change it only after proving each id is
 * CALLABLE with the lanes' real config: the models API lists ids this key cannot call (gemini-2.5-pro → 404).
 * gemini-3-flash-preview answered too (12.2 s / 32.2 s) but it is a preview model, so nothing depends on it.
 */
const DEFAULT_FALLBACKS = Object.freeze(['gemini-2.5-flash-lite', 'gemini-3.1-flash-lite']);

// ── The DOCUMENT-WRITING chain (letters and résumés — the paid lanes) ─────────────────────────────
// ⚠️ CHOSEN BY MEASUREMENT, NOT BY NEWNESS (2026-09-18). The owner's rule: cost first, as long as the result is the
// same. Each candidate wrote the EXACT production prompts (the Home Amazon letter; an Infosys résumé under the India
// playbook) three times; anonymised outputs were scored blind by six judges plus two fact auditors, and cost per
// document was measured from real token counts (thinking included — Google bills it as output) at the official prices.
//
//   model                          letter  India résumé  $/letter  $/résumé  answered
//   gemini-3.1-flash-lite            7.7        6.8        0.0012    0.0040     6/6   ← best or tied-best on BOTH
//   gemini-2.5-flash, thinking OFF   7.7        5.2        0.0016    0.0077     6/6
//   gemini-2.5-flash (the old primary) 5.7      4.7        0.0053    0.0142     6/6   ← thinking cost 3x and INVENTED more
//   gemini-2.5-flash-lite            5.3        3.2        0.0004    0.0014     6/6   ← cheapest, but thin: 2 bullets a role
//   gemini-3-flash-preview           6.3        4.3        0.0148    0.0132     5/6
//   gemini-3.8 / 3.7 / 3.6 / 3.5-flash — 0/6, 0/6, 1/6, 0/6 answered that day (503 "high demand", 150 s hangs), and
//     3.6–3.8 cost $0.75/$3.75 per 1M only until 2026-12-31 ($1.50/$7.50 after); 3.5-flash is $1.50/$9.00.
//
// So: the flash-lite that writes as well as anything for a quarter of the old price leads; 2.5-flash WITH THINKING OFF
// (a different model family, so a different capacity pool, and judged better than with thinking) backs it up; the
// cheapest model is the last resort — a thinner document beats "Google's AI is busy". Research lanes are NOT on this
// chain (they use Google Search grounding, which this evaluation did not cover) and keep their own models.
// ⚠️ gemini-3.1-flash-lite's EARLIEST SHUTDOWN is 2027-05-07 (Google names gemini-3.5-flash-lite as its successor, which
// scored 4.3 / 4.3 here — re-measure before switching). A shut-down primary is a 404: skipped, paged once, and every
// build lands on the backup — nothing fails. AI_WRITING_MODEL / AI_WRITING_FALLBACK_MODELS change it without a deploy.
const WRITING_PRIMARY = 'gemini-3.1-flash-lite';
const WRITING_FALLBACKS = Object.freeze(['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
/** Per-model generationConfig for the writing chain, laid over the lane's own config for that model only. */
const WRITING_MODEL_CONFIG = Object.freeze({
    // Thinking tokens are billed as output: 1,450 of them per letter tripled its cost and the judges scored the letters
    // LOWER (more invented detail). Off, the same model wrote the best-fidelity letters of the evaluation.
    'gemini-2.5-flash': Object.freeze({ thinkingConfig: Object.freeze({ thinkingBudget: 0 }) }),
});

/** The whole chain's wall budget when the caller names none. A lane passes what its own deadline has left. */
const DEFAULT_BUDGET_MS = 180 * 1000;
/**
 * Per-attempt caps: the very first try gets 60 s (the primary answered the letter in 7.5–12.3 s, and a résumé is
 * bigger), every later try 40 s (the fallbacks answered in 2–9 s). 60 + 2 + 40 + 40 + 40 is 182 s, so on the
 * default budget the LAST attempt is shortened to what is left rather than started on a cap it cannot keep.
 */
const DEFAULT_CAPS_MS = Object.freeze([60 * 1000, 40 * 1000]);

/**
 * Timing knobs, read at call time. Tests shrink them (a real 2 s wait per case would make the suite slow); nothing
 * in production writes them.
 *   retryWaitMs    the pause before the primary's second try: a spike is usually over in a second or two.
 *   retryJitterMs  up to this much is ADDED to the pause, so a burst of builds that failed together does not
 *                  retry together. Decisions use the LONGEST possible wait, so jitter never changes a decision.
 *   minAttemptMs   never start an attempt with less time than this left (or than its own cap, when that is
 *                  smaller). 8 s is enough for a flash-lite letter (2.3 s) and most primary answers (7.5 s).
 */
const settings = {
    retryWaitMs: 2000,
    retryJitterMs: 800,
    minAttemptMs: 8000,
};

// ── The chain ───────────────────────────────────────────────────────────────────────────────────

// ⚠️ ≤ 48 chars: user_employer_documents.model is VARCHAR(48), and the id a lane stores comes from here. An id
// longer than that would be cut in the stored row, so it is refused before it is ever called.
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;

/** " models/Gemini-2.5-Flash-Lite " → "gemini-2.5-flash-lite"; anything that is not a plausible id → null. */
function cleanModelId(v) {
    if (typeof v !== 'string') return null;
    const id = v.trim().toLowerCase().replace(/^models\//, '');
    return MODEL_ID_RE.test(id) ? id : null;
}

const dedupe = (list) => [...new Set(list)];

/** The default chain's first choice (the research lanes'). Document lanes pass their own chain — writing(). */
function primaryFor(/* lane */) {
    return DEFAULT_PRIMARY;
}

/**
 * The fallback models, in order: env AI_TEXT_FALLBACK_MODELS (a comma list; trimmed, lower-cased, "models/"
 * dropped, deduped, junk ids ignored) or the verified default when the variable is unset or names nothing usable.
 * "none" / "off" means NO fallback at all: the operator's switch back to "primary only", without a code change.
 * Read at call time, and always a fresh array, so no caller can edit the default in place.
 */
function fallbackModels() {
    const raw = process.env.AI_TEXT_FALLBACK_MODELS;
    if (typeof raw !== 'string' || !raw.trim()) return [...DEFAULT_FALLBACKS];
    if (/^\s*(none|off)\s*$/i.test(raw)) return [];
    const list = dedupe(raw.split(',').map(cleanModelId).filter(Boolean));
    return list.length ? list : [...DEFAULT_FALLBACKS];
}

/** A comma list of model ids from the environment: null when unset or empty, [] for "none" / "off", else the usable ids. */
function envModelList(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    if (/^\s*(none|off)\s*$/i.test(raw)) return [];
    const list = dedupe(raw.split(',').map(cleanModelId).filter(Boolean));
    return list.length ? list : null;
}

/**
 * The chain every paid DOCUMENT lane walks (see WRITING_PRIMARY): env AI_WRITING_MODEL for the primary and
 * AI_WRITING_FALLBACK_MODELS for the backups ("none" = primary only), else the measured default. A fresh array.
 */
function writingChain() {
    // "none" / "off" is a valid-looking id that would be CALLED (and 404) — there is no "no primary", so it means default.
    const envPrimary = /^\s*(none|off)\s*$/i.test(String(process.env.AI_WRITING_MODEL || '')) ? null : cleanModelId(process.env.AI_WRITING_MODEL);
    const primary = envPrimary || WRITING_PRIMARY;
    const fromEnv = envModelList(process.env.AI_WRITING_FALLBACK_MODELS);
    return dedupe([primary, ...(fromEnv === null ? WRITING_FALLBACKS : fromEnv)]);
}

/** What a document lane spreads into generateText: `{ models, modelConfig }` — the chain and its per-model config. */
function writing() {
    return { models: writingChain(), modelConfig: WRITING_MODEL_CONFIG };
}

/**
 * The ordered list one call walks. `models` from the caller wins outright (cleaned and deduped); otherwise the
 * lane's primary followed by fallbackModels(), with the primary never tried a second time as a "fallback" when the
 * env list names it again.
 */
function chainFor(lane, models) {
    const given = Array.isArray(models) ? dedupe(models.map(cleanModelId).filter(Boolean)) : [];
    if (given.length) return given;
    return dedupe([primaryFor(lane), ...fallbackModels()]);
}

/**
 * The cap for the attempt at `index` (0 = the very first try of the call). `caps` is a number (every attempt), an
 * array ([first, later], the last entry repeating) or { first, later }; anything unusable falls back to the default.
 */
function capFor(caps, index) {
    let list = DEFAULT_CAPS_MS;
    if (typeof caps === 'number') list = [caps];
    else if (Array.isArray(caps) && caps.length) list = caps;
    else if (caps && typeof caps === 'object') list = [caps.first, caps.later];
    const v = Number(list[Math.min(index, list.length - 1)]);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_CAPS_MS[Math.min(index, 1)];
}

/** The least time worth starting an attempt with: an attempt capped below this could not have answered anyway. */
const floorFor = (cap) => Math.min(settings.minAttemptMs, cap);

/** The pause before the primary's second try: retryWaitMs plus 0…retryJitterMs. `rand` is injectable for tests. */
function retryWaitFor(rand = Math.random) {
    return settings.retryWaitMs + Math.floor(rand() * (settings.retryJitterMs + 1));
}
/** The longest retryWaitFor can answer, which is what every "does it still fit?" decision uses. */
const longestWait = () => settings.retryWaitMs + settings.retryJitterMs;

// ── What a failure means ────────────────────────────────────────────────────────────────────────

/**
 * 'transient' | 'gone' | 'quota' | 'auth' | 'truncated' | 'other'.
 *
 * aiHealth.classifyAiError is the house's one reading of a Gemini failure, and it decides every case below that the
 * SDK did not already settle with a status. Three things come first on purpose:
 *   - TRUNCATED_OUTPUT is ours (a MAX_TOKENS finish): aiHealth calls it 'other', but it earns a same-model retry.
 *   - AI_TIMEOUT is ours too (the per-attempt cap), and so is the SDK's "Request aborted" that the cap's abort
 *     causes: a hang is a transient failure like a 503.
 *   - The SDK's fetch errors carry the HTTP status as a NUMBER (GoogleGenerativeAIFetchError.status), and that is
 *     trusted over the text. ⚠️ aiHealth's AUTH_RE matches a bare, unanchored 401|403, so a 503 whose message merely
 *     contained "403" somewhere (an id, a count) would read as 'auth' and stop the whole chain. With a status in
 *     hand, a 503 is a 503.
 * A status of 400 is NOT mapped: Google answers a bad key as "400 API key not valid [API_KEY_INVALID]" and a bad
 * request as 400 too, and only the text tells them apart.
 */
// ⚠️ A 429 IS NOT ONE THING. Google meters requests PER MODEL, so under exactly the demand spike this module exists
// for, gemini-2.5-flash-lite can answer 429 "Resource has been exhausted" while gemini-3.1-flash-lite still has
// room. Only the message that says the KEY's credit is gone (the 2026-08-14 outage: "Your prepayment credits are
// depleted") is key-wide. Reading every 429 as that failed a build that one more model would have finished, told the
// user "our AI provider is unavailable" with no retry, and paged the operator to top up credits that were fine.
const DEPLETED_RE = /prepayment credits|credits (are|have been) (depleted|exhausted)|billing (account|is not enabled|has been disabled|disabled)|BILLING_DISABLED/i;

/**
 * 'quota' — the KEY is out of credit (fail fast: every model shares it); 'rate' — one model's rate limit (try the
 * next one); 'auth'; 'gone'; 'transient'; 'truncated'; 'other'.
 */
function classify(err) {
    const msg = String((err && err.message) || err || '');
    if (msg === 'TRUNCATED_OUTPUT') return 'truncated';
    if (msg === 'AI_TIMEOUT' || /^Request aborted\b/i.test(msg)) return 'transient';
    const status = err && typeof err === 'object' ? Number(err.status) : NaN;
    if (status === 429) return DEPLETED_RE.test(msg) ? 'quota' : 'rate';
    if (status === 401 || status === 403) return 'auth';
    if (status === 404) return 'gone';
    if (status === 408 || status === 500 || status === 502 || status === 503 || status === 504) return 'transient';
    const kind = aiHealth.classifyAiError(err);
    // aiHealth's quota pattern is deliberately broad (it pages); here a status-less quota message that does not say
    // the credit is gone is one model's limit too.
    if (kind === 'quota' && !DEPLETED_RE.test(msg)) return 'rate';
    return kind;
}

/**
 * The failure a caller sees when no model could answer.
 *   kind 'busy'   every model was busy, hung, or out of time: a provider overload. retryable.
 *   kind 'quota'  the key is out of credit or over its limit. The operator must act. NOT retryable.
 *   kind 'auth'   the key is missing, wrong or revoked. The operator must act. NOT retryable.
 *   kind 'other'  not an outage (every model truncated, or refused the request, or is gone). Its MESSAGE IS THE
 *                 LAST FAILURE'S OWN MESSAGE, so a lane's existing checks (e.message === 'TRUNCATED_OUTPUT', its
 *                 /timeout/ test) keep working and the lane answers it in today's shape.
 * `attempts` lists every call that was made, in order, as { model, kind, ms }.
 */
class AiUnavailableError extends Error {
    constructor(kind, { lane = 'ai', attempts = [], message, cause } = {}) {
        super(message || `AI_UNAVAILABLE (${kind})`);
        this.name = 'AiUnavailableError';
        this.kind = kind;
        this.lane = lane;
        this.attempts = attempts;
        this.retryable = kind !== 'quota' && kind !== 'auth';
        if (cause) this.cause = cause;
    }
}

/** An AiUnavailableError of kind "busy". Read by name as well as by class, so a second copy of this module in the
 *  require cache (a test that reloads it) still answers correctly. */
function isAiBusy(err) {
    return !!err && (err instanceof AiUnavailableError || err.name === 'AiUnavailableError') && err.kind === 'busy';
}

// ── One attempt ─────────────────────────────────────────────────────────────────────────────────

/**
 * One model, one call, one cap → the trimmed text, or a throw.
 *
 * ⚠️ THE CAP IS A REAL ABORT. The old lanes raced generateContent against a timer, which only stopped WAITING: the
 * HTTP request kept running (gemini-flash-latest took 257 s to answer). The SDK accepts { signal } as its request
 * options and aborts the fetch with it, so the same timer that rejects the race also aborts the request. The SDK's
 * own { timeout } option is not used: its timer is never cleared, so every successful call would leave one pending
 * for the full cap. Ours is cleared in finally, and it is NOT unref'd: a call awaited by a script must keep the
 * process alive until it settles.
 */
/**
 * The generationConfig one model is called with: the lane's `config`, with that model's own entry from `modelConfig`
 * laid over it (thinkingConfig merged one level down, so a lane's other thinking settings survive). No entry, no copy
 * worth making: the lane's object goes through untouched, exactly as before per-model config existed.
 */
function configFor(config, modelConfig, model) {
    const extra = modelConfig && typeof modelConfig === 'object' ? modelConfig[model] : null;
    if (!extra || typeof extra !== 'object') return config;
    const base = config && typeof config === 'object' ? config : {};
    const out = { ...base, ...extra };
    if (base.thinkingConfig && extra.thinkingConfig) out.thinkingConfig = { ...base.thinkingConfig, ...extra.thinkingConfig };
    return out;
}

async function attemptOnce({ Sdk, apiKey, model, prompt, config, capMs }) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    const cap = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error('AI_TIMEOUT'));   // first, so the race settles on OUR reason, not the SDK's abort error
            if (controller) controller.abort();
        }, capMs);
    });
    try {
        const call = Promise.resolve().then(() => {
            const params = { model };
            if (config) params.generationConfig = config;
            return new Sdk(apiKey).getGenerativeModel(params)
                .generateContent(prompt, controller ? { signal: controller.signal } : undefined);
        });
        call.catch(() => {});   // an abandoned (capped) call still rejects later; it must not be an unhandled rejection
        const result = await Promise.race([call, cap]);
        const response = result && result.response;
        const cand = response && Array.isArray(response.candidates) ? response.candidates[0] : null;
        // ⚠️ Exactly what the lanes throw today, so their checks keep working: thinking tokens share maxOutputTokens,
        // and a cut-off JSON object is worse than no answer.
        if (cand && cand.finishReason === 'MAX_TOKENS') throw new Error('TRUNCATED_OUTPUT');
        const text = response && typeof response.text === 'function' ? response.text() : '';
        return String(text == null ? '' : text).trim();
    } finally {
        clearTimeout(timer);
    }
}

// ── Logging ─────────────────────────────────────────────────────────────────────────────────────

/** The part of an SDK message worth a log line: the "[GoogleGenerativeAI Error]: Error fetching from <url>:"
 *  prefix is ~130 characters that say nothing the model name does not. The key travels in a header, never here. */
function snippet(err) {
    return String((err && err.message) || err || '')
        .replace(/^\[GoogleGenerativeAI Error\]:\s*/i, '')
        .replace(/^Error fetching from \S+:\s*/i, '')
        .replace(/\s+/g, ' ')
        .slice(0, 160);
}

/** One line per failed attempt: `[aiText] <lane>: <model> <kind> in <ms>ms -> <next action> | <what Google said>`. */
function logStep(lane, model, kind, ms, action, err) {
    console.warn(`[aiText] ${lane}: ${model} ${kind} in ${ms}ms -> ${action} | ${snippet(err)}`);
}

// ── The next move ───────────────────────────────────────────────────────────────────────────────

/**
 * After a failed attempt: where to go next → { index, tries, waitMs, action } or { stop } — decided here, in one
 * place, from the policy at the top of this file. `tries` in the answer is how many calls the NEXT model has
 * already had (the loop counts the coming one itself).
 *   at        { index, tries }: the model that just failed (index into chain) and how many times it has been tried
 *   nextIndex the attempt number that would come next (0-based), which picks its cap
 * Every "does it still fit?" uses the longest possible wait and the next attempt's floor, so a retry is never
 * started that the budget could not let finish, and jitter never changes a decision.
 */
function planNext({ chain, at, kind, nextIndex, caps, deadline, now, rand }) {
    const left = deadline - now;
    const floor = floorFor(capFor(caps, nextIndex));
    const sameAgain = (kind === 'transient' && at.index === 0 && at.tries === 1)
        || (kind === 'truncated' && at.tries === 1);
    if (sameAgain) {
        const wait = kind === 'transient' ? longestWait() : 0;
        if (left - wait >= floor) {
            const waitMs = kind === 'transient' ? retryWaitFor(rand) : 0;
            return { index: at.index, tries: at.tries, waitMs, action: waitMs ? `retrying ${chain[at.index]} in ${waitMs}ms` : `retrying ${chain[at.index]}` };
        }
        // No room for the pause AND another try here: whatever time is left goes to the next model instead, at once.
    }
    if (at.index + 1 >= chain.length) return { stop: sameAgain ? 'budget spent' : 'no model left' };
    if (left < floor) return { stop: 'budget spent' };
    const nextModel = chain[at.index + 1];
    return {
        index: at.index + 1,
        tries: 0,
        waitMs: 0,
        action: kind === 'gone' ? `skipped (gone), falling back to ${nextModel}`
            : kind === 'rate' ? `rate-limited, falling back to ${nextModel}` : `falling back to ${nextModel}`,
    };
}

/** The lane's progress reporter must never be able to break the build it reports on. */
// ⚠️ BOUNDED. The lanes' reporters write the job row; a database that stalls must not stall the build it is
// reporting on — the next attempt's own budget check then sees whatever time the wait actually took.
const TELL_RETRY_CAP_MS = 3000;
async function tellRetry(onRetry, info, lane) {
    if (typeof onRetry !== 'function') return;
    let timer = null;
    try {
        await Promise.race([
            Promise.resolve().then(() => onRetry(info)),
            new Promise((resolve) => {
                timer = setTimeout(() => {
                    console.warn(`[aiText] ${lane}: onRetry still pending after ${TELL_RETRY_CAP_MS}ms, not waiting for it`);
                    resolve();
                }, TELL_RETRY_CAP_MS);
                if (timer && typeof timer.unref === 'function') timer.unref();
            }),
        ]);
    } catch (e) {
        console.warn(`[aiText] ${lane}: onRetry threw, ignored: ${(e && e.message) || e}`);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** The chain ran out (models or time). Busy when overload played ANY part, otherwise the last failure itself. */
function exhausted(lane, attempts, lastErr, why, chain = []) {
    const models = dedupe(attempts.map((a) => a.model));
    // ⚠️ RATE LIMITS ARE BUSY, NOT DOWN. A 429 without the depletion text is a per-minute limit that clears on its own
    // (a key whose credit is gone says so, and failed fast above as 'quota'), so the user is told "try again in a
    // minute" — never "unavailable" with no retry. The operator hears about it only when the limits covered EVERY
    // model of a real chain: one model's 429, a one-model chain, or a chain cut short by the clock is a burst, and
    // paging for it is the false "top up credits" alarm this module exists to stop. The page says what it is.
    if (attempts.length && attempts.every((a) => a.kind === 'rate')) {
        const wholeChain = Array.isArray(chain) && chain.length > 1 && chain.every((m) => models.includes(m));
        if (wholeChain) {
            aiHealth.noteAiFailure(lastErr, `aiText.${lane}`, {
                kind: 'rate',
                title: 'AI models are rate-limited',
                human: `Every Gemini model in the fallback chain (${models.join(', ')}) answered 429 for one build — requests are being refused. `
                    + 'If it persists, check the per-model limits at https://ai.studio/projects (the credit is fine: a depleted key says so and pages separately).',
            });
        } else {
            console.warn(`[aiText] ${lane}: rate-limited on ${models.join(', ')} (${why}) — answered busy, not paged`);
        }
    }
    if (!attempts.length || attempts.some((a) => a.kind === 'transient' || a.kind === 'rate')) {
        return new AiUnavailableError('busy', {
            lane, attempts, cause: lastErr || undefined,
            message: `AI_BUSY: ${lane} got no answer from ${models.join(', ') || 'any model'} (${attempts.length} attempts, ${why})${lastErr ? ` — last: ${snippet(lastErr)}` : ''}`,
        });
    }
    return new AiUnavailableError('other', {
        lane, attempts, cause: lastErr,
        message: (lastErr && lastErr.message) || 'AI_BAD_OUTPUT',
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The call ────────────────────────────────────────────────────────────────────────────────────

/**
 * generateText({ lane, prompt, config, models, budgetMs, attemptCapsMs, onRetry, sdk })
 *   → { text, model, attempts, fellBack }
 *
 *   lane          for the logs ("letter", "resume_doc", "resume_builder", "research", …)
 *   prompt        a string, the SDK's contents array or a full request ({ contents, tools }): passed through untouched
 *   config        the generationConfig, applied to EVERY model exactly as given
 *   models        the ordered chain; default primaryFor(lane) followed by fallbackModels()
 *   budgetMs      the whole call's wall budget (default 180 s); an attempt that cannot finish inside it is not started
 *   attemptCapsMs per-attempt caps (default: the first try 60 s, every later try 40 s); see capFor
 *   onRetry       ({ model, attempt, kind, nextModel, waitMs }) before every retry or fallback: the lane's progress
 *                 hook. Awaited, and anything it throws is ignored. Its time counts against the budget.
 *   sdk           an injected GoogleGenerativeAI class, for tests
 *
 * `text` is response.text().trim(). `model` is the model that ANSWERED: store it where the lane stores a model id,
 * never in a fingerprint. `attempts` is the number of calls made, the answering one included. `fellBack` is true
 * when the answer came from anything but the first model of the chain.
 *
 * Throws AiUnavailableError (see the class). A missing key throws one of kind 'auth' whose message is exactly
 * 'GEMINI_API_KEY not set', which is the message the lanes already test for, before any SDK call is made.
 */
async function generateText({ lane, prompt, config, models, modelConfig, budgetMs, attemptCapsMs, onRetry, sdk } = {}) {
    const laneName = String(lane || 'ai');
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new AiUnavailableError('auth', { lane: laneName, attempts: [], message: 'GEMINI_API_KEY not set' });
    // eslint-disable-next-line global-require
    const Sdk = sdk || require('@google/generative-ai').GoogleGenerativeAI;

    const chain = chainFor(laneName, models);
    const deadline = Date.now() + (Number.isFinite(budgetMs) ? budgetMs : DEFAULT_BUDGET_MS);
    const attempts = [];
    let lastErr = null;
    let at = { index: 0, tries: 0 };

    for (;;) {
        const model = chain[at.index];
        const cap = capFor(attemptCapsMs, attempts.length);
        const left = deadline - Date.now();
        if (left < floorFor(cap)) {
            // Only reached when time ran out AFTER the plan was made (a slow onRetry) or before the first try.
            console.warn(`[aiText] ${laneName}: ${left}ms left, not enough for ${model} -> giving up (budget spent)`);
            throw exhausted(laneName, attempts, lastErr, 'budget spent', chain);
        }
        at = { index: at.index, tries: at.tries + 1 };
        const started = Date.now();
        try {
            const text = await attemptOnce({ Sdk, apiKey, model, prompt, config: configFor(config, modelConfig, model), capMs: Math.min(cap, left) });
            const n = attempts.length + 1;
            if (n > 1) console.log(`[aiText] ${laneName}: answered by ${model} after ${n} attempts`);
            return { text, model, attempts: n, fellBack: at.index > 0 };
        } catch (err) {
            const ms = Date.now() - started;
            const kind = classify(err);
            attempts.push({ model, kind, ms });
            lastErr = err;

            if (kind === 'quota' || kind === 'auth') {
                logStep(laneName, model, kind, ms, `failing fast (${kind}: every model shares the key)`, err);
                aiHealth.noteAiFailure(err, `aiText.${laneName}`);
                throw new AiUnavailableError(kind, {
                    lane: laneName, attempts, cause: err,
                    message: `AI_DOWN (${kind}): ${laneName} — ${model}: ${snippet(err)}`,
                });
            }
            // A gone PRIMARY means every build of this lane now runs on its fallbacks: that pages (once per 6 h,
            // aiHealth's throttle). A gone FALLBACK only costs resilience, and paging for a model we merely skipped
            // would be noise, so it is a loud log line instead.
            if (kind === 'gone') {
                if (at.index === 0) aiHealth.noteAiFailure(err, `aiText.${laneName}`);
                else console.error(`[aiText] ${laneName}: fallback ${model} no longer exists — fix AI_WRITING_FALLBACK_MODELS (document lanes) or AI_TEXT_FALLBACK_MODELS (research)`);
            }

            const next = planNext({ chain, at, kind, nextIndex: attempts.length, caps: attemptCapsMs, deadline, now: Date.now() });
            if (next.stop) {
                logStep(laneName, model, kind, ms, `giving up (${next.stop})`, err);
                throw exhausted(laneName, attempts, err, next.stop, chain);
            }
            logStep(laneName, model, kind, ms, next.action, err);
            await tellRetry(onRetry, { model, attempt: attempts.length, kind, nextModel: chain[next.index], waitMs: next.waitMs }, laneName);
            if (next.waitMs > 0) await sleep(next.waitMs);
            at = { index: next.index, tries: next.tries };
        }
    }
}

module.exports = {
    generateText,
    fallbackModels,
    writing,
    writingChain,
    AiUnavailableError,
    isAiBusy,
    _internals: {
        settings, DEFAULT_PRIMARY, DEFAULT_FALLBACKS, DEFAULT_BUDGET_MS, DEFAULT_CAPS_MS,
        primaryFor, chainFor, cleanModelId, capFor, floorFor, retryWaitFor, classify, planNext, attemptOnce, snippet,
        DEPLETED_RE, TELL_RETRY_CAP_MS, WRITING_PRIMARY, WRITING_FALLBACKS, WRITING_MODEL_CONFIG, configFor, envModelList,
    },
};
