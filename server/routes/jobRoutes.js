const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { getJob } = require('../services/jobService');

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

        if (job.status === 'completed' && job.result) {
            response.data = typeof job.result === 'string' ? JSON.parse(job.result) : job.result;
        }

        if (job.status === 'failed') {
            response.error = job.error;
        }

        res.json(response);
    } catch (error) {
        console.error('Error fetching job status:', error);
        res.status(500).json({ error: 'Failed to fetch job status' });
    }
});

module.exports = router;
