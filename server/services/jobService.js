const dbConfig = require('../../db-config');
const geoRank = require('../utils/geoRank');       // country-then-distance comparator (shared with the feed)
const geoContext = require('./geoContext');        // …and the per-user anchor + honest-fallback decision
// ⚠️ LAZY: discoverController requires aiHubController, which requires this module — a top-level
// require here would hand one side a half-built exports object. Resolved on first dashboard read.
const websiteOf = (raw, name) => require('../controllers/discoverController').websiteOf(raw, name);
const ownsHost = (name, host) => require('../controllers/discoverController').ownsHost(name, host);
// Same lazy rule: downloads -> entitlements is a long chain, and only a chip rename needs it.
const downloads = () => require('./downloads');

// Postgres "undefined column" / "undefined table". Migration 046 (user_tracked_employers.display_name,
// user_home_hidden_targets) runs inside initializeDatabase, which races app.listen, and a failed ALTER is
// swallowed there, so for a while (or for good, on a database it could not alter) they can be absent.
// Every read and write of them below falls back to the pre-046 statement on exactly these codes.
const isMissingSchema = (e) => !!e && (e.code === '42703' || e.code === '42P01');

// Does this employer NAME legitimately belong to its domain? ownsHost (the name's alias key IS the host's
// registrable label) plus the name's initials: measured with ownsHost alone, "Tata Consultancy
// Services" does NOT own tcs.com while "TCS" does, so a correct row would look unowned. Initials are
// tried over every word and over the words left after joiners/legal suffixes ("International Business
// Machines Corp" -> ibm).
// ⚠️ A URL-SHAPED NAME NEVER OWNS ANYTHING. aliasKeysOf reduces "amazon.jobs/anything" or
// "https://amazon.jobs" to "amazon", so without this a link (or a scrape's companyInput fallback, which
// can be the pasted URL) would count as the company's real name and be protected against the name that
// is. Anything with / : < > @, a leading www., or the bare shape of a host is refused here.
const NAME_JOINERS = new Set(['the', 'and', 'of', 'for', 'de', 'des', 'du', 'la', 'le', 'und', 'inc', 'llc', 'llp',
    'ltd', 'limited', 'gmbh', 'ag', 'se', 'sa', 'plc', 'corp', 'corporation', 'co', 'company']);
const URL_SHAPED_NAME = /[/:<>@]|^www\.|^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
function nameOwnsHost(name, host) {
    const s = String(name || '').trim();
    if (!s || !host || URL_SHAPED_NAME.test(s)) return false;
    if (ownsHost(s, host)) return true;
    const words = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .split(/[^a-z0-9]+/).filter(Boolean);
    if (words.length < 2) return false;
    const all = words.map((w) => w[0]).join('');
    const core = words.filter((w) => !NAME_JOINERS.has(w)).map((w) => w[0]).join('');
    return ownsHost(all, host) || (core.length >= 2 && ownsHost(core, host));
}

/**
 * Should a SCRAPE's name for this employer be refused in favour of the name already stored?
 *
 * ⚠️ THE SOUQ.COM BUG. A Job Hub search of amazon.jobs read a posting's legal entity ("Souq.com for
 * E-Commerce LLC") and wrote it over the shared row's "Amazon": for every user, and again on every
 * search, undoing any hand repair. `employers` is one identity table shared by all users, so a stored
 * name that OWNS the host ("Amazon" <-> amazon.jobs) is kept against an incoming name that does not.
 * Everything else behaves as before (the scrape's name wins): a stored name that does not own its host
 * stays replaceable, which is how a Phase-1 nav label ("Back ButtonSearch Icon") still gets fixed.
 * Used by upsertEmployer's ON CONFLICT and processJobSearch's AI name override. Home's Add never renames
 * the shared row at all (trackEmployerForUser).
 */
function keepStoredEmployerName(storedName, incomingName, domain) {
    if (!storedName || !incomingName || storedName === incomingName) return false;
    return nameOwnsHost(storedName, domain) && !nameOwnsHost(incomingName, domain);
}

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
 *
 * ⚠️ A CANCELLED JOB STAYS CANCELLED (see cancelJob). The result is still written — a batch cancelled half-way
 * holds the letters it had already paid for, and they must not vanish with the status — but the status keeps
 * saying what the user did, so no poller reads "completed" for a job they walked away from.
 */
async function completeJob(jobId, result) {
    await dbConfig.run(
        `UPDATE async_jobs SET status = CASE WHEN status = 'cancelled' THEN status ELSE 'completed' END, progress = 100, result = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [JSON.stringify(result), jobId]
    );
}

/**
 * Mark job as failed
 * ⚠️ Never over a cancel: the worker's own "cancelled" refusal ends here, and the cancel's words must survive it.
 */
async function failJob(jobId, errorMessage) {
    await dbConfig.run(
        `UPDATE async_jobs SET status = 'failed', error = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND status <> 'cancelled'`,
        [errorMessage, jobId]
    );
}

// ── CANCELLING A LETTER JOB — the user tapped Cancel, or the app gave up waiting ────────────────────────────
//
// ⚠️ A CANCEL THAT ONLY STOPPED THE PHONE WAS A CHARGE WITH NOTHING TO SHOW FOR IT. The Letters page's Cancel
// aborted its own fetch and stopped polling, and the job carried on: the letter was written, the unit consumed
// under the usage lock, and the result left in async_jobs.result for cleanupOldJobs to delete a day later. The
// Job Hub gave up after five minutes the same way. Now the app says so (POST /job-cancel/:jobId), the row is
// marked 'cancelled', and the letter worker reads that UNDER THE USAGE LOCK, just before it would charge — a
// cancelled letter is never charged and never delivered.
// ⚠️ ONLY A CLIENT THAT CALLS IT: the Job Hub does (its deadline, leaving the job). The Letters page's Cancel lives in
// App.js, which does not call it yet — until it does, that Cancel still stops only the phone.
//
// ONLY the job types whose workers honour it. A job type that never reads the flag would be charged anyway and
// then hide its result behind a status that says it was not — so every other type is refused (409).
// A job whose charge already landed carries result.stage 'charged' (the letter worker writes it under the same
// lock, the moment it pays): it is not cancellable any more, because "cancelled — nothing was charged" would
// then be false. The poller keeps going and receives the letter it paid for.
const CANCELLABLE_JOB_TYPES = Object.freeze(['generate_cover_letter', 'batch_generate', 'batch_generate-and-send', 'batch_send']);

/**
 * Mark the caller's own job cancelled, while it is still pending or processing and not yet charged.
 * Resolves true when THIS call cancelled it (false: someone else's, already finished, already charged, or a
 * type that cannot be cancelled). `message` is what the job's pollers are shown.
 */
async function cancelJob(jobId, userId, message) {
    const rows = await dbConfig.query(
        `UPDATE async_jobs SET status = 'cancelled', error = $3, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'processing')
            AND type = ANY($4::text[])
            AND COALESCE(result->>'stage', '') <> 'charged'
        RETURNING id`,
        [jobId, userId, message || 'Cancelled.', [...CANCELLABLE_JOB_TYPES]]
    );
    return !!(rows && rows.length);
}

/** Has this job been cancelled? A missing row is not a cancel. Throws on a read failure — the caller decides. */
async function isCancelled(jobId) {
    if (!jobId) return false;
    const row = await dbConfig.get(`SELECT status FROM async_jobs WHERE id = $1`, [jobId]);
    return !!row && row.status === 'cancelled';
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
 * Mark job as processing (never a job cancelled before its worker got to it)
 */
async function startJob(jobId) {
    await dbConfig.run(
        `UPDATE async_jobs SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status <> 'cancelled'`,
        [jobId]
    );
}

/**
 * Clean up old completed/failed/cancelled jobs (older than 24 hours)
 */
async function cleanupOldJobs() {
    await dbConfig.run(
        `DELETE FROM async_jobs WHERE status IN ('completed', 'failed', 'cancelled') AND created_at < NOW() - INTERVAL '24 hours'`
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

// ⚠️ THE NAME ON CONFLICT IS GUARDED (keepStoredEmployerName). The stored name is read first and, when it
// owns the host and the scraped one does not, passed as $6: the CASE keeps employers.name only while it
// is STILL that string, so a rename that landed in between is not undone by a stale read — at worst the
// old behaviour (the scrape's name wins) happens. A read failure never blocks the upsert ($6 = NULL).
// Resolves { id, name } — name is what the row is called AFTER the upsert, which differs from the
// scraped `name` exactly when the guard kept the stored one (processJobSearch shows that name).
async function upsertEmployerWithName(domain, name, subInfo, logoColor, logoInitial) {
    let keep = null;
    try {
        const cur = await dbConfig.get(`SELECT name FROM employers WHERE domain = $1`, [domain]);
        if (cur && keepStoredEmployerName(cur.name, name, domain)) {
            keep = cur.name;
            console.log(`[aiHub] employer ${domain}: kept "${cur.name}" (owns the host) over scraped "${name}"`);
        }
    } catch { /* keep = null: the pre-guard behaviour */ }
    const result = await dbConfig.query(
        `INSERT INTO employers (domain, name, sub_info, logo_color, logo_initial)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (domain) DO UPDATE SET
            name = CASE WHEN employers.name = $6::text THEN employers.name ELSE EXCLUDED.name END,
            sub_info = EXCLUDED.sub_info,
            last_scraped_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
         RETURNING id, name`,
        [domain, name, subInfo, JSON.stringify(logoColor), logoInitial, keep]
    );
    return { id: result[0].id, name: result[0].name || name };
}

async function upsertEmployer(domain, name, subInfo, logoColor, logoInitial) {
    return (await upsertEmployerWithName(domain, name, subInfo, logoColor, logoInitial)).id;
}

/**
 * Home "Add employer" (POST /employers/track): make sure an employers row owns `domain`, then put it
 * on the user's Home as 'watching' — the cap checks, the insert and the track in ONE transaction.
 * Returns { row, inserted, displayName } on success, or { limit: 'watching' | 'daily' } when a cap refuses it.
 *
 * ⚠️ INSERT-IF-ABSENT, NOT upsertEmployer. Its ON CONFLICT rewrites name + sub_info and stamps
 * last_scraped_at, and `employers` is SHARED: one signed-in user typing "Acme Ltd" would rename the
 * real row for every user (their Job Hub cards, the Add-employer name search, the Gemini prompts in
 * findRecruiters / generateJobCoverLetter), wipe its sub_info, and make getRecentEmployerData serve a
 * stale board from the 24h cache to the next searcher. So a conflict does NOTHING and the caller
 * reads back the STORED name. That is correct for a shared identity table.
 *
 * ⚠️ last_scraped_at is written as NULL on purpose. The column's default is CURRENT_TIMESTAMP
 * (nullable), which would make an empty, never-scraped row look fresh: getRecentEmployerData would
 * "cache hit" it and answer the first real search with zero jobs. NULL is never fresh, and the first
 * real search's upsertEmployer stamps it. No scrape-path row is NULL (prod 2026-09-11: 0 of 328), so
 * NULL marks "user-added, unverified" — which is why discover's name search shows such a row only to
 * a user who tracks it.
 *
 * ⚠️ THE 60-WATCHING CAP WAS A TOCTOU. count-then-insert as separate statements let N parallel
 * requests all read 59 and all insert. A conditional INSERT … WHERE (SELECT COUNT(*)) < 60 does NOT
 * fix that under READ COMMITTED (each statement's snapshot misses the other's uncommitted row), so
 * the count and the track run under a per-USER transaction-scoped advisory lock: one user's tracks
 * serialise, different users never wait on each other, and the lock dies with the transaction.
 *
 * ⚠️ THE DAILY INSERT LIMIT IS WHAT BOUNDS THE SHARED TABLE. Archiving frees a watching slot but the
 * employers row stays, so "track 60, archive 60, repeat" filled `employers` forever. There is no
 * created_by column, and none is needed: the employers INSERT and the user_tracked_employers INSERT
 * both write created_at = CURRENT_TIMESTAMP inside this ONE transaction, and CURRENT_TIMESTAMP is the
 * transaction's start time — so "this user's endpoint created that row" is exactly
 * e.created_at = ute.created_at AND e.last_scraped_at IS NULL. A re-track never touches either
 * created_at (ON CONFLICT updates status/display_name/updated_at only), a row another user created has an older
 * e.created_at, and archiving keeps the ute row, so an archived insert still counts for the day.
 *
 * ⚠️ THE NAME THE USER PICKED WINS — FOR THAT USER, AND ONLY IN THEIR ROW. "The stored name wins" put
 * "Souq.com for E-Commerce LLC" on the chip of a user who added Amazon (amazon.jobs): a job ingest had
 * named the shared row after the posting's legal entity. So the picked name is stored PER USER in
 * user_tracked_employers.display_name (insert AND re-track — the latest pick wins) and every read of
 * this user's employer prefers it.
 * ⚠️ THE SHARED employers ROW IS NEVER RENAMED HERE. An earlier "guarded repair" renamed it when the
 * stored name did not own the host and the picked one did — but any signed-in user could then set a
 * shared name for everyone (a URL-shaped "amazon.jobs/…" passes the alias test), and every other user
 * whose chip still fell back to employers.name got a new chip name AND a new pass/cache key. The scrape
 * side is guarded instead (keepStoredEmployerName), and other users' names are frozen in their own
 * display_name (Migration 046 backfill + trackUserEmployer).
 * ⚠️ A RENAME MOVES THIS USER'S PASS WITH IT. A pass binds to employerKeyOf(the chip's name); renaming
 * "Souq.com for E-Commerce LLC" to "Amazon" made the pass bought under the old chip invisible to the new
 * one, and the next build or download asked for money again. So when this user's previous shown name
 * (display_name, else employers.name) is a different company spelling (!sameEmployer), their passes
 * bound under the old key are rebound to the new name in this same transaction (rebindPassesForRename).
 * ⚠️ Re-adding also un-hides the employer's Home chip (user_home_hidden_targets 'emp_<id>'), or the
 * X the user pressed earlier would keep the employer they just added invisible.
 * ⚠️ MIGRATION 046 MAY NOT HAVE RUN (isMissingSchema): each 046 statement sits in its own SAVEPOINT, so a
 * missing column/table falls back to the pre-046 statement instead of failing the add. Without
 * display_name nothing is renamed, so displayName comes back null and the chip shows the stored name —
 * the same name the dashboard (and therefore every later build's billing key) will show.
 * Returns { row, inserted, displayName }.
 */
async function trackEmployerForUser(userId, { domain, name, displayName, logoColor, logoInitial }, { maxWatching, maxInsertsPerDay }) {
    const picked = typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 255) : null;
    return dbConfig.withTransaction(async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('ai_hub.track_employer'), $1::int)`, [userId]);

        let row = await tx.get(
            `SELECT id, name, sub_info, logo_color FROM employers WHERE domain = $1`, [domain]);
        const w = await tx.get(
            `SELECT COUNT(*)::int AS n, COALESCE(bool_or(employer_id = $2::uuid), FALSE) AS already
               FROM user_tracked_employers
              WHERE user_id = $1 AND status = 'watching'`,
            [userId, row ? row.id : null]);
        // Re-adding one you already watch is never refused — by either cap (it has a row, so the
        // insert branch below cannot run for it).
        if (!(w && w.already) && ((w && w.n) || 0) >= maxWatching) return { limit: 'watching' };

        let inserted = false;
        if (!row) {
            const made = await tx.get(
                `SELECT COUNT(*)::int AS n
                   FROM user_tracked_employers ute
                   JOIN employers e ON e.id = ute.employer_id
                  WHERE ute.user_id = $1
                    AND e.last_scraped_at IS NULL
                    AND e.created_at = ute.created_at
                    AND ute.created_at > CURRENT_TIMESTAMP - INTERVAL '1 day'`,
                [userId]);
            if (((made && made.n) || 0) >= maxInsertsPerDay) return { limit: 'daily' };
            const ins = await tx.run(
                `INSERT INTO employers (domain, name, sub_info, logo_color, logo_initial, last_scraped_at, created_at)
                 VALUES ($1, $2, NULL, $3, $4, NULL, CURRENT_TIMESTAMP)
                 ON CONFLICT (domain) DO NOTHING
                 RETURNING id, name, sub_info, logo_color`,
                [domain, name, JSON.stringify(logoColor), logoInitial]);
            inserted = ins.rows.length > 0;
            // A concurrent insert by ANOTHER user (a different lock) made ours a no-op; READ COMMITTED
            // gives this statement a fresh snapshot, so their committed row is visible now.
            row = inserted ? ins.rows[0]
                : await tx.get(`SELECT id, name, sub_info, logo_color FROM employers WHERE domain = $1`, [domain]);
            if (!row) throw new Error(`employer row for ${domain} vanished between insert and read`);
        }

        // The per-user name (Migration 046). The previous shown name is read first — only a row that
        // already existed can have one (a just-inserted employers row has no tracking rows yet).
        // ⚠️ COALESCE on conflict: a caller that passes no display name must not wipe the one the user
        // picked before. created_at stays out of the conflict branch (the daily-insert attribution).
        let prevShown = null;
        const named = await withSavepoint(tx, 'track_display_name', async () => {
            if (!inserted && picked) {
                const prev = await tx.get(
                    `SELECT display_name FROM user_tracked_employers WHERE user_id = $1 AND employer_id = $2`,
                    [userId, row.id]);
                if (prev) prevShown = (prev.display_name && String(prev.display_name).trim()) || row.name || null;
            }
            await tx.run(
                `INSERT INTO user_tracked_employers (user_id, employer_id, status, display_name, created_at)
                 VALUES ($1, $2, 'watching', $3, CURRENT_TIMESTAMP)
                 ON CONFLICT (user_id, employer_id) DO UPDATE SET status = 'watching',
                        display_name = COALESCE(EXCLUDED.display_name, user_tracked_employers.display_name),
                        updated_at = CURRENT_TIMESTAMP`,
                [userId, row.id, picked]);
        });
        if (!named.ok) {
            console.warn(`[aiHub] trackEmployer: Migration 046 missing (${named.error.code}) — tracked without a display name`);
            await tx.run(
                `INSERT INTO user_tracked_employers (user_id, employer_id, status, created_at)
                 VALUES ($1, $2, 'watching', CURRENT_TIMESTAMP)
                 ON CONFLICT (user_id, employer_id) DO UPDATE SET status = 'watching', updated_at = CURRENT_TIMESTAMP`,
                [userId, row.id]);
        } else if (prevShown && picked && prevShown !== picked) {
            const moved = await withSavepoint(tx, 'track_pass_rebind',
                () => rebindPassesForRename(tx, userId, row.id, prevShown, picked));
            if (!moved.ok) console.warn(`[aiHub] trackEmployer: pass rebind skipped (${moved.error.code})`);
        }
        const unhid = await withSavepoint(tx, 'track_unhide', () => tx.run(
            `DELETE FROM user_home_hidden_targets WHERE user_id = $1 AND target_key = 'emp_' || $2::text`,
            [userId, String(row.id)]));
        if (!unhid.ok) console.warn(`[aiHub] trackEmployer: hidden targets unavailable (${unhid.error.code})`);
        return { row, inserted, displayName: named.ok ? picked : null };
    });
}

// Run fn inside a SAVEPOINT of tx. A missing column/table (Migration 046 not applied) rolls back to the
// savepoint — the transaction stays usable — and resolves { ok: false, error }; any other error is
// rethrown, so withTransaction rolls the WHOLE add back (nothing half-renamed, nothing half-rebound).
async function withSavepoint(tx, name, fn) {
    await tx.query(`SAVEPOINT ${name}`);
    try {
        const value = await fn();
        await tx.query(`RELEASE SAVEPOINT ${name}`);
        return { ok: true, value };
    } catch (e) {
        if (!isMissingSchema(e)) throw e;
        await tx.query(`ROLLBACK TO SAVEPOINT ${name}`);
        return { ok: false, error: e };
    }
}

/**
 * This user's chip for employerId was renamed oldName → newName: move the passes they bound under the old
 * name so the new chip still finds them (downloads.boundPassFor keys on employerKeyOf the chip's name).
 * Inside the caller's transaction. All store environments (the rename is not per environment). Resolves
 * the number of passes moved.
 * ⚠️ Nothing moves when the two names are the SAME company (sameEmployer — boundPassFor already matches
 * across those spellings), when either is nameless ('(none)' is never reached by a name), or when another
 * employer this user WATCHES still shows a name that is the same company as the old one: that chip is
 * the one still paying through the pass, and moving it would orphan that chip instead.
 */
async function rebindPassesForRename(tx, userId, employerId, oldName, newName) {
    const dl = downloads();
    const oldKey = dl.employerKeyOf(oldName);
    const newKey = dl.employerKeyOf(newName);
    if (oldKey === dl.NONE || newKey === dl.NONE || oldKey === newKey || dl.sameEmployer(oldName, newName)) return 0;
    const others = await tx.query(
        `SELECT COALESCE(NULLIF(BTRIM(ute.display_name), ''), e.name) AS shown
           FROM user_tracked_employers ute
           JOIN employers e ON e.id = ute.employer_id
          WHERE ute.user_id = $1 AND ute.employer_id <> $2 AND ute.status = 'watching'`,
        [userId, employerId]);
    if ((Array.isArray(others) ? others : []).some((r) => r && r.shown && dl.sameEmployer(r.shown, oldName))) {
        console.log(`[aiHub] rename "${oldName}" → "${newName}": another watched employer still shows the old name — passes left in place`);
        return 0;
    }
    const r = await tx.run(
        `UPDATE download_passes SET employer_key = $1, employer_name = $2
          WHERE user_id = $3 AND employer_key = $4 AND bound_at IS NOT NULL`,
        [newKey, newName, userId, oldKey]);
    const n = (r && r.changes) || 0;
    if (n) console.log(`[aiHub] rename "${oldName}" → "${newName}": moved ${n} pass(es) for user ${userId}`);
    return n;
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

// The Job Hub search / job capture / LinkedIn track. ⚠️ IT FREEZES THE NAME THE USER SEES. The chip name
// is also the pass and cache key (downloads.employerKeyOf), and employers.name is shared — a later
// scrape for ANOTHER user may still rename it (keepStoredEmployerName only guards a name that owns its
// host). So the first track copies employers.name into this user's display_name, and a re-track keeps
// whatever is already there (a Home pick included): COALESCE(existing, new), the reverse of Home's Add.
// Migration 046 backfills the same thing for rows tracked before it. Pre-046 (isMissingSchema) the old
// statement runs, so a search never fails on the migration race.
async function trackUserEmployer(userId, employerId) {
    try {
        await dbConfig.query(
            `INSERT INTO user_tracked_employers (user_id, employer_id, status, display_name)
             VALUES ($1, $2, 'watching', (SELECT e.name FROM employers e WHERE e.id = $2::uuid))
             ON CONFLICT (user_id, employer_id) DO UPDATE SET status = 'watching',
                    display_name = COALESCE(user_tracked_employers.display_name, EXCLUDED.display_name),
                    updated_at = CURRENT_TIMESTAMP`,
            [userId, employerId]
        );
    } catch (e) {
        if (!isMissingSchema(e)) throw e;
        await dbConfig.query(
            `INSERT INTO user_tracked_employers (user_id, employer_id, status)
             VALUES ($1, $2, 'watching')
             ON CONFLICT (user_id, employer_id) DO UPDATE SET status = 'watching', updated_at = CURRENT_TIMESTAMP`,
            [userId, employerId]
        );
    }
}

/**
 * processJobSearch's AI name override, guarded (keepStoredEmployerName): the first detail batch's AI
 * employer_name replaces a Phase-1 name ("Back ButtonSearch Icon") — but never a stored name that owns
 * the host with one that does not (amazon.jobs: "Amazon", not "Souq.com for E-Commerce LLC").
 * Resolves the name the search should show: the AI name when applied, the stored name when kept.
 * ⚠️ THIS USER'S FROZEN NAME FOLLOWS THE FIX, NOBODY ELSE'S. trackUserEmployer froze employers.name into
 * display_name seconds ago, so the Phase-1 junk would otherwise stick on this user's chip for good. Only
 * this user's row, and only while it still equals the name being replaced (a Home pick is left alone);
 * their passes bound under the replaced name move with it, as on Home (rebindPassesForRename). Other
 * users keep their own frozen names and keys.
 * Never throws — a failed rename must not fail the search.
 */
async function applyScrapedEmployerName(userId, employerId, domain, aiName) {
    try {
        const cur = await dbConfig.get(`SELECT name FROM employers WHERE id = $1`, [employerId]);
        if (!cur) return aiName;
        if (cur.name === aiName) return aiName;
        if (keepStoredEmployerName(cur.name, aiName, domain)) {
            console.log(`[aiHub] employer ${domain}: kept "${cur.name}" (owns the host) over AI name "${aiName}"`);
            return cur.name;
        }
        await dbConfig.withTransaction(async (tx) => {
            await tx.run(`UPDATE employers SET name = $1 WHERE id = $2 AND name = $3`, [aiName, employerId, cur.name]);
            const own = await withSavepoint(tx, 'scrape_display_name', () => tx.run(
                `UPDATE user_tracked_employers SET display_name = $1
                  WHERE user_id = $2 AND employer_id = $3 AND display_name = $4`,
                [aiName, userId, employerId, cur.name]));
            if (own.ok && own.value && own.value.changes > 0) {
                const moved = await withSavepoint(tx, 'scrape_pass_rebind',
                    () => rebindPassesForRename(tx, userId, employerId, cur.name, aiName));
                if (!moved.ok) console.warn(`[aiHub] AI name override: pass rebind skipped (${moved.error.code})`);
            }
        });
        return aiName;
    } catch (e) {
        console.warn(`[aiHub] AI name override for ${domain} failed: ${e.message}`);
        return aiName;
    }
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
    // ⚠️ ute.display_name is Migration 046, which can still be running (it races app.listen) or have
    // failed: on 42703 the pre-046 SELECT runs instead and every chip shows the stored name, rather than
    // the whole Job Hub and Home failing to load.
    const trackedSql = (withDisplayName) =>
        `SELECT e.*, ute.status as tracking_status, ute.async_job_id,${withDisplayName ? ' ute.display_name,' : ''}
                aj.status as job_status, aj.progress as job_progress, aj.result as job_result
         FROM user_tracked_employers ute
         JOIN employers e ON ute.employer_id = e.id
         LEFT JOIN async_jobs aj ON ute.async_job_id = aj.id
         WHERE ute.user_id = $1 AND ute.status = 'watching'
         ORDER BY ute.updated_at DESC`;
    const trackedEmployers = await dbConfig.query(trackedSql(true), [userId]).catch((e) => {
        if (!e || e.code !== '42703') throw e;
        console.warn('[aiHub] dashboard: ute.display_name missing (Migration 046) — showing stored names');
        return dbConfig.query(trackedSql(false), [userId]);
    });

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
        // The name THIS user picked on Home (trackEmployerForUser) beats the shared row's name, which a
        // job ingest may have set to a posting's legal entity ("Souq.com for E-Commerce LLC" on
        // amazon.jobs). ⚠️ Display only: websiteOf below still vets the domain with the STORED name.
        const shownName = (emp.display_name && String(emp.display_name).trim()) || emp.name || '';

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
                name: shownName,
                subInfo: emp.sub_info || '',
                logoColor,
                logoInitial: (shownName[0] || '?').toUpperCase(),
                // The employer's bare host — Home's employer chips send it as job.website for a
                // tailored build. ⚠️ employers.domain also holds synthetic identity keys ('search:…',
                // 'web-acme', 'linkedin-acme'), name slugs ('nordex-se'), jobCapture's capture-page
                // host (linkedin.com, boards.greenhouse.io) and resolveCareersUrl's Gemini answers
                // (often an ATS board). websiteOf — the SAME vetting the Add-employer search applies —
                // nulls the non-hosts AND any listed job-board/ATS host the name does not own, so a
                // board never reaches the client as "the website". (A guessed www.{slug}.com that
                // resolves is a real, unlisted host: nothing here can tell it from the real site.)
                // Adding a field changes every ETag once (md5 of the body): one full 200, then 304s.
                domain: websiteOf(emp.domain, emp.name) || null,
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
    // ⚠️ Same Migration 046 fallback as the dashboard: on 42703 (no ute.display_name yet) the pre-046
    // SELECT runs, without the tracking join, and the employer shows its stored name.
    const fullSql = (withDisplayName) =>
        `SELECT j.id, j.employer_id, j.title, j.experience, j.salary, j.job_type, j.work_mode,
                j.urgent, j.created_at, j.job_url, j.responsibilities,
                ujm.match_score, ujm.scored_at, l.raw_text AS location_text,
                e.name AS emp_name, e.sub_info AS emp_sub_info, e.logo_color AS emp_logo_color, e.domain AS emp_domain${withDisplayName ? `,
                ute.display_name AS emp_display_name` : ''}
         FROM jobs j
         JOIN user_job_matches ujm ON j.id = ujm.job_id AND ujm.user_id = $2
         LEFT JOIN locations l ON j.location_id = l.id
         LEFT JOIN employers e ON j.employer_id = e.id${withDisplayName ? `
         LEFT JOIN user_tracked_employers ute ON ute.employer_id = j.employer_id AND ute.user_id = $2` : ''}
         WHERE j.id = $1 AND j.is_active = TRUE`;
    const jRow = await dbConfig.get(fullSql(true), [jobId, userId]).catch((e) => {
        if (!e || e.code !== '42703') throw e;
        console.warn('[aiHub] job detail: ute.display_name missing (Migration 046) — showing the stored name');
        return dbConfig.get(fullSql(false), [jobId, userId]);
    });
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
    // Same per-user naming as the dashboard: the name this user picked, else the shared row's.
    // (user_tracked_employers has one row per user+employer — the PK — so the join cannot fan out.)
    const shownName = (jRow.emp_display_name && String(jRow.emp_display_name).trim()) || jRow.emp_name || '';
    return {
        job,
        employer: jRow.emp_name ? {
            id: String(jRow.employer_id),
            name: shownName,
            subInfo: jRow.emp_sub_info || '',
            domain: jRow.emp_domain || null,
            logoColor,
            logoInitial: (shownName[0] || '?').toUpperCase(),
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

// Archive (soft-delete) one employer for one user. The row, its display_name and the shared employers
// row all stay, so re-adding restores it and the user's saved documents for it. updated_at is stamped
// so "when did this user drop it" is readable. Resolves true when this user had a tracking row for it
// (existing callers ignore the value).
async function archiveUserEmployer(userId, employerId) {
    const r = await dbConfig.run(
        `UPDATE user_tracked_employers SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND employer_id = $2`,
        [userId, employerId]
    );
    return !!(r && r.changes > 0);
}

module.exports = {
    createJob,
    getJob,
    updateJobProgress,
    updateJobPartialResult,
    completeJob,
    failJob,
    startJob,
    cancelJob,
    isCancelled,
    CANCELLABLE_JOB_TYPES,
    cleanupOldJobs,
    requeueStuckJobs,
    upsertEmployer,
    upsertEmployerWithName,
    keepStoredEmployerName,
    applyScrapedEmployerName,
    trackEmployerForUser,
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
