'use strict';

/**
 * THE "DESIGNING FOR" ROW, KEPT ON THE SERVER (Migration 048, 2026-09-20).
 *
 * Home's chip row is a SAVED list (MobileApp/services/homeRoster.ts): the first complete load seeds it, and after
 * that a chip leaves or moves only because the user did something. That list lived only on the phone
 * (AsyncStorage 'home_roster_v1:' + account), so each phone kept its own.
 *
 * ⚠️ THE OWNER USES TWO PHONES. Production app_events, 2026-09-19 (UTC): user 1 on install a_kz5txdx3… (4.6 b203)
 * until 16:29:52, then on install a_ehuc9bgx… (4.6 b209), where the test account 616 had been signed in — he signed in
 * there as user 1 at 16:32:53 and built the Airbus letter 27 s later. A row kept per device seeds itself afresh on
 * each phone from the live ranking, so the second phone showed a different row (and a different chip selected) from
 * the first: "reset and changed automatically", although no one had touched it.
 *
 * So the row is kept HERE too — one JSONB row per user, the phone's copy being the offline and fast-paint cache:
 *   • a phone with no saved row starts from this one instead of seeding from the ranking;
 *   • every change the user makes (the X, an Undo, an add, a pick) and every load that moves the row is written here;
 *   • a phone whose own row is OLDER than this one (another phone wrote since) takes this one.
 * ⚠️ COMPARE-AND-SET, NEVER LAST-WRITER-WINS. Each write names the revision it was made from (`base`); it lands only
 * when that is still the stored revision, else it answers 409 with the stored row, and the phone lays its own
 * unsent edits over THAT and writes again. A phone that had been idle for a day can therefore never write its old
 * row over the one the user shaped on the other phone since — a seed (base 0) never overwrites a row that exists.
 * ⚠️ PER USER, NOT PER STORE ENVIRONMENT. The row names tracked employers and postings, which are the user's on every
 * build; only the DOCUMENTS behind a chip are scoped by environment (user_employer_documents.environment). Keyed by
 * environment, the owner's TestFlight phone and his store phone would each keep their own row again.
 * The body is the client's to shape; this file only bounds it (size, key count) and makes its text what jsonb will
 * store (wellFormed: no NUL, no half of an emoji), and never interprets it. The revision lives in its own column: a
 * `rev` inside the body is ignored.
 */

const dbConfig = require('../../db-config');

// ⚠️ ONE DEFINITION, used by db-init's Migration 048 AND by ensureTable below (a migration that failed — col()
// swallows — must not leave every read and write throwing). No '?' anywhere: dbConfig rewrites it into a placeholder.
const TABLE_SQL = `CREATE TABLE IF NOT EXISTS user_home_roster (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    roster     JSONB NOT NULL,
    rev        INTEGER NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

/** The row's JSON, at most. User 1's (255 tracked employers, the hidden list, 12-20 chips) is well under 64 KB. */
const ROSTER_MAX_BYTES = 512 * 1024;
/** Chips on the row, at most — the app caps its own row at the same number (homeRoster.ts ROSTER_MAX_KEYS). */
const ROSTER_MAX_KEYS = 64;
/** A chip key: 'emp_<uuid>' or 'job_<posting URL>'. */
const ROSTER_KEY_MAX_LEN = 2048;

let ensured = null;
function ensureTable() {
    if (!ensured) ensured = dbConfig.run(TABLE_SQL).catch((e) => { ensured = null; throw e; });
    return ensured;
}

/** The account string the app keys its rows by (MobileApp/services/homeAddEmployer.ts readSession). */
const accountOf = (userId) => 'u:' + String(userId);

const parseJson = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
};

/**
 * Any string of the body as jsonb will take it. ⚠️ jsonb REFUSES two things JSON.stringify writes happily: NUL (an
 * "unsupported Unicode escape") and HALF of a surrogate pair ("Unicode low surrogate must follow a high surrogate").
 * The second is not exotic (2026-09-20 review): an employer named "🚀 Rocket Lab" gets its chip letter from name[0] —
 * trackEmployer and jobService both do that — which is exactly half an emoji. Refused, that one letter failed the upsert
 * (500) on this and every later write for the account, silently, for as long as the chip stayed on the row. So NUL goes
 * and a lone half becomes U+FFFD; object keys are cleaned the same way as the strings in `keys`.
 */
const NUL = new RegExp(String.fromCharCode(0), 'g');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const cleanText = (s) => s.replace(NUL, '').replace(LONE_SURROGATE, '\uFFFD');
function wellFormed(v, depth = 0) {
    if (typeof v === 'string') return cleanText(v);
    if (!v || typeof v !== 'object') return v;
    if (depth > 64) throw new Error('too deep');
    if (Array.isArray(v)) return v.map((x) => wellFormed(x, depth + 1));
    const out = {};
    for (const k of Object.keys(v)) out[cleanText(k)] = wellFormed(v[k], depth + 1);
    return out;
}

/**
 * The body the table will take, as JSON text — or null to refuse it. Shape and size: v 1, a keys array of strings,
 * a snap object, and every string as jsonb will store it (wellFormed). `rev` is dropped (the column is the revision).
 */
function acceptableRoster(roster) {
    if (!roster || typeof roster !== 'object' || Array.isArray(roster)) return null;
    if (roster.v !== 1 || !Array.isArray(roster.keys) || roster.keys.length > ROSTER_MAX_KEYS) return null;
    if (!roster.keys.every((k) => typeof k === 'string' && k.length > 0 && k.length <= ROSTER_KEY_MAX_LEN)) return null;
    if (!roster.snap || typeof roster.snap !== 'object' || Array.isArray(roster.snap)) return null;
    const { rev, ...body } = roster;   // eslint-disable-line no-unused-vars
    let text;
    try { text = JSON.stringify(wellFormed(body)); } catch { return null; }
    if (!text || Buffer.byteLength(text, 'utf8') > ROSTER_MAX_BYTES) return null;
    return text;
}

/** The stored row: { rev, roster } — rev 0 and roster null when there is none. */
async function readRow(userId) {
    await ensureTable();
    const row = await dbConfig.get('SELECT roster, rev, updated_at FROM user_home_roster WHERE user_id = $1', [userId]);
    if (!row) return { rev: 0, roster: null, updatedAt: null };
    return { rev: Number(row.rev) || 0, roster: parseJson(row.roster), updatedAt: row.updated_at || null };
}

/**
 * Write `text` as this user's row if the stored revision is still `base`.
 * → { ok: true, rev } or { ok: false, rev, roster } (the stored row that won).
 *   • base 0 = "there is no row yet": INSERTED, never over a row that exists (a seed never overwrites another phone's row);
 *   • base N = "made from revision N": UPDATED only while it still is N — ⚠️ and never INSERTED (2026-09-20 review). With
 *     no row at all, a write from revision N answers { rev 0, roster null }: the row was DELETED (account deletion clears
 *     it — server.js), and a phone still holding its copy must not bring it back; it drops the copy and seeds afresh
 *     (MobileApp/services/homeRoster.ts pushRoster). The upsert used to re-insert it from whichever phone wrote next.
 */
async function writeRow(userId, text, base) {
    await ensureTable();
    const won = base === 0
        ? await dbConfig.get(
            `INSERT INTO user_home_roster (user_id, roster, rev, updated_at) VALUES ($1, $2::jsonb, 1, NOW())
             ON CONFLICT (user_id) DO NOTHING
             RETURNING rev`,
            [userId, text])
        : await dbConfig.get(
            `UPDATE user_home_roster SET roster = $2::jsonb, rev = rev + 1, updated_at = NOW()
              WHERE user_id = $1 AND rev = $3
             RETURNING rev`,
            [userId, text, base]);
    if (won) return { ok: true, rev: Number(won.rev) || 0 };
    const cur = await readRow(userId);
    return { ok: false, rev: cur.rev, roster: cur.roster };
}

/** GET /api/ai-hub/home/roster → { success, account, rev, roster | null, updatedAt } */
async function getHomeRoster(req, res) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const row = await readRow(userId);
        return res.json({ success: true, account: accountOf(userId), rev: row.rev, roster: row.roster, updatedAt: row.updatedAt });
    } catch (err) {
        console.error('[homeRoster] read failed:', err.message);
        return res.status(500).json({ success: false, error: 'Could not load your employers row.' });
    }
}

/**
 * PUT /api/ai-hub/home/roster { account, base, roster }
 *   200 { success, rev }                        — stored; `rev` is the new revision
 *   409 { success:false, reason:'conflict', rev, roster } — another phone wrote since `base`: nothing stored
 *   409 { success:false, reason:'account' }     — the body is another account's row (a sign-out raced the write)
 *   409 { success:false, reason:'conflict', rev: 0, roster: null } — `base` > 0 and no row at all: it was deleted
 *   400 invalid_base / invalid_roster
 * ⚠️ THE ACCOUNT IN THE BODY MUST BE THE TOKEN'S. A write the app queued for user 1 and sent after a switch to 616
 * would otherwise store user 1's employers as 616's row.
 */
async function putHomeRoster(req, res) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const b = req.body || {};
    if (b.account !== accountOf(userId)) {
        return res.status(409).json({ success: false, reason: 'account', error: 'That row belongs to another account.' });
    }
    const base = Number.isInteger(b.base) && b.base >= 0 ? b.base : null;
    if (base === null) return res.status(400).json({ success: false, reason: 'invalid_base', error: 'Invalid revision.' });
    const text = acceptableRoster(b.roster);
    if (!text) {
        // Logged: the app does not send a refused row again until it changes, so this line is where one shows.
        console.warn('[homeRoster] refused a row for user ' + userId + ': '
            + (Array.isArray(b.roster && b.roster.keys) ? b.roster.keys.length + ' keys' : 'not a row'));
        return res.status(400).json({ success: false, reason: 'invalid_roster', error: 'Invalid row.' });
    }
    try {
        const out = await writeRow(userId, text, base);
        if (out.ok) return res.json({ success: true, rev: out.rev });
        return res.status(409).json({ success: false, reason: 'conflict', rev: out.rev, roster: out.roster });
    } catch (err) {
        console.error('[homeRoster] write failed:', err.message);
        return res.status(500).json({ success: false, error: 'Could not save your employers row.' });
    }
}

module.exports = {
    TABLE_SQL, ROSTER_MAX_BYTES, ROSTER_MAX_KEYS, ROSTER_KEY_MAX_LEN,
    ensureTable, accountOf, wellFormed, acceptableRoster, readRow, writeRow, getHomeRoster, putHomeRoster,
};
