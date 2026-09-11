// Minimize-resilient async-job wrapper.
//
// Wrap any JSON-returning route handler so it can run as a DB-backed background job:
//   router.post('/x', authenticateToken, asJob('x_type')(handler))
//
// It is OPT-IN and BACKWARD COMPATIBLE: the request runs SYNCHRONOUSLY (handler → res.json)
// exactly as before, UNLESS the client sends `__async: true` in the body. When it does:
//   1. a job row is created (jobService.createJob) and we respond 202 { jobId } immediately,
//      so the HTTP socket is freed and the mobile app can be backgrounded/minimised safely;
//   2. the original handler then runs against a CAPTURING res — whatever it would have sent
//      via res.json(...) is stored on the job instead (completeJob on 2xx, failJob on >=400);
//   3. the client polls GET /api/ai-hub/job-status/:jobId (poll loops pause while the app is
//      backgrounded and resume on foreground), then reads the result from `data`.
//
// Because the handler keeps doing `res.status(n).json(obj)` unchanged, this needs ZERO changes
// to handler internals — only the route line and the client call site change.
//
// NOTE: only use this on handlers that respond with res.json (NOT file streams / res.download).

const jobService = require('../services/jobService');
const dbConfig = require('../../db-config');

/**
 * Fail a job AND keep the machine-readable reason the handler gave for refusing.
 *
 * ⚠️ A REFUSAL IS NOT AN ERROR, AND THE CLIENT HAS TO KNOW WHICH ONE IT GOT. In the synchronous lane
 * a 402 { reason: 'quota_exhausted' } reaches the app intact and it opens Plans. Through this wrapper
 * only the message survived, so the same refusal read as "something broke, try again" — and trying
 * again is exactly the loop that ends at the same 402. async_jobs has no reason column, so the reason
 * rides in `result`, which both job-status handlers already return as `data`.
 *
 * ⚠️ ONE UPDATE, NOT updateJobPartialResult THEN failJob. Between two writes a poller would see
 * status 'processing' carrying { reason, error } as its partial data — and pollUntilDone hands any
 * partial data straight to onPartialUpdate as if it were a progress payload. Status and reason must
 * land in the same statement, so nobody can read one without the other.
 */
async function failJobWithReason(jobId, message, reason) {
    await dbConfig.run(
        `UPDATE async_jobs SET status = 'failed', error = $1, result = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
        [message, JSON.stringify({ reason, error: message }), jobId]
    );
}

// A minimal res stand-in that records what the handler tries to send and folds it into the job.
function makeCapturingRes(jobId) {
    let statusCode = 200;
    let done = false;
    const settle = (body) => {
        if (done) return;
        done = true;
        if (statusCode >= 400) {
            const msg = (body && (body.error || body.message)) || `Request failed (${statusCode})`;
            const reason = body && typeof body.reason === 'string' && body.reason ? body.reason.slice(0, 64) : null;
            // A handler that gives no reason keeps the old write exactly — its last progress tick stays in `data`.
            if (reason) failJobWithReason(jobId, String(msg), reason).catch(() => jobService.failJob(jobId, String(msg)).catch(() => {}));
            else jobService.failJob(jobId, String(msg)).catch(() => {});
        } else {
            jobService.completeJob(jobId, body == null ? {} : body).catch(() => {});
        }
    };
    const res = {
        status(code) { statusCode = code; return res; },
        // header/content-type no-ops so handlers that set them don't crash
        set() { return res; },
        header() { return res; },
        setHeader() { return res; },
        type() { return res; },
        json(body) { settle(body); return res; },
        send(body) { settle(typeof body === 'string' ? { message: body } : body); return res; },
        end() { settle({}); return res; },
        // called by the wrapper if the handler returns without ever responding
        __finalizeIfNeeded() { if (!done) settle({}); },
        // called by the wrapper's catch — only fails the job if the handler hasn't
        // already settled it (so a respond-then-throw can't clobber a completed job).
        __failIfNeeded(msg) { if (done) return; statusCode = 500; settle({ error: msg }); },
    };
    return res;
}

// ── Idempotency: one clientBuildId, one job ─────────────────────────────────────────────────────────
//
// ⚠️ A LOST 202 IS A SECOND CHARGE WITHOUT THIS. The job starts the moment the 202 is written; if the
// response never reaches the phone (a tunnel, a dropped socket, a timeout the server did not see) the
// app retries — and every retry was a brand-new job that ran the AI and consumed quota again. So a body
// carrying `clientBuildId` is deduped per (type, user, clientBuildId) for 15 minutes: a repeat gets the
// SAME { jobId } and the handler never runs again. `type` is in the key so an id reused across two
// endpoints can never hand one endpoint the other's job.
//
// TWO LAYERS, because each misses what the other catches:
//   1. in memory — claimed SYNCHRONOUSLY before the first await, so two copies of one request racing
//      into this process join a single job instead of both passing a DB lookup that is still empty;
//   2. async_jobs — createJob stores the sanitised body as `input` (JSONB), and sanitizeInput keeps a
//      short clientBuildId, so `input->>'clientBuildId'` finds the job after a server RESTART between
//      the lost 202 and the retry, when the map is empty.
// Only an unreadable async_jobs falls back to memory alone — that is the one restart gap left.
// Only the async lane (__async: true) dedupes — the synchronous lane has no job id to hand back.
// ⚠️ A deduped job may be one a restart killed mid-run (jobs have no worker; requeueStuckJobs fails
// them only at the NEXT boot). It is still returned rather than re-run: during a deploy overlap the old
// process can still be running it, and running it twice is exactly the double charge this prevents.
const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;
const IDEMPOTENCY_MAX_KEYS = 5000;
const recentJobs = new Map();   // key → { at, jobIdPromise: Promise<string|null> }

function clientBuildIdOf(body) {
    const v = body && body.clientBuildId;
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t && t.length <= 128 ? t : null;
}

function pruneRecentJobs(now) {
    for (const [k, v] of recentJobs) {
        if (now - v.at >= IDEMPOTENCY_TTL_MS || recentJobs.size > IDEMPOTENCY_MAX_KEYS) recentJobs.delete(k);
        else break;               // Map iterates in insertion order: the rest are newer
    }
}

async function findDurableJob(userId, type, clientBuildId) {
    const row = await dbConfig.get(
        `SELECT id FROM async_jobs
          WHERE user_id = $1 AND type = $2 AND input->>'clientBuildId' = $3
            AND created_at > NOW() - INTERVAL '15 minutes'
          ORDER BY created_at DESC LIMIT 1`,
        [userId, type, clientBuildId]
    );
    return row ? row.id : null;
}

// Strip giant / noisy fields before persisting the input snapshot on the job row.
function sanitizeInput(body) {
    if (!body || typeof body !== 'object') return {};
    const clone = { ...body };
    // Avoid storing very large blobs (base64, full HTML) twice — they're not needed for replay.
    for (const k of Object.keys(clone)) {
        const v = clone[k];
        if (typeof v === 'string' && v.length > 2000) clone[k] = `[${v.length} chars omitted]`;
    }
    delete clone.__async;
    return clone;
}

function asJob(type) {
    return function wrap(handler) {
        return async function asJobHandler(req, res, next) {
            const wantAsync = !!(req.body && req.body.__async === true);
            if (!wantAsync) {
                // Backward-compatible: behave exactly like the original route.
                return handler(req, res, next);
            }

            const userId = req.user && req.user.id;
            if (!userId) return res.status(401).json({ error: 'Unauthorized' });

            // Idempotency (see the block above asJob). Claim the key BEFORE any await.
            const buildId = clientBuildIdOf(req.body);
            const idemKey = buildId ? `${type}|${userId}|${buildId}` : null;
            let settleClaim = null;
            if (idemKey) {
                const now = Date.now();
                pruneRecentJobs(now);
                const prior = recentJobs.get(idemKey);
                if (prior && now - prior.at < IDEMPOTENCY_TTL_MS) {
                    const priorId = await prior.jobIdPromise;
                    if (priorId) {
                        console.log(`[asJob:${type}] clientBuildId repeat for user ${userId} — same job ${priorId}, not re-run`);
                        return res.status(202).json({ jobId: priorId, status: 'pending', deduped: true });
                    }
                    // The first copy never got a job row (it ran synchronously); nothing to join.
                }
                let resolveClaim;
                recentJobs.delete(idemKey);   // re-insert at the END: pruneRecentJobs relies on insertion order
                recentJobs.set(idemKey, { at: now, jobIdPromise: new Promise((r) => { resolveClaim = r; }) });
                settleClaim = (id) => { resolveClaim(id); if (!id) recentJobs.delete(idemKey); };
                try {
                    const durableId = await findDurableJob(userId, type, buildId);
                    if (durableId) {
                        settleClaim(durableId);
                        console.log(`[asJob:${type}] clientBuildId repeat for user ${userId} — job ${durableId} found in async_jobs, not re-run`);
                        return res.status(202).json({ jobId: durableId, status: 'pending', deduped: true });
                    }
                } catch (e) {
                    console.warn(`[asJob:${type}] durable idempotency lookup failed (memory only this time):`, e.message);
                }
            }

            let jobId;
            try {
                jobId = await jobService.createJob(userId, type, sanitizeInput(req.body));
            } catch (e) {
                // If we can't create a job row, fall back to running synchronously so the
                // feature still works (just without background-resilience this once).
                if (settleClaim) settleClaim(null);
                console.warn(`[asJob:${type}] createJob failed, running sync:`, e.message);
                return handler(req, res, next);
            }
            if (settleClaim) settleClaim(jobId);

            // Free the socket immediately.
            res.status(202).json({ jobId, status: 'pending' });

            // ⚠️ THE HANDLER HAS TO BE ABLE TO SAY WHERE IT HAS GOT TO.
            // Without this the wrapper is progress-blind: `progress` sits at 0 from createJob until
            // completeJob slams it to 100, so a minute-long AI call looks identical to a hung one,
            // and requeueStuckJobs (which fails any 'processing' row untouched for five minutes)
            // kills a run that was merely slow. A handler that finds req.__jobId can report real
            // stages; one that ignores it behaves exactly as before.
            req.__jobId = jobId;

            // Run the real work detached from the request.
            (async () => {
                const cap = makeCapturingRes(jobId);
                try {
                    await jobService.startJob(jobId);
                    await handler(req, cap, next);
                    cap.__finalizeIfNeeded();
                } catch (err) {
                    // Won't clobber a job the handler already completed (guarded by `done`).
                    cap.__failIfNeeded((err && err.message) || 'Job failed');
                }
            })();
        };
    };
}

module.exports = { asJob };
