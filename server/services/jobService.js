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
 * Write partial result while job is still processing (for progressive streaming)
 */
async function updateJobPartialResult(jobId, partialResult) {
    await dbConfig.run(
        `UPDATE async_jobs SET result = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [JSON.stringify(partialResult), jobId]
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

// ─────────────────────────────────────────────────────────────────────────────
// NEW: AI Hub Centralized Database Operations
// ─────────────────────────────────────────────────────────────────────────────

async function upsertEmployer(domain, name, subInfo, logoColor, logoInitial) {
    const result = await dbConfig.query(
        `INSERT INTO employers (domain, name, sub_info, logo_color, logo_initial)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (domain) DO UPDATE SET 
            name = EXCLUDED.name,
            sub_info = EXCLUDED.sub_info,
            last_scraped_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [domain, name, subInfo, JSON.stringify(logoColor), logoInitial]
    );
    return result[0].id;
}

async function getEmployerByDomain(domain) {
    return dbConfig.get(`SELECT * FROM employers WHERE domain = $1`, [domain]);
}

async function upsertLocation(locationString) {
    if (!locationString) return null;
    
    // We try to parse "City, Country"
    let city = locationString;
    let country = null;
    if (locationString.includes(',')) {
        const parts = locationString.split(',');
        city = parts[0].trim();
        country = parts[parts.length - 1].trim();
    }
    
    const result = await dbConfig.query(
        `INSERT INTO locations (raw_text, city, country)
         VALUES ($1, $2, $3)
         ON CONFLICT (raw_text) DO UPDATE SET
            city = EXCLUDED.city,
            country = EXCLUDED.country
         RETURNING id`,
        [locationString, city, country]
    );
    return result[0].id;
}

async function upsertSkill(skillName) {
    const result = await dbConfig.query(
        `INSERT INTO skills (name)
         VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [skillName]
    );
    return result[0].id;
}

async function upsertJob(employerId, locationId, title, jobUrl, experience, salary, jobType, urgent) {
    const result = await dbConfig.query(
        `INSERT INTO jobs (employer_id, location_id, title, job_url, experience, salary, job_type, urgent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (job_url) DO UPDATE SET
            title = EXCLUDED.title,
            location_id = EXCLUDED.location_id,
            experience = EXCLUDED.experience,
            salary = EXCLUDED.salary,
            job_type = EXCLUDED.job_type,
            urgent = EXCLUDED.urgent,
            is_active = TRUE,
            updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [employerId, locationId, title, jobUrl, experience, salary, jobType, urgent]
    );
    return result[0].id;
}

async function linkJobSkill(jobId, skillId) {
    await dbConfig.query(
        `INSERT INTO job_skills (job_id, skill_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [jobId, skillId]
    );
}

async function addJobContact(jobId, name, role, email, phone, avatarUrl) {
    await dbConfig.query(
        `INSERT INTO job_contacts (job_id, name, role, email, phone, avatar_url)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [jobId, name, role, email, phone, avatarUrl]
    );
}

async function trackUserEmployer(userId, employerId) {
    await dbConfig.query(
        `INSERT INTO user_tracked_employers (user_id, employer_id, status)
         VALUES ($1, $2, 'watching')
         ON CONFLICT (user_id, employer_id) DO UPDATE SET status = 'watching', updated_at = CURRENT_TIMESTAMP`,
        [userId, employerId]
    );
}

async function linkUserSkill(userId, skillId) {
    await dbConfig.query(
        `INSERT INTO user_skills (user_id, skill_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, skillId]
    );
}

async function saveUserJobMatch(userId, jobId, matchScore) {
    await dbConfig.query(
        `INSERT INTO user_job_matches (user_id, job_id, match_score)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, job_id) DO UPDATE SET 
            match_score = EXCLUDED.match_score,
            updated_at = CURRENT_TIMESTAMP`,
        [userId, jobId, matchScore]
    );
}

// Fetches the fully constructed dashboard for a user using the normalized tables
async function getUserDashboard(userId) {
    // 1. Get tracked employers
    const trackedEmployers = await dbConfig.query(
        `SELECT e.*, ute.status as tracking_status
         FROM user_tracked_employers ute
         JOIN employers e ON ute.employer_id = e.id
         WHERE ute.user_id = $1 AND ute.status = 'watching'
         ORDER BY ute.updated_at DESC`,
        [userId]
    );
    
    const dashboard = [];
    
    for (const emp of trackedEmployers) {
        // 2. Get jobs for this employer that match the user
        const jobsRows = await dbConfig.query(
            `SELECT j.*, ujm.match_score, l.raw_text as location_text
             FROM jobs j
             JOIN user_job_matches ujm ON j.id = ujm.job_id
             LEFT JOIN locations l ON j.location_id = l.id
             WHERE j.employer_id = $1 AND ujm.user_id = $2 AND j.is_active = TRUE
             ORDER BY ujm.match_score DESC`,
            [emp.id, userId]
        );
        
        const jobs = [];
        for (const jRow of jobsRows) {
            // Get skills
            const skillsRows = await dbConfig.query(
                `SELECT s.name FROM skills s
                 JOIN job_skills js ON s.id = js.skill_id
                 WHERE js.job_id = $1`,
                [jRow.id]
            );
            
            // Get contacts
            const contactsRows = await dbConfig.query(
                `SELECT * FROM job_contacts WHERE job_id = $1`,
                [jRow.id]
            );
            
            jobs.push({
                id: jRow.id,
                title: jRow.title,
                location: jRow.location_text || 'Remote',
                experience: jRow.experience || 'Not specified',
                salary: jRow.salary,
                jobType: jRow.job_type,
                urgent: jRow.urgent,
                matchScore: jRow.match_score,
                applyUrl: jRow.job_url,
                skills: skillsRows.map(s => s.name),
                contacts: contactsRows.map((c, ci) => ({
                    id: c.id,
                    name: c.name,
                    role: c.role,
                    email: c.email,
                    phone: c.phone,
                    avatarUrl: c.avatar_url,
                    verified: false,
                    avatarColor: ['#06B6D4', '#3B82F6'] // Fallback color
                }))
            });
        }
        
        dashboard.push({
            jobId: null, // No longer an async_job ID, but kept for UI compatibility if needed
            status: 'completed',
            progress: 100,
            employer: {
                id: emp.id,
                name: emp.name,
                subInfo: emp.sub_info,
                logoColor: typeof emp.logo_color === 'string' ? JSON.parse(emp.logo_color) : emp.logo_color,
                logoInitial: emp.logo_initial,
                status: emp.tracking_status,
                jobs: jobs
            }
        });
    }
    
    return dashboard;
}

async function archiveUserEmployer(userId, employerId) {
    await dbConfig.run(
        `UPDATE user_tracked_employers SET status = 'archived' WHERE user_id = $1 AND employer_id = $2`,
        [userId, employerId]
    );
}

module.exports = {
    createJob,
    getJob,
    updateJobProgress,
    updateJobPartialResult,
    completeJob,
    failJob,
    startJob,
    cleanupOldJobs,
    requeueStuckJobs,
    upsertEmployer,
    getEmployerByDomain,
    upsertLocation,
    upsertSkill,
    upsertJob,
    linkJobSkill,
    addJobContact,
    trackUserEmployer,
    linkUserSkill,
    saveUserJobMatch,
    getUserDashboard,
    archiveUserEmployer
};
