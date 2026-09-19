const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const jobService = require('../services/jobService');
// Read through the module at call time (jobService.getJob), never destructured at load: a suite that swaps the
// module's functions must be what the route calls.
const getJob = (jobId, userId) => jobService.getJob(jobId, userId);

/** What a cancelled job's pollers are told — true, because a cancel never lands after the charge (see cancelJob). */
const CANCELLED_LETTER = 'Cancelled — nothing was charged for this letter.';
const CANCELLED_BATCH = 'Cancelled — letters not yet written were not charged.';

// Poll job status
router.get('/job-status/:jobId', authenticateToken, async (req, res) => {
    try {
        const job = await getJob(req.params.jobId, req.user.id);

        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        const response = {
            jobId: job.id,
            status: job.status,
            progress: job.progress,
            createdAt: job.created_at
        };

        // Return partial data during processing too (for progressive streaming)
        if (job.result) {
            response.data = typeof job.result === 'string' ? JSON.parse(job.result) : job.result;
        }

        // ⚠️ A CANCELLED JOB READS AS A FAILED ONE, WITH reason 'cancelled'. Every poller in the field knows exactly
        // two ends — completed and failed — and one that met a third status would poll it until its own deadline.
        if (job.status === 'cancelled') {
            response.status = 'failed';
            response.cancelled = true;
        }

        if (response.status === 'failed') {
            response.error = job.error;
            // Why it failed, when the handler said (asyncJob keeps a 4xx body's `reason` in result):
            // 'quota_exhausted' must open Plans, not a "try again" that ends at the same refusal.
            response.reason = job.status === 'cancelled'
                ? 'cancelled'
                : ((response.data && typeof response.data.reason === 'string') ? response.data.reason : null);
        }

        res.json(response);
    } catch (error) {
        console.error('Error fetching job status:', error);
        res.status(500).json({ error: 'Failed to fetch job status' });
    }
});

// Cancel a letter job the app has given up on (the Letters page's Cancel, the Job Hub's deadline or the user
// leaving the job). See jobService.cancelJob for the rules; the answer says what actually happened:
//   { cancelled: true }                         — stopped before its charge: nothing is charged, nothing delivered
//   { cancelled: false, status: 'processing' }  — already paid for and being finished: keep polling, it arrives
//   { cancelled: false, status: 'completed' | 'failed' | 'cancelled' } — it had already ended
//   409 — a job type whose worker cannot honour a cancel;  404 — not this user's job
// ⚠️ UNDER THE SAME USAGE LOCK THE LETTER WORKER CHARGES UNDER. The worker reads "cancelled?" and charges inside
// that lock, and marks the job 'charged' before releasing it; this cancel waits for the lock. So either the cancel
// lands first and the worker sees it, or the charge lands first and the cancel is refused — never both.
router.post('/job-cancel/:jobId', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    try {
        const job = await getJob(req.params.jobId, userId);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        if (!jobService.CANCELLABLE_JOB_TYPES.includes(job.type)) {
            return res.status(409).json({ cancelled: false, status: job.status, error: 'This job cannot be cancelled.' });
        }
        if (job.status !== 'pending' && job.status !== 'processing') {
            return res.json({ cancelled: false, status: job.status });
        }
        const message = job.type === 'generate_cover_letter' ? CANCELLED_LETTER : CANCELLED_BATCH;
        let cancelled = false;
        try {
            const { withUsageLock } = require('../controllers/coverLetterController');
            await withUsageLock(userId, 'cover_letter', async () => { cancelled = await jobService.cancelJob(job.id, userId, message); });
        } catch (lockError) {
            // ⚠️ NEVER CANCEL WITHOUT THE LOCK (2026-09-19). The worker reads "cancelled?" and charges inside it, and marks
            // the job 'charged' only once consumeOnSuccess has returned — so a cancel written OUTSIDE the lock can land in
            // that gap: the job reads "cancelled" and the user is told nothing was charged, while the unit is already
            // spent. (This fallback used to do exactly that on a lock_timeout.) Without the lock the honest answer is
            // "still running": the job finishes, and the letter it may have paid for is delivered — paid for AND received.
            // A cancel that already landed inside the lock is still reported: cancelJob's write autocommits on the pool.
            console.warn(`[job-cancel] usage lock unavailable for user ${userId} (${lockError.message}) — NOT cancelling without it`);
        }
        if (cancelled) {
            console.log(`🛑 [job-cancel] job ${job.id} (${job.type}) cancelled by user ${userId}`);
            return res.json({ cancelled: true, status: 'cancelled' });
        }
        const now = await getJob(job.id, userId);
        return res.json({ cancelled: false, status: now ? now.status : null });
    } catch (error) {
        console.error('Error cancelling job:', error);
        res.status(500).json({ error: 'Failed to cancel the job' });
    }
});

module.exports = router;
