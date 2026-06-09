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

// A minimal res stand-in that records what the handler tries to send and folds it into the job.
function makeCapturingRes(jobId) {
    let statusCode = 200;
    let done = false;
    const settle = (body) => {
        if (done) return;
        done = true;
        if (statusCode >= 400) {
            const msg = (body && (body.error || body.message)) || `Request failed (${statusCode})`;
            jobService.failJob(jobId, String(msg)).catch(() => {});
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

            let jobId;
            try {
                jobId = await jobService.createJob(userId, type, sanitizeInput(req.body));
            } catch (e) {
                // If we can't create a job row, fall back to running synchronously so the
                // feature still works (just without background-resilience this once).
                console.warn(`[asJob:${type}] createJob failed, running sync:`, e.message);
                return handler(req, res, next);
            }

            // Free the socket immediately.
            res.status(202).json({ jobId, status: 'pending' });

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
