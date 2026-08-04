const dbConfig = require('../../db-config');
const geoRank = require('../utils/geoRank');       // country-then-distance comparator (shared with the feed)
const geoContext = require('./geoContext');        // …and the per-user anchor + honest-fallback decision

/**
 * The geo ORDER-BY prefix for the tracked-employer job lists. These rows live in `jobs`, not
 * global_jobs, so there is no country column — the tier is read off locations.raw_text alone.
 * Returns '' (and therefore byte-identical SQL to before this feature) whenever we have no country
 * for the user, or whenever their field is too thin in that country for country-first to help.
 */
async function geoOrderPrefix(userId, params) {
    try {
        const geo = await geoContext.getGeoContext(userId);
        if (!geo.active || geo.mode !== 'country-first') return '';
        const P = (v) => { params.push(v); return '$' + params.length; };
        return geoRank.tierSql(geo.anchor, P, { locationCol: 'l.raw_text', countryCol: null }) + ', ';
    } catch (e) {
        console.warn('[geo] dashboard ordering skipped:', e.message);
        return '';
    }
}

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
 * Fail stuck jobs on server restart (older than 5 minutes).
 *
 * Jobs are processed inline (fire-and-forget) inside the request that created them —
 * there is NO background worker that re-runs them. So if the process died mid-job, the
 * row is left 'processing' (or 'pending', if it died before startJob) and would never
 * progress. We mark such rows 'failed' so the mobile client STOPS polling and can
 * re-issue the request, instead of polling a ghost job forever.
 */
async function requeueStuckJobs() {
    const stuck = await dbConfig.query(
        `UPDATE async_jobs
            SET status = 'failed',
                error = 'Interrupted by a server restart — please try again.',
                updated_at = CURRENT_TIMESTAMP
          WHERE status IN ('processing', 'pending')
            AND updated_at < NOW() - INTERVAL '5 minutes'
        RETURNING id, type`
    );
    if (stuck.length > 0) {
        console.log(`⚠️  Failed ${stuck.length} interrupted jobs:`, stuck.map(j => j.id));
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

async function upsertJob(employerId, locationId, title, jobUrl, experience, salary, jobType, urgent, responsibilities = [], workMode = null) {
    const respJson = Array.isArray(responsibilities) && responsibilities.length > 0
        ? JSON.stringify(responsibilities)
        : null;
    const result = await dbConfig.query(
        `INSERT INTO jobs (employer_id, location_id, title, job_url, experience, salary, job_type, urgent, responsibilities, work_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (job_url) DO UPDATE SET
            -- Re-point the job to the CURRENT search's employer. ATS jobs live on a
            -- subdomain (jobs.acme.com) while users search the corporate domain
            -- (acme.com); extractDomain() keys the employer off whatever URL was
            -- entered, so the same job_url can be searched under different employer
            -- rows. Without this, the first employer to insert a job_url owns it
            -- forever, and a later searcher's dashboard (which filters by the employer
            -- THEY track) shows 0 jobs even though their user_job_matches exist.
            employer_id = EXCLUDED.employer_id,
            title = EXCLUDED.title,
            location_id = EXCLUDED.location_id,
            experience = EXCLUDED.experience,
            salary = EXCLUDED.salary,
            job_type = EXCLUDED.job_type,
            urgent = EXCLUDED.urgent,
            responsibilities = EXCLUDED.responsibilities,
            work_mode = EXCLUDED.work_mode,
            is_active = TRUE,
            updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [employerId, locationId, title, jobUrl, experience, salary, jobType, urgent, respJson, workMode]
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

async function addJobContact(jobId, name, role, email, phone, avatarUrl, linkedinUrl = null, imageUrl = null) {
    // If contact has an email, upsert on (job_id, email) to prevent duplicates
    if (email) {
        await dbConfig.query(
            `INSERT INTO job_contacts (job_id, name, role, email, phone, avatar_url, linkedin_url, image_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (job_id, email) DO UPDATE SET
                name = EXCLUDED.name,
                role = EXCLUDED.role,
                phone = COALESCE(EXCLUDED.phone, job_contacts.phone),
                linkedin_url = COALESCE(EXCLUDED.linkedin_url, job_contacts.linkedin_url),
                image_url = COALESCE(EXCLUDED.image_url, job_contacts.image_url),
                updated_at = CURRENT_TIMESTAMP`,
            [jobId, name, role, email, phone, avatarUrl, linkedinUrl, imageUrl]
        ).catch(async () => {
            // Fallback if unique constraint doesn't exist yet — plain insert
            await dbConfig.query(
                `INSERT INTO job_contacts (job_id, name, role, email, phone, avatar_url, linkedin_url, image_url)
                 SELECT $1,$2,$3,$4,$5,$6,$7,$8 WHERE NOT EXISTS (
                   SELECT 1 FROM job_contacts WHERE job_id=$1 AND lower(email)=lower($4)
                 )`,
                [jobId, name, role, email, phone, avatarUrl, linkedinUrl, imageUrl]
            );
        });
    } else {
        await dbConfig.query(
            `INSERT INTO job_contacts (job_id, name, role, email, phone, avatar_url, linkedin_url, image_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [jobId, name, role, email, phone, avatarUrl, linkedinUrl, imageUrl]
        );
    }
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

// Create or update a user↔job match row. Pass a numeric `matchScore` to record a computed
// score (also stamps scored_at so it counts as "scored"); pass null/undefined to only ENSURE
// the row exists as UNSCORED (scored_at stays NULL → the card shows "Evaluating…") without
// clobbering any score already stored.
async function saveUserJobMatch(userId, jobId, matchScore = null) {
    const scored = typeof matchScore === 'number' && Number.isFinite(matchScore);
    await dbConfig.query(
        `INSERT INTO user_job_matches (user_id, job_id, match_score, scored_at)
         VALUES ($1, $2, $3, ${scored ? 'CURRENT_TIMESTAMP' : 'NULL'})
         ON CONFLICT (user_id, job_id) DO UPDATE SET
            match_score = ${scored ? 'EXCLUDED.match_score' : 'user_job_matches.match_score'},
            scored_at   = ${scored ? 'CURRENT_TIMESTAMP' : 'user_job_matches.scored_at'},
            updated_at  = CURRENT_TIMESTAMP`,
        [userId, jobId, scored ? matchScore : 0]
    );
}

// Hard-delete a job (cascades job_skills, job_contacts, user_job_matches via FK ON DELETE
// CASCADE). Used by the best-200 ranking to evict a weak-match job for a stronger one
// during a fresh scrape (where the searching user owns all the just-created jobs).
// ⚠️ CONTACTS-LOSS GUARD: never hard-delete a job that has saved hiring contacts. job_contacts
// has ON DELETE CASCADE, so deleting the job row silently wipes the user's manually-added
// contacts. When a to-be-evicted job carries contacts we DEACTIVATE it instead (is_active=FALSE):
// it drops out of the dashboard exactly like a delete, but the contacts survive and a later
// re-search of the same job reactivates the same row.
async function jobHasContacts(jobId) {
    const r = await dbConfig.get(`SELECT 1 AS x FROM job_contacts WHERE job_id = ? LIMIT 1`, [jobId]);
    return !!r;
}

async function deleteJob(jobId) {
    if (await jobHasContacts(jobId)) {
        await dbConfig.run(`UPDATE jobs SET is_active = FALSE WHERE id = ?`, [jobId]);
        return;
    }
    await dbConfig.run(`DELETE FROM jobs WHERE id = ?`, [jobId]);
}

// Per-user eviction for the best-200 ranking. Removes THIS user's match to the job, then
// removes the shared job row ONLY if no other user still references it (cross-user safety,
// H4/M22) AND it has no saved contacts (contacts-loss guard → soft-deactivate instead).
async function evictUserJob(jobId, userId) {
    await dbConfig.run(`DELETE FROM user_job_matches WHERE job_id = ? AND user_id = ?`, [jobId, userId]);
    const other = await dbConfig.get(`SELECT 1 AS x FROM user_job_matches WHERE job_id = ? LIMIT 1`, [jobId]);
    if (other) return;
    if (await jobHasContacts(jobId)) {
        await dbConfig.run(`UPDATE jobs SET is_active = FALSE WHERE id = ?`, [jobId]);
        return;
    }
    await dbConfig.run(`DELETE FROM jobs WHERE id = ?`, [jobId]);
}

const AVATAR_COLORS_DB = [
    ['#06B6D4', '#3B82F6'],
    ['#8B5CF6', '#6D28D9'],
    ['#10B981', '#059669'],
    ['#F59E0B', '#D97706'],
    ['#EF4444', '#DC2626'],
];

/**
 * Fetches the fully constructed dashboard for a user.
 * - For in-progress jobs: returns partial data from async_jobs.result
 * - For completed jobs: loads from normalized tables (jobs, skills, contacts)
 */
// Shared job-row → API job object mapper (dashboard list, employer-jobs pager, /jobs/:id/full).
// slimResponsibilities: the LIST view renders only 3 bullets, so ship 3 + respTotal (the full
// array comes from /jobs/:id/full when the job is opened) — responsibilities are ~38% of the
// dashboard's raw bytes, this is the single biggest payload lever.
function buildJobObject(jRow, skills, contactRows, { slimResponsibilities = false } = {}) {
    const respFull = (() => {
        try { return jRow.responsibilities ? (typeof jRow.responsibilities === 'string' ? JSON.parse(jRow.responsibilities) : jRow.responsibilities) : []; } catch { return []; }
    })();
    return {
        id: String(jRow.id),
        title: jRow.title,
        location: jRow.location_text || 'Not specified',
        experience: jRow.experience || 'Not specified',
        salary: jRow.salary || 'Not listed',
        jobType: jRow.job_type || 'Full-time',
        workMode: jRow.work_mode || null,
        urgent: !!jRow.urgent,
        matchScore: jRow.scored_at ? (jRow.match_score ?? 0) : null,
        createdAt: jRow.created_at,
        applyUrl: jRow.job_url,
        skills: skills || [],
        responsibilities: slimResponsibilities ? respFull.slice(0, 3) : respFull,
        respTotal: respFull.length,
        contacts: (contactRows || []).map((c, ci) => ({
            id: String(c.id),
            name: c.name,
            role: c.role || 'Recruiter',
            email: c.email || '',
            phone: c.phone || null,
            linkedin: c.linkedin_url || null,
            imageUrl: c.image_url || null,
            verified: false,
            avatarColor: AVATAR_COLORS_DB[ci % AVATAR_COLORS_DB.length],
        })),
    };
}

async function getUserDashboard(userId) {
    // 1. Get tracked employers with async job status
    const trackedEmployers = await dbConfig.query(
        `SELECT e.*, ute.status as tracking_status, ute.async_job_id,
                aj.status as job_status, aj.progress as job_progress, aj.result as job_result
         FROM user_tracked_employers ute
         JOIN employers e ON ute.employer_id = e.id
         LEFT JOIN async_jobs aj ON ute.async_job_id = aj.id
         WHERE ute.user_id = $1 AND ute.status = 'watching'
         ORDER BY ute.updated_at DESC`,
        [userId]
    );

    // PERF: batch ALL completed employers' jobs+skills+contacts into 5 total queries (was 3 queries
    // PER employer → ~700 sequential round-trips → 14s for a heavy user). Cap to the top
    // DASH_JOBS_PER_EMP jobs per employer (by match, then recency); the LIST payload also trims
    // responsibilities to the 3 bullets the card shows (respTotal keeps the true count) — the full
    // record ships from GET /jobs/:id/full when a job is opened, and more jobs page in via
    // GET /dashboard/employer/:id/jobs. emp_total/totalContacts carry the REAL counts so the
    // clients' stats don't shrink to the page size. This keeps the payload bounded as data grows.
    const DASH_JOBS_PER_EMP = 20;
    const completedIds = trackedEmployers
        .filter((e) => !['pending', 'processing'].includes(e.job_status))
        .map((e) => e.id);
    const jobsByEmp = {}, skillsByJob = {}, contactsByJob = {}, totalByEmp = {}, contactsCountByEmp = {};
    if (completedIds.length) {
        // Nearest-first inside each employer, then best match — the same order the feed uses, so the
        // 20 jobs we keep per employer are the 20 nearest ones rather than 20 anywhere in the world.
        const jobParams = [userId, completedIds, DASH_JOBS_PER_EMP];
        const geoOrd = await geoOrderPrefix(userId, jobParams);
        const jobRows = await dbConfig.query(
            `SELECT * FROM (
               SELECT j.id, j.employer_id, j.title, j.experience, j.salary, j.job_type, j.work_mode,
                      j.urgent, j.created_at, j.job_url, j.responsibilities,
                      ujm.match_score, ujm.scored_at, l.raw_text AS location_text,
                      row_number() OVER (PARTITION BY j.employer_id ORDER BY ${geoOrd}ujm.match_score DESC NULLS LAST, j.created_at DESC, j.id) AS rn,
                      COUNT(*) OVER (PARTITION BY j.employer_id)::int AS emp_total
               FROM jobs j
               JOIN user_job_matches ujm ON j.id = ujm.job_id
               LEFT JOIN locations l ON j.location_id = l.id
               WHERE ujm.user_id = $1 AND j.is_active = TRUE AND j.employer_id = ANY($2::uuid[])
             ) t WHERE rn <= $3 ORDER BY employer_id, rn`,
            jobParams
        );
        const jobIds = [];
        for (const r of jobRows) { (jobsByEmp[r.employer_id] = jobsByEmp[r.employer_id] || []).push(r); totalByEmp[r.employer_id] = r.emp_total; jobIds.push(r.id); }
        if (jobIds.length) {
            const skRows = await dbConfig.query(
                `SELECT js.job_id, s.name FROM skills s JOIN job_skills js ON s.id = js.skill_id WHERE js.job_id = ANY($1::uuid[])`, [jobIds]);
            for (const r of skRows) (skillsByJob[r.job_id] = skillsByJob[r.job_id] || []).push(r.name);
            const cRows = await dbConfig.query(`SELECT * FROM job_contacts WHERE job_id = ANY($1::uuid[])`, [jobIds]);
            for (const c of cRows) (contactsByJob[c.job_id] = contactsByJob[c.job_id] || []).push(c);
        }
        // True per-employer contact counts over ALL the user's matched jobs (not just the page) —
        // the clients derive their "Contacts" stats client-side, so give them the real number.
        const ccRows = await dbConfig.query(
            `SELECT j.employer_id, COUNT(*)::int AS n
             FROM job_contacts jc
             JOIN jobs j ON jc.job_id = j.id
             JOIN user_job_matches ujm ON ujm.job_id = j.id
             WHERE ujm.user_id = $1 AND j.is_active = TRUE AND j.employer_id = ANY($2::uuid[])
             GROUP BY j.employer_id`,
            [userId, completedIds]
        );
        for (const r of ccRows) contactsCountByEmp[r.employer_id] = r.n;
    }

    const buildJob = (jRow) => buildJobObject(jRow, skillsByJob[jRow.id] || [], contactsByJob[jRow.id] || [], { slimResponsibilities: true });

    const dashboard = [];

    for (const emp of trackedEmployers) {
        const isProcessing = ['pending', 'processing'].includes(emp.job_status);
        const logoColor = (() => {
            try {
                const v = emp.logo_color;
                if (Array.isArray(v)) return v;
                if (typeof v === 'string') return JSON.parse(v);
                return ['#555555', '#1C1C1E'];
            } catch { return ['#555555', '#1C1C1E']; }
        })();

        let jobs = [], totalJobs = 0;
        if (isProcessing && emp.job_result) {
            try {
                const partial = typeof emp.job_result === 'string' ? JSON.parse(emp.job_result) : emp.job_result;
                jobs = partial?.jobs || [];
                totalJobs = jobs.length;
            } catch {}
        } else {
            jobs = (jobsByEmp[emp.id] || []).map(buildJob);
            totalJobs = totalByEmp[emp.id] || jobs.length;
        }

        dashboard.push({
            jobId: emp.async_job_id || null,
            status: emp.job_status || 'completed',
            progress: emp.job_progress || 100,
            employer: {
                id: String(emp.id),
                // Fall back to employer_id when async_job_id is null (it's null for
                // cache-loaded / older tracked employers). The mobile remove handler
                // only calls the server when employer.jobId is truthy, and
                // removeDashboardItem already resolves an employer_id param — so this
                // makes "remove company" actually persist instead of being local-only
                // (the removed company was reappearing on reload).
                jobId: emp.async_job_id || String(emp.id),
                name: emp.name,
                subInfo: emp.sub_info || '',
                logoColor,
                logoInitial: (emp.name[0] || '?').toUpperCase(),
                status: jobs.length > 0 ? 'active' : 'watching',
                jobs,
                totalJobs,
                totalContacts: contactsCountByEmp[emp.id] || 0,
            },
            updatedAt: emp.updated_at,
        });
    }

    return dashboard;
}

/**
 * Paged jobs for one employer (same job shape as the dashboard list). Lets the clients keep the
 * initial dashboard payload small while every job stays reachable via "Show more".
 */
async function getEmployerJobsPage(userId, employerId, offset = 0, limit = 40) {
    limit = Math.min(Math.max(parseInt(limit, 10) || 40, 1), 100);
    offset = Math.max(parseInt(offset, 10) || 0, 0);
    const pageParams = [userId, employerId, offset, limit];
    const geoOrd = await geoOrderPrefix(userId, pageParams);   // same order as the dashboard page 1
    const jobRows = await dbConfig.query(
        `SELECT j.id, j.employer_id, j.title, j.experience, j.salary, j.job_type, j.work_mode,
                j.urgent, j.created_at, j.job_url, j.responsibilities,
                ujm.match_score, ujm.scored_at, l.raw_text AS location_text,
                COUNT(*) OVER ()::int AS emp_total
         FROM jobs j
         JOIN user_job_matches ujm ON j.id = ujm.job_id
         LEFT JOIN locations l ON j.location_id = l.id
         WHERE ujm.user_id = $1 AND j.is_active = TRUE AND j.employer_id = $2
         ORDER BY ${geoOrd}ujm.match_score DESC NULLS LAST, j.created_at DESC, j.id
         OFFSET $3 LIMIT $4`,
        pageParams
    );
    const jobIds = jobRows.map((r) => r.id);
    const skillsByJob = {}, contactsByJob = {};
    if (jobIds.length) {
        const skRows = await dbConfig.query(
            `SELECT js.job_id, s.name FROM skills s JOIN job_skills js ON s.id = js.skill_id WHERE js.job_id = ANY($1::uuid[])`, [jobIds]);
        for (const r of skRows) (skillsByJob[r.job_id] = skillsByJob[r.job_id] || []).push(r.name);
        const cRows = await dbConfig.query(`SELECT * FROM job_contacts WHERE job_id = ANY($1::uuid[])`, [jobIds]);
        for (const c of cRows) (contactsByJob[c.job_id] = contactsByJob[c.job_id] || []).push(c);
    }
    return {
        jobs: jobRows.map((r) => buildJobObject(r, skillsByJob[r.id] || [], contactsByJob[r.id] || [], { slimResponsibilities: true })),
        total: jobRows[0] ? jobRows[0].emp_total : 0,
        offset,
    };
}

/**
 * Full-fidelity single job (ALL responsibilities/skills/contacts + employer summary) for the
 * detail views — the dashboard LIST ships a slimmed record; opening a job hydrates from here.
 * Also serves web deep-links (?id=) directly instead of scanning the whole dashboard.
 */
async function getJobFull(userId, jobId) {
    const jRow = await dbConfig.get(
        `SELECT j.id, j.employer_id, j.title, j.experience, j.salary, j.job_type, j.work_mode,
                j.urgent, j.created_at, j.job_url, j.responsibilities,
                ujm.match_score, ujm.scored_at, l.raw_text AS location_text,
                e.name AS emp_name, e.sub_info AS emp_sub_info, e.logo_color AS emp_logo_color, e.domain AS emp_domain
         FROM jobs j
         JOIN user_job_matches ujm ON j.id = ujm.job_id AND ujm.user_id = $2
         LEFT JOIN locations l ON j.location_id = l.id
         LEFT JOIN employers e ON j.employer_id = e.id
         WHERE j.id = $1 AND j.is_active = TRUE`,
        [jobId, userId]
    );
    if (!jRow) return null;
    const skRows = await dbConfig.query(
        `SELECT s.name FROM skills s JOIN job_skills js ON s.id = js.skill_id WHERE js.job_id = $1`, [jobId]);
    const cRows = await dbConfig.query(`SELECT * FROM job_contacts WHERE job_id = $1`, [jobId]);
    const logoColor = (() => {
        try {
            const v = jRow.emp_logo_color;
            if (Array.isArray(v)) return v;
            if (typeof v === 'string') return JSON.parse(v);
            return ['#555555', '#1C1C1E'];
        } catch { return ['#555555', '#1C1C1E']; }
    })();
    const job = buildJobObject(jRow, skRows.map((r) => r.name), cRows, { slimResponsibilities: false });
    return {
        job,
        employer: jRow.emp_name ? {
            id: String(jRow.employer_id),
            name: jRow.emp_name,
            subInfo: jRow.emp_sub_info || '',
            domain: jRow.emp_domain || null,
            logoColor,
            logoInitial: (jRow.emp_name[0] || '?').toUpperCase(),
        } : null,
    };
}

/**
 * Opt-5 caching: returns a fully-built employer object from the DB if the employer
 * was scraped within `maxAgeHours` by ANY user.  Returns null on cache miss.
 *
 * @param {string} domain        Normalised employer domain
 * @param {string} userId        Current user (for user_job_matches)
 * @param {number} maxAgeHours   Cache TTL in hours (default 24)
 */
async function getRecentEmployerData(domain, maxAgeHours = 24) {
    // Is there a freshly-scraped employer for this domain?
    const employer = await dbConfig.get(
        `SELECT * FROM employers
         WHERE domain = $1
           AND last_scraped_at > NOW() - ($2 || ' hours')::INTERVAL`,
        [domain, String(maxAgeHours)]
    );
    if (!employer) return null;

    // Does it have active jobs — and are they actually ENRICHED? A previous failed
    // scrape can leave active jobs with 0 skills and null responsibilities (e.g. an ATS
    // whose detail pages weren't parsed). Serving that from cache forever is wrong, so
    // when nothing is enriched we return null → the caller re-scrapes fresh.
    // A job counts as ENRICHED if it carries real signal: parsed skills/responsibilities,
    // a concrete salary, OR a deep apply URL (≥2 path segments — a real posting link, not
    // the bare careers page or a synthetic "#role-N" fragment). This still rejects a failed
    // scrape (title-only, no detail, no real link) while letting a legitimately thin ATS
    // listing be cached instead of re-scraped on every single search. (M21)
    const stats = await dbConfig.get(
        `SELECT
           COUNT(*) AS active_jobs,
           COUNT(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM job_skills js WHERE js.job_id = j.id)
                OR (j.responsibilities IS NOT NULL
                    AND j.responsibilities <> '[]' AND j.responsibilities <> 'null')
                OR (j.salary IS NOT NULL AND j.salary <> '')
                OR (j.job_url IS NOT NULL AND j.job_url NOT LIKE '%#role-%'
                    AND j.job_url ~ '^https?://[^/]+/[^/]+/.+')
           ) AS enriched_jobs
         FROM jobs j
         WHERE j.employer_id = $1 AND j.is_active = TRUE`,
        [employer.id]
    );
    const active   = parseInt(stats?.active_jobs   || 0, 10);
    const enriched = parseInt(stats?.enriched_jobs || 0, 10);
    if (active < 1) return null;
    if (enriched === 0) {
        console.log(`[aiHub] Cache bypass for "${domain}": ${active} active jobs but 0 enriched (no skills/responsibilities) — forcing re-scrape`);
        return null;
    }

    return employer;
}

/**
 * Builds the full employer object from DB for a cache-hit user.
 * Ensures user_job_matches rows exist, then reads jobs with skills + contacts.
 */
async function buildCachedEmployerObject(employer, userId, asyncJobId) {
    // Ensure every active job for this employer has a user_job_match row
    await dbConfig.run(
        `INSERT INTO user_job_matches (user_id, job_id, match_score)
         SELECT $1, j.id, 0
         FROM jobs j
         WHERE j.employer_id = $2 AND j.is_active = TRUE
         ON CONFLICT (user_id, job_id) DO NOTHING`,
        [userId, employer.id]
    );

    const jobsRows = await dbConfig.query(
        `SELECT j.*, ujm.match_score, ujm.scored_at, l.raw_text AS location_text
         FROM jobs j
         JOIN user_job_matches ujm ON j.id = ujm.job_id
         LEFT JOIN locations l ON j.location_id = l.id
         WHERE j.employer_id = $1 AND ujm.user_id = $2 AND j.is_active = TRUE
         ORDER BY j.created_at DESC`,
        [employer.id, userId]
    );

    const logoColor = (() => {
        try {
            const v = employer.logo_color;
            if (Array.isArray(v)) return v;
            return typeof v === 'string' ? JSON.parse(v) : ['#555', '#1C1C1E'];
        } catch { return ['#555', '#1C1C1E']; }
    })();

    const AVATAR_COLORS_LOCAL = [
        ['#06B6D4','#3B82F6'], ['#8B5CF6','#6D28D9'], ['#10B981','#059669'],
        ['#F59E0B','#D97706'], ['#EF4444','#DC2626'],
    ];

    const jobs = [];
    for (const jRow of jobsRows) {
        const skillsRows   = await dbConfig.query(
            `SELECT s.name FROM skills s JOIN job_skills js ON s.id = js.skill_id WHERE js.job_id = $1`,
            [jRow.id]
        );
        const contactsRows = await dbConfig.query(
            `SELECT * FROM job_contacts WHERE job_id = $1`, [jRow.id]
        );
        const responsibilities = (() => {
            try {
                if (!jRow.responsibilities) return [];
                return typeof jRow.responsibilities === 'string'
                    ? JSON.parse(jRow.responsibilities)
                    : jRow.responsibilities;
            } catch { return []; }
        })();
        jobs.push({
            id: String(jRow.id),
            title: jRow.title,
            location: jRow.location_text || 'Not specified',
            experience: jRow.experience || 'Not specified',
            salary: jRow.salary || 'Not listed',
            jobType: jRow.job_type || 'Full-time',
            workMode: jRow.work_mode || null,
            urgent: !!jRow.urgent,
            matchScore: jRow.scored_at ? (jRow.match_score ?? 0) : null,
            createdAt: jRow.created_at,
            applyUrl: jRow.job_url,
            skills: skillsRows.map(s => s.name),
            responsibilities,
            contacts: contactsRows.map((c, ci) => ({
                id: String(c.id),
                name: c.name,
                role: c.role || 'Recruiter',
                email: c.email || '',
                phone: c.phone || null,
                linkedin: c.linkedin_url || null,
                imageUrl: c.image_url || null,
                verified: false,
                avatarColor: AVATAR_COLORS_LOCAL[ci % AVATAR_COLORS_LOCAL.length],
            })),
        });
    }

    return {
        id: String(employer.id),
        jobId: asyncJobId,
        name: employer.name,
        subInfo: employer.sub_info || '',
        logoColor,
        logoInitial: (employer.name[0] || '?').toUpperCase(),
        status: 'active',
        domain: employer.domain || null,   // cache path: carry the full domain (TLD) too
        jobs,
    };
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
    deleteJob,
    evictUserJob,
    getUserDashboard,
    getEmployerJobsPage,
    getJobFull,
    archiveUserEmployer,
    getRecentEmployerData,
    buildCachedEmployerObject
};
