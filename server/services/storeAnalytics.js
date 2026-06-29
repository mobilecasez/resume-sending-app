// Store Analytics — ADDITIVE. Pulls download/sales data from the Apple App Store (Sales & Trends
// reports) and Google Play (install reports), plus rolls up our own recorded transactions from
// payment_orders. Nothing here touches the existing payment/credit flow; it only READS.
//
// Credentials: prod (Railway) has NO Keys/ dir (.railwayignore), so creds load from env vars first,
// with a Keys/ disk fallback for local dev:
//   ASC_KEY_P8_B64        base64 of Keys/AuthKey_33Y3J5248R.p8   (Apple App Store Connect API key)
//   ASC_KEY_ID            (default 33Y3J5248R)
//   ASC_ISSUER_ID         (default bc162399-5ecc-4cdd-baf4-a143d5b1eb65)
//   APPLE_VENDOR_NUMBER   App Store Connect → Payments & Financial Reports → vendor # (required for sales reports)
//   GOOGLE_PLAY_SA_B64    base64 of the Google service-account JSON
//   GOOGLE_PLAY_GCS_BUCKET  the Play "Download reports" Cloud Storage bucket (pubsite_prod_rev_...) for installs
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const jwt = require('jsonwebtoken');
const dbConfig = require('../../db-config');

const ANDROID_PACKAGE = process.env.ANDROID_PACKAGE || 'com.cvapplyr.mobile';
const ASC_KID = process.env.ASC_KEY_ID || '8B7UN3VG74';   // Admin-role key for Analytics Reports (the build key 33Y3J5248R is App-Manager only)
const ASC_ISS = process.env.ASC_ISSUER_ID || 'bc162399-5ecc-4cdd-baf4-a143d5b1eb65';
const APPLE_VENDOR = (process.env.APPLE_VENDOR_NUMBER || '').trim();
const APPLE_APP_ID = process.env.APPLE_ASC_APP_ID || '6762126502';

// ─── credential loaders (env first, Keys/ fallback) ──────────────────────────
function readKeyFile(rel) {
  try { return fs.readFileSync(path.join(__dirname, '..', '..', 'Keys', rel), 'utf8'); } catch { return null; }
}
function asclPrivateKey() {
  if (process.env.ASC_KEY_P8_B64) { try { return Buffer.from(process.env.ASC_KEY_P8_B64, 'base64').toString('utf8'); } catch {} }
  if (process.env.ASC_KEY_P8) return process.env.ASC_KEY_P8.replace(/\\n/g, '\n');
  return readKeyFile('AuthKey_8B7UN3VG74.p8') || readKeyFile('AuthKey_33Y3J5248R.p8');
}
function googleSA() {
  if (process.env.GOOGLE_PLAY_SA_B64) { try { return JSON.parse(Buffer.from(process.env.GOOGLE_PLAY_SA_B64, 'base64').toString('utf8')); } catch {} }
  if (process.env.GOOGLE_PLAY_SA_JSON) { try { return JSON.parse(process.env.GOOGLE_PLAY_SA_JSON); } catch {} }
  const raw = readKeyFile('cvapplyr-e46cebab373e.json');
  if (raw) { try { return JSON.parse(raw); } catch {} }
  return null;
}
function ascToken() {
  const key = asclPrivateKey();
  if (!key) return null;
  try { return jwt.sign({ iss: ASC_ISS, aud: 'appstoreconnect-v1' }, key, { algorithm: 'ES256', keyid: ASC_KID, expiresIn: '12m' }); }
  catch { return null; }
}

function httpsRequest({ hostname, pathname, headers }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: pathname, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function ymd(d) { return d.toISOString().slice(0, 10); }

// ─── Apple App Store: Sales & Trends report (downloads + in-app units + proceeds) ─────────────
function parseAppleSales(tsv) {
  const lines = tsv.split('\n').filter((l) => l.trim());
  if (!lines.length) return { downloads: 0, inAppUnits: 0, proceeds: 0, byType: {} };
  const header = lines[0].split('\t');
  const iUnits = header.indexOf('Units');
  const iProceeds = header.indexOf('Developer Proceeds');
  const iType = header.indexOf('Product Type Identifier');
  let downloads = 0, inAppUnits = 0, proceeds = 0; const byType = {};
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split('\t');
    const units = parseInt(c[iUnits] || '0', 10) || 0;
    const pr = parseFloat(c[iProceeds] || '0') || 0;
    const type = (c[iType] || '').trim();
    byType[type] = (byType[type] || 0) + units;
    proceeds += pr * units;
    // 'IA*' = in-app purchase; everything else (1, 1F, 7, 7F, F1, ...) = app units (installs/updates).
    if (type.toUpperCase().startsWith('IA')) inAppUnits += units; else downloads += units;
  }
  return { downloads, inAppUnits, proceeds: Math.round(proceeds * 100) / 100, byType };
}

async function appleSales({ reportDate, frequency = 'DAILY' } = {}) {
  if (!asclPrivateKey()) return { configured: false, reason: 'Apple API key not loaded. On prod set ASC_KEY_P8_B64 (base64 of the .p8).' };
  if (!APPLE_VENDOR) return { configured: false, reason: 'Set APPLE_VENDOR_NUMBER (App Store Connect → Payments and Financial Reports → the vendor # at the top).' };
  const token = ascToken();
  if (!token) return { configured: false, reason: 'Could not sign the Apple API token (check the .p8 key).' };
  // Apple sales reports lag ~1 day; default to yesterday.
  const date = reportDate || ymd(new Date(Date.now() - 24 * 3600 * 1000));
  const qs = [
    `filter[frequency]=${frequency}`,
    'filter[reportType]=SALES',
    'filter[reportSubType]=SUMMARY',
    `filter[vendorNumber]=${encodeURIComponent(APPLE_VENDOR)}`,
    `filter[reportDate]=${date}`,
    'filter[version]=1_0',
  ].join('&');
  let res;
  try {
    res = await httpsRequest({ hostname: 'api.appstoreconnect.apple.com', pathname: `/v1/salesReports?${qs}`, headers: { Authorization: `Bearer ${token}`, Accept: 'application/a-gzip' } });
  } catch (e) { return { configured: false, reason: 'Apple API request failed: ' + e.message }; }
  if (res.status === 200) {
    try { return { configured: true, date, frequency, ...parseAppleSales(zlib.gunzipSync(res.body).toString('utf8')) }; }
    catch (e) { return { configured: false, reason: 'Could not parse Apple report: ' + e.message }; }
  }
  if (res.status === 404) return { configured: true, date, frequency, downloads: 0, inAppUnits: 0, proceeds: 0, byType: {}, note: 'No report available for that date yet (Apple sales reports lag ~1 day).' };
  if (res.status === 401 || res.status === 403) return { configured: false, reason: `Apple API ${res.status}: the API key needs the Sales (or Finance/Admin) role — App Store Connect → Users and Access → Integrations → App Store Connect API. The build key may be App Manager only.` };
  return { configured: false, reason: `Apple API returned ${res.status}.`, raw: res.body.toString('utf8').slice(0, 300) };
}

// ─── Apple App Store: DOWNLOADS via the Analytics Reports API (no vendor number) ──────────────
// Needs the App Store Connect API key to have the ADMIN role. Async: ensure an ONGOING report
// request exists → list its reports → latest DAILY instance → download segments → parse downloads.
function ascApiJson(method, pathname, body) {
  const token = ascToken();
  if (!token) return Promise.resolve({ status: 0, json: null });
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve) => {
    const req = https.request({ hostname: 'api.appstoreconnect.apple.com', path: pathname, method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (d) => b += d); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j }); }); });
    req.on('error', () => resolve({ status: 0, json: null }));
    if (data) req.write(data);
    req.end();
  });
}
function fetchUrlText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => { const ch = []; res.on('data', (d) => ch.push(d)); res.on('end', () => { const buf = Buffer.concat(ch); try { resolve(zlib.gunzipSync(buf).toString('utf8')); } catch { resolve(buf.toString('utf8')); } }); }).on('error', reject);
  });
}
async function appleAnalytics() {
  if (!asclPrivateKey()) return { configured: false, reason: 'Apple API key not loaded. On prod set ASC_KEY_P8_B64 (base64 of the .p8).' };
  const ELEVATE = `Apple App Store Connect API key ${ASC_KID} needs the ADMIN role to read Analytics Reports. Elevate it (or create a new Admin key) — App Store Connect → Users and Access → Integrations → App Store Connect API.`;
  let list = await ascApiJson('GET', `/v1/apps/${APPLE_APP_ID}/analyticsReportRequests?limit=20`);
  if (list.status === 401 || list.status === 403) return { configured: false, reason: ELEVATE };
  if (list.status === 0) return { configured: false, reason: 'Apple API request failed (network).' };
  let requests = ((list.json && list.json.data) || []).filter((r) => r.attributes && !r.attributes.stoppedDueToInactivity);
  if (!requests.length) {
    const created = await ascApiJson('POST', '/v1/analyticsReportRequests', { data: { type: 'analyticsReportRequests', attributes: { accessType: 'ONGOING' }, relationships: { app: { data: { type: 'apps', id: APPLE_APP_ID } } } } });
    if (created.status === 401 || created.status === 403) return { configured: false, reason: ELEVATE };
    if (created.json && created.json.data) requests.push(created.json.data);
    else return { configured: false, reason: `Could not create the Apple analytics report request (status ${created.status}).` };
  }
  // Prefer the one-time snapshot (carries history) over the ongoing feed.
  requests.sort((a, b) => ((b.attributes || {}).accessType === 'ONE_TIME_SNAPSHOT' ? 1 : 0) - ((a.attributes || {}).accessType === 'ONE_TIME_SNAPSHOT' ? 1 : 0));
  const pickDownloads = (reps) =>
    reps.find((r) => /^app downloads standard$/i.test((r.attributes || {}).name || '')) ||
    reps.find((r) => /app downloads/i.test((r.attributes || {}).name || '')) ||
    reps.find((r) => /^app store installation and deletion standard$/i.test((r.attributes || {}).name || ''));
  let dl = null, latest = null, segments = [];
  for (const r of requests) {
    const rr = await ascApiJson('GET', `/v1/analyticsReportRequests/${r.id}/reports?limit=200`);
    const cand = pickDownloads((rr.json && rr.json.data) || []);
    if (!cand) continue;
    if (!dl) dl = cand;
    const inst = await ascApiJson('GET', `/v1/analyticsReports/${cand.id}/instances?filter[granularity]=DAILY&limit=60`);
    const instances = ((inst.json && inst.json.data) || []).sort((a, b) => String((b.attributes || {}).processingDate || '').localeCompare(String((a.attributes || {}).processingDate || '')));
    for (const i2 of instances) {
      const segResp = await ascApiJson('GET', `/v1/analyticsReportInstances/${i2.id}/segments`);
      const segs = (segResp.json && segResp.json.data) || [];
      if (segs.length) { dl = cand; latest = i2; segments = segs; break; }
    }
    if (segments.length) break;
  }
  if (!dl) return { configured: true, pending: true, note: 'Analytics enabled — Apple is generating the downloads report (typically within ~24–48h of enabling). Check back.' };
  if (!segments.length || !latest) return { configured: true, pending: true, report: (dl.attributes || {}).name, note: 'Downloads report requested — Apple has not generated the data yet (usually within ~1 day).' };
  let total = 0, firstTime = 0, redownloads = 0; const series = {};
  for (const seg of segments) {
    const url = (seg.attributes || {}).url; if (!url) continue;
    let csv; try { csv = await fetchUrlText(url); } catch { continue; }
    const lines = csv.split('\n').filter((l) => l.trim()); if (!lines.length) continue;
    const sep = lines[0].indexOf('\t') >= 0 ? '\t' : ',';
    const header = lines[0].split(sep).map((h) => h.replace(/^"|"$/g, '').trim());
    const iDate = header.findIndex((h) => /^date/i.test(h));
    const iCounts = header.findIndex((h) => /counts|quantity|units|downloads/i.test(h));
    const iType = header.findIndex((h) => /download type|type/i.test(h));
    if (iCounts < 0) continue;
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(sep);
      const n = parseInt(String(c[iCounts] || '0').replace(/[^0-9-]/g, ''), 10) || 0;
      total += n;
      const t = (iType >= 0 ? c[iType] : '').toLowerCase();
      if (/first/.test(t)) firstTime += n; else if (/re-?download/.test(t)) redownloads += n;
      const day = (iDate >= 0 ? (c[iDate] || '') : ((latest.attributes || {}).processingDate || '')).slice(0, 10);
      if (day) series[day] = (series[day] || 0) + n;
    }
  }
  const seriesArr = Object.keys(series).sort().map((d) => ({ date: d, downloads: series[d] })).slice(-30);
  return { configured: true, processingDate: (latest.attributes || {}).processingDate, report: (dl.attributes || {}).name, totalDownloads: total, firstTime, redownloads, series: seriesArr };
}

// ─── Google Play: install report from the Cloud Storage "Download reports" bucket ─────────────
async function googleInstalls({ month } = {}) {
  const sa = googleSA();
  if (!sa) return { configured: false, reason: 'Google service account not loaded. On prod set GOOGLE_PLAY_SA_B64 (base64 of the SA json).' };
  const bucket = (process.env.GOOGLE_PLAY_GCS_BUCKET || '').replace(/^gs:\/\//, '').replace(/\/.*$/, '').trim();
  if (!bucket) return { configured: false, reason: 'Set GOOGLE_PLAY_GCS_BUCKET (Play Console → Download reports → Statistics → "Copy Cloud Storage URI", the pubsite_prod_rev_… bucket), and grant the service account Storage Object Viewer on it.' };
  const ym = month || new Date().toISOString().slice(0, 7).replace('-', ''); // YYYYMM
  const object = `stats/installs/installs_${ANDROID_PACKAGE}_${ym}_overview.csv`;
  let google;
  try { google = require('googleapis').google; } catch { return { configured: false, reason: 'googleapis library unavailable.' }; }
  try {
    const auth = new google.auth.GoogleAuth({ credentials: sa, scopes: ['https://www.googleapis.com/auth/devstorage.read_only'] });
    const client = await auth.getClient();
    const storage = google.storage({ version: 'v1', auth: client });
    const resp = await storage.objects.get({ bucket, object, alt: 'media' }, { responseType: 'arraybuffer' });
    // Play install reports are UTF-16LE CSV.
    const csv = Buffer.from(resp.data).toString('utf16le');
    const rows = csv.split('\n').filter((l) => l.trim());
    const header = (rows[0] || '').split(',').map((h) => h.replace(/^"|"$/g, '').trim());
    const iDate = header.indexOf('Date');
    let iInstalls = header.findIndex((h) => /Daily Device Installs/i.test(h));
    if (iInstalls < 0) iInstalls = header.findIndex((h) => /Install events|Installs/i.test(h));
    const series = [];
    let total = 0;
    for (let i = 1; i < rows.length; i++) {
      const c = rows[i].split(',');
      const n = parseInt((c[iInstalls] || '0').replace(/[^0-9-]/g, ''), 10) || 0;
      total += n;
      series.push({ date: (c[iDate] || '').replace(/^"|"$/g, ''), installs: n });
    }
    return { configured: true, month: ym, totalInstalls: total, series: series.slice(-30) };
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/403|forbidden|permission/i.test(msg)) return { configured: false, reason: 'Google denied access to the report bucket — grant the service account (eas-submit@…) "Storage Object Viewer" on the pubsite_prod_rev_… bucket.' };
    if (/404|not found|No such object/i.test(msg)) return { configured: true, month: ym, totalInstalls: 0, series: [], note: 'No install report for this month yet (Play reports lag ~1–2 days).' };
    return { configured: false, reason: 'Google install report fetch failed: ' + msg.slice(0, 200) };
  }
}

// ─── Local DB rollup: our recorded transactions (Apple IAP + Razorpay) ────────────────────────
// Apple orders: order_id LIKE 'apple_%' (amount in USD). Razorpay: everything else (amount in INR).
async function localMonetization() {
  const out = { generatedAt: new Date().toISOString() };
  try {
    const platformCase = `CASE WHEN order_id LIKE 'apple_%' THEN 'apple' ELSE 'razorpay' END`;
    const byPlat = await dbConfig.query(
      `SELECT ${platformCase} AS platform, currency,
              COUNT(*)::int AS txns,
              COUNT(DISTINCT user_id)::int AS paying_users,
              COALESCE(SUM(amount),0) AS revenue
         FROM payment_orders
        WHERE status = 'completed' AND (deleted_at IS NULL)
        GROUP BY 1, 2`
    ).catch(() => []);
    out.byPlatform = byPlat || [];

    const windows = await dbConfig.get(
      `SELECT
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS last_24h,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int  AS last_7d,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int AS last_30d,
         COUNT(*)::int AS all_time
       FROM payment_orders WHERE status = 'completed' AND (deleted_at IS NULL)`
    ).catch(() => null);
    out.completedTxns = windows || {};

    out.recent = await dbConfig.query(
      `SELECT id, ${platformCase} AS platform, user_id, plan_id, amount, currency, status, created_at
         FROM payment_orders
        WHERE status = 'completed' AND (deleted_at IS NULL)
        ORDER BY created_at DESC LIMIT 15`
    ).catch(() => []);

    const credits = await dbConfig.get(
      `SELECT COALESCE(SUM(credits_change),0)::int AS credits_sold, COUNT(*)::int AS purchase_events
         FROM credit_transactions WHERE transaction_type = 'purchase'`
    ).catch(() => null);
    out.credits = credits || {};
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// Cache the SLOW store-API results (Apple = many sequential API calls, Google = GCS read) for 10
// min so the dashboard loads instantly and we don't hammer the stores on every refresh. The local
// DB rollup is cheap and always fetched fresh, so transactions stay live.
const _storeCache = new Map();
const STORE_TTL_MS = 10 * 60 * 1000;
async function getAnalytics(opts = {}) {
  const key = JSON.stringify({ a: (opts.apple && opts.apple.reportDate) || '', g: (opts.google && opts.google.month) || '' });
  let store = _storeCache.get(key);
  if (!store || (Date.now() - store.t) >= STORE_TTL_MS) {
    const [apple, google] = await Promise.all([
      appleAnalytics().catch((e) => ({ configured: false, reason: e.message })),
      googleInstalls(opts.google || {}).catch((e) => ({ configured: false, reason: e.message })),
    ]);
    store = { t: Date.now(), apple, google };
    _storeCache.set(key, store);
  }
  const local = await localMonetization();
  return { generatedAt: new Date().toISOString(), apple: store.apple, google: store.google, local, storeAsOf: new Date(store.t).toISOString() };
}

module.exports = { getAnalytics, appleAnalytics, appleSales, googleInstalls, localMonetization };
