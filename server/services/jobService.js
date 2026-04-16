const dbConfig = require('../../db-config');

/**
 * Create a new async job
 */
async function createJob(userId, type, input) {
    const result = await dbConfig.query(
        `INSERT INTO async_jobs (user_id, type, status, progress, input)
         VALUES ($1, $2, 'pending', 0, $3)
         RETURNING id`,
        [userId, type, JSON.stringify(input)]
    );
    return result[0].id;
}

/**
 * Get job by ID (with user ownership check)
 */
async function getJob(jobId, userId) {
    return dbConfig.get(
        `SELECT id, user_id, type, status, progress, result, error, created_at, updated_at
         FROM async_jobs WHERE id = $1 AND user_id = $2`,
        [jobId, userId]
    );
}

/**
 * Update job progress
 */
async function updateJobProgress(jobId, progress) {
    await dbConfig.run(
        `UPDATE async_jobs SET progress = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [progress, jobId]
    );
}

/**
 * Mark job as completed with result data
 */
async function completeJob(jobId, result) {
    await dbConfig.run(
        `UPDATE async_jobs SET status = 'completed', progress = 100, result = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [JSON.stringify(result), jobId]
    );
}

/**
 * Mark job as failed
 */
async function failJob(jobId, errorMessage) {
    await dbConfig.run(
        `UPDATE async_jobs SET status = 'failed', error = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [errorMessage, jobId]
    );
}

/**
 * Mark job as processing
 */
async function startJob(jobId) {
    await dbConfig.run(
        `UPDATE async_jobs SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [jobId]
    );
}

/**
 * Clean up old completed/failed jobs (older than 24 hours)
 */
async function cleanupOldJobs() {
    await dbConfig.run(
        `DELETE FROM async_jobs WHERE status IN ('completed', 'failed') AND created_at < NOW() - INTERVAL '24 hours'`
    );
}

/**
 * Re-queue stuck processing jobs on server restart (older than 5 minutes)
 */
async function requeueStuckJobs() {
    const stuck = await dbConfig.query(
        `UPDATE async_jobs SET status = 'pending', progress = 0, updated_at = CURRENT_TIMESTAMP
         WHERE status = 'processing' AND updated_at < NOW() - INTERVAL '5 minutes'
         RETURNING id, type`
    );
    if (stuck.length > 0) {
        console.log(`🔄 Re-queued ${stuck.length} stuck jobs:`, stuck.map(j => j.id));
    }
    return stuck;
}

module.exports = {
    createJob,
    getJob,
    updateJobProgress,
    completeJob,
    failJob,
    startJob,
    cleanupOldJobs,
    requeueStuckJobs
};
