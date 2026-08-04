// Resolves ONE geo-ranking context per user and hands it to every ranked-jobs path — ADDITIVE.
//
// geoRank.js holds the rules and is deliberately database-free (so it is testable as a pure
// function). This file is the thin DB half: where does this user say they are, does their field
// actually have jobs there, and therefore is country-first safe or do we fall back and say so.
//
// Cost control: the answer changes on the order of days, not requests, so it is memoised per user
// (5 min) and the "how many <field> jobs are in <country>" count is memoised globally (10 min) —
// a 500-recipient notification blast pays for a handful of counts, not 500.
//
// Kill switch: GEO_RANK=0 makes getGeoContext() return the INACTIVE context, and every caller then
// builds byte-identical SQL to what it built before this feature existed.
'use strict';

const dbConfig = require('../../db-config');
const geoRank = require('../utils/geoRank');
const { deriveUserField } = require('../utils/jobTaxonomy');

const USER_TTL_MS = 5 * 60 * 1000;
const COUNT_TTL_MS = 10 * 60 * 1000;
const _userCache = new Map();    // userId|field → { ctx, at }
const _countCache = new Map();   // field||country → { n, at }

function off() { return process.env.GEO_RANK === '0'; }

async function countFieldJobsInCountry(field, anchor) {
  const key = field + '||' + anchor.country;
  const hit = _countCache.get(key);
  if (hit && Date.now() - hit.at < COUNT_TTL_MS) return hit.n;
  try {
    const params = [field];
    const P = (v) => { params.push(v); return '$' + params.length; };
    const same = geoRank.sameCountrySql(anchor, P, { countryCol: 'country', locationCol: 'location' });
    const row = await dbConfig.get(
      `SELECT COUNT(*)::int n FROM global_jobs WHERE is_active AND field = $1 AND ${same}`, params);
    const n = row ? Number(row.n) : null;
    if (n != null) _countCache.set(key, { n, at: Date.now() });
    return n;
  } catch (e) {
    // Unknown coverage must NOT become an optimistic country-first sort — decideMode() reads null
    // as "leave the existing order alone".
    console.warn('[geo] field/country count failed (falling back to match-first):', e.message);
    return null;
  }
}

/**
 * @param userId
 * @param opts.field  the caller's already-derived résumé field (pass it to save a query);
 *                    pass undefined to have it derived here, or null for "this user has none".
 * @returns { active, mode, notice, reason, anchor, field, fieldJobsInCountry }
 */
async function getGeoContext(userId, opts = {}) {
  if (off() || !userId) return geoRank.INACTIVE;
  const fieldKey = opts.field === undefined ? '~' : String(opts.field || '');
  const key = userId + '|' + fieldKey;
  const hit = _userCache.get(key);
  if (hit && Date.now() - hit.at < USER_TTL_MS) return hit.ctx;

  let ctx = geoRank.INACTIVE;
  try {
    const [user, meta] = await Promise.all([
      dbConfig.get('SELECT id, city, country, address FROM users WHERE id = $1', [userId]).catch(() => null),
      dbConfig.get(`SELECT raw_text, skills, job_titles, industries FROM resume_metadata
                     WHERE user_id = $1 AND parse_status = 'done' ORDER BY id DESC LIMIT 1`, [userId]).catch(() => null),
    ]);
    const anchor = geoRank.buildAnchor({ user, resumeMeta: meta });
    let field = opts.field;
    if (field === undefined) { const f = deriveUserField(meta); field = f ? f.field : null; }
    const n = (anchor.country && field) ? await countFieldJobsInCountry(field, anchor) : null;
    const decided = geoRank.decideMode({ anchor, field, fieldJobsInCountry: n });
    ctx = { active: !!anchor.country, anchor, field: field || null, fieldJobsInCountry: n, ...decided };
  } catch (e) {
    console.warn('[geo] context failed (ranking unchanged):', e.message);
    ctx = geoRank.INACTIVE;
  }
  _userCache.set(key, { ctx, at: Date.now() });
  return ctx;
}

/** An explicit user choice (a saved interest's country/city) ranked with the same comparator. */
function contextForPlace(country, city) {
  const canon = geoRank.canonCountry(country);
  if (!canon) return geoRank.INACTIVE;
  const anchor = {
    country: canon, countrySource: 'chosen',
    city: String(city || '').trim() || null, citySource: city ? 'chosen' : null,
    region: null, cityRejected: null,
  };
  return { active: true, anchor, field: null, fieldJobsInCountry: null, mode: 'country-first', notice: null,
    reason: 'the user picked this country themselves' };
}

/** The one line the UI can show. Null when nothing needs saying. */
function noticeOf(ctx) { return (ctx && ctx.notice) || null; }

function _resetCaches() { _userCache.clear(); _countCache.clear(); }

module.exports = { getGeoContext, contextForPlace, noticeOf, _resetCaches };
