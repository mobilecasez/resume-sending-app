// First-party real-time analytics — ADDITIVE. The app reports lightweight events (app_open,
// foreground, key actions) here; we aggregate them into a "live pulse" (active users right now,
// by platform, today's activity, recent feed) that bypasses the 1–3 day store-report delay.
// Append-only writes to app_events; reads are admin-only (via the store-analytics endpoint).
// Store lifecycle (subscriptions/refunds/purchases) comes from store_notifications (webhooks);
// uninstalls are logged into app_events as event='uninstall' by the push-receipt detector.
const dbConfig = require('../../db-config');

async function trackEvent(e) {
  const event = String(e.event || '').trim().slice(0, 120);
  if (!event) return;
  const platform = e.platform ? String(e.platform).toLowerCase().slice(0, 20) : null;
  const appVersion = e.appVersion ? String(e.appVersion).slice(0, 40) : null;
  const anonId = e.anonId ? String(e.anonId).slice(0, 80) : null;
  const country = e.country ? String(e.country).slice(0, 4) : null;
  const userId = Number.isInteger(e.userId) ? e.userId : (parseInt(e.userId, 10) || null);
  let props = null;
  try { props = e.props ? JSON.stringify(e.props).slice(0, 2000) : null; } catch {}
  await dbConfig.run(
    `INSERT INTO app_events (user_id, anon_id, platform, event, props, app_version, country) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, anonId, platform, event, props, appVersion, country]
  ).catch(() => {});
}

// Log an uninstall (detected server-side via a stale push token). Keyed by user so it doesn't
// create a phantom "new install" device; carries the user's last-known platform when available.
async function recordUninstall({ userId = null, anonId = null, platform = null } = {}) {
  let plat = platform;
  if (!plat && userId) {
    const r = await dbConfig.get(
      `SELECT platform FROM app_events WHERE user_id = ? AND platform IS NOT NULL AND event <> 'uninstall'
         ORDER BY id DESC LIMIT 1`, [userId]).catch(() => null);
    plat = r && r.platform ? r.platform : null;
  }
  await dbConfig.run(
    `INSERT INTO app_events (user_id, anon_id, platform, event) VALUES (?, ?, ?, 'uninstall')`,
    [Number.isInteger(userId) ? userId : null, anonId || null, plat || null]
  ).catch(() => {});
}

const UID = `COALESCE(user_id::text, anon_id, 'anon')`;
const DEVICE = `COALESCE(anon_id, user_id::text)`;
const LIVE = `event <> 'uninstall'`; // exclude server-side uninstall rows from "activity"/"install" metrics

async function getLivePulse() {
  const out = {};
  try {
    const active = await dbConfig.query(
      `SELECT COALESCE(platform,'unknown') AS platform, COUNT(DISTINCT ${UID})::int AS users
         FROM app_events WHERE created_at > NOW() - INTERVAL '30 minutes' AND ${LIVE} GROUP BY 1 ORDER BY users DESC`).catch(() => []);
    out.activeNow = { total: (active || []).reduce((s, r) => s + (r.users || 0), 0), byPlatform: active || [] };

    const dau = await dbConfig.query(
      `SELECT COALESCE(platform,'unknown') AS platform, COUNT(DISTINCT ${UID})::int AS users
         FROM app_events WHERE created_at > NOW() - INTERVAL '24 hours' AND ${LIVE} GROUP BY 1 ORDER BY users DESC`).catch(() => []);
    out.activeToday = { total: (dau || []).reduce((s, r) => s + (r.users || 0), 0), byPlatform: dau || [] };

    out.opens = await dbConfig.get(
      `SELECT COUNT(*) FILTER (WHERE event='app_open' AND created_at > NOW()-INTERVAL '1 hour')::int AS last_hour,
              COUNT(*) FILTER (WHERE event='app_open' AND created_at > NOW()-INTERVAL '24 hours')::int AS last_24h,
              COUNT(DISTINCT ${UID})::int AS unique_24h
         FROM app_events WHERE created_at > NOW()-INTERVAL '24 hours' AND ${LIVE}`).catch(() => ({}));

    // LIVE installs — a device's first-ever event = a fresh install / first run (Firebase first_open).
    out.newInstalls = await dbConfig.get(
      `SELECT COUNT(*) FILTER (WHERE first_seen > NOW()-INTERVAL '1 hour')::int  AS last_hour,
              COUNT(*) FILTER (WHERE first_seen > NOW()-INTERVAL '24 hours')::int AS last_24h,
              COUNT(*) FILTER (WHERE first_seen > NOW()-INTERVAL '7 days')::int   AS last_7d,
              COUNT(*)::int AS all_time
         FROM (SELECT ${DEVICE} AS dev, MIN(created_at) AS first_seen
                 FROM app_events WHERE (anon_id IS NOT NULL OR user_id IS NOT NULL) AND ${LIVE} GROUP BY 1) t`).catch(() => ({}));
    out.newInstallsByPlatform = await dbConfig.query(
      `SELECT platform, COUNT(*)::int AS installs FROM (
         SELECT ${DEVICE} AS dev, MIN(created_at) AS first_seen,
                (ARRAY_AGG(platform ORDER BY created_at))[1] AS platform
           FROM app_events WHERE (anon_id IS NOT NULL OR user_id IS NOT NULL) AND ${LIVE} GROUP BY 1
       ) t WHERE first_seen > NOW()-INTERVAL '24 hours' GROUP BY platform ORDER BY installs DESC`).catch(() => []);

    // LIVE uninstalls — event='uninstall' rows (push-receipt DeviceNotRegistered).
    out.uninstalls = await dbConfig.get(
      `SELECT COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '1 hour')::int  AS last_hour,
              COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '24 hours')::int AS last_24h,
              COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '7 days')::int   AS last_7d,
              COUNT(*)::int AS all_time
         FROM app_events WHERE event='uninstall'`).catch(() => ({}));
    out.uninstallsByPlatform = await dbConfig.query(
      `SELECT COALESCE(platform,'unknown') AS platform, COUNT(*)::int AS uninstalls
         FROM app_events WHERE event='uninstall' AND created_at > NOW()-INTERVAL '24 hours' GROUP BY 1 ORDER BY uninstalls DESC`).catch(() => []);
    const ni = out.newInstalls || {}, un = out.uninstalls || {};
    out.netInstalls = {
      last_24h: (ni.last_24h || 0) - (un.last_24h || 0),
      last_7d: (ni.last_7d || 0) - (un.last_7d || 0),
      all_time: (ni.all_time || 0) - (un.all_time || 0),
    };

    out.topEvents = await dbConfig.query(
      `SELECT event, COUNT(*)::int AS n FROM app_events WHERE created_at > NOW()-INTERVAL '24 hours'
        GROUP BY event ORDER BY n DESC LIMIT 14`).catch(() => []);

    out.hourly = await dbConfig.query(
      `SELECT to_char(date_trunc('hour', created_at), 'MM-DD HH24:00') AS hour, COUNT(DISTINCT ${UID})::int AS users
         FROM app_events WHERE created_at > NOW()-INTERVAL '24 hours' AND ${LIVE}
        GROUP BY date_trunc('hour', created_at) ORDER BY date_trunc('hour', created_at)`).catch(() => []);

    // NOTE: db-config rewrites every '?' into a $N placeholder, so SQL string literals must NOT
    // contain '?'. Use 'Unknown'/'unknown' (not '??'/'?') or the literal becomes '$1$2'/'$1'.
    out.byCountry = await dbConfig.query(
      `SELECT NULLIF(country,'') AS country, COUNT(DISTINCT ${UID})::int AS users
         FROM app_events WHERE created_at > NOW()-INTERVAL '24 hours' AND ${LIVE} AND NULLIF(country,'') IS NOT NULL
        GROUP BY 1 ORDER BY users DESC LIMIT 10`).catch(() => []);

    out.recent = await dbConfig.query(
      `SELECT event, COALESCE(platform,'unknown') AS platform, user_id, created_at
         FROM app_events ORDER BY id DESC LIMIT 25`).catch(() => []);

    // Live purchases today — payment_orders is written the instant a purchase is verified (truly live).
    out.purchasesToday = await dbConfig.query(
      `SELECT CASE WHEN order_id LIKE 'apple_%' THEN 'apple' ELSE 'razorpay' END AS platform, currency,
              COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS revenue
         FROM payment_orders WHERE status='completed' AND (deleted_at IS NULL) AND created_at > NOW()-INTERVAL '24 hours'
        GROUP BY 1,2`).catch(() => []);

    // Store lifecycle from webhooks (Apple App Store Server Notifications V2 + Google Play RTDN):
    // subscriptions / refunds / purchases, by store + clean event, over 24h / 7d / all-time.
    out.lifecycle = {
      events: await dbConfig.query(
        `SELECT store, COALESCE(event, notification_type, 'other') AS event,
                COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '24 hours')::int AS d1,
                COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '7 days')::int  AS d7,
                COUNT(*)::int AS all_time
           FROM store_notifications GROUP BY store, COALESCE(event, notification_type, 'other')
          ORDER BY all_time DESC`).catch(() => []),
      refunds: await dbConfig.get(
        `SELECT COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '24 hours')::int AS d1,
                COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '7 days')::int  AS d7,
                COUNT(*)::int AS all_time
           FROM store_notifications WHERE event IN ('refund','refund_reversed')`).catch(() => ({})),
    };
    // Net subscriptions estimate from the event log (the app currently sells one-time credits, so
    // this stays 0 until subscription products exist — the plumbing logs everything regardless).
    out.lifecycle.subsNetEst = (await dbConfig.get(
      `SELECT (COUNT(*) FILTER (WHERE event IN ('subscription_started','subscription_reactivated'))
             - COUNT(*) FILTER (WHERE event IN ('subscription_expired','subscription_revoked')))::int AS n
         FROM store_notifications`).catch(() => ({ n: 0 }))).n;

    // App opens by platform (today) — platform-aware metric card.
    out.opensByPlatform = await dbConfig.query(
      `SELECT COALESCE(platform,'unknown') AS platform, COUNT(*)::int AS opens
         FROM app_events WHERE event='app_open' AND created_at > NOW()-INTERVAL '24 hours' GROUP BY 1 ORDER BY opens DESC`).catch(() => []);

    // Day-over-day deltas (last 24h vs the prior 24h) for the metric cards.
    const prevInstalls = (await dbConfig.get(
      `SELECT COUNT(*)::int n FROM (SELECT ${DEVICE} dev, MIN(created_at) fs FROM app_events
         WHERE ${LIVE} AND (anon_id IS NOT NULL OR user_id IS NOT NULL) GROUP BY 1) t
        WHERE fs BETWEEN NOW()-INTERVAL '48 hours' AND NOW()-INTERVAL '24 hours'`).catch(() => ({ n: 0 }))).n;
    const prevUninstalls = (await dbConfig.get(
      `SELECT COUNT(*)::int n FROM app_events WHERE event='uninstall' AND created_at BETWEEN NOW()-INTERVAL '48 hours' AND NOW()-INTERVAL '24 hours'`).catch(() => ({ n: 0 }))).n;
    const prevOpens = (await dbConfig.get(
      `SELECT COUNT(*)::int n FROM app_events WHERE event='app_open' AND created_at BETWEEN NOW()-INTERVAL '48 hours' AND NOW()-INTERVAL '24 hours'`).catch(() => ({ n: 0 }))).n;
    const prevActive = (await dbConfig.get(
      `SELECT COUNT(DISTINCT ${UID})::int n FROM app_events WHERE ${LIVE} AND created_at BETWEEN NOW()-INTERVAL '48 hours' AND NOW()-INTERVAL '24 hours'`).catch(() => ({ n: 0 }))).n;
    const pct = (now, prev) => (prev > 0 ? Math.round(((now - prev) / prev) * 1000) / 10 : (now > 0 ? 100 : 0));
    out.deltas = {
      installs: pct(out.newInstalls && out.newInstalls.last_24h || 0, prevInstalls),
      uninstalls: pct(out.uninstalls && out.uninstalls.last_24h || 0, prevUninstalls),
      opens: pct(out.opens && out.opens.last_24h || 0, prevOpens),
      active: pct(out.activeToday && out.activeToday.total || 0, prevActive),
    };

    // Top app versions (last 30 days, distinct devices), split by platform.
    out.byVersion = await dbConfig.query(
      `SELECT COALESCE(app_version,'unknown') AS version,
              COUNT(DISTINCT ${DEVICE})::int AS total,
              COUNT(DISTINCT ${DEVICE}) FILTER (WHERE platform='ios')::int AS ios,
              COUNT(DISTINCT ${DEVICE}) FILTER (WHERE platform='android')::int AS android
         FROM app_events WHERE created_at > NOW()-INTERVAL '30 days' AND ${LIVE}
        GROUP BY 1 ORDER BY total DESC LIMIT 6`).catch(() => []);

    // Daily series (90d) for the range selector — summable metrics per platform.
    out.series = await buildSeries();

    out.storeNotifications = await dbConfig.query(
      `SELECT store, notification_type, subtype, event, product_id, price, currency, environment, created_at
         FROM store_notifications ORDER BY id DESC LIMIT 20`).catch(() => []);

    out.totalEvents = (await dbConfig.get(`SELECT COUNT(*)::int c FROM app_events`).catch(() => ({ c: 0 }))).c;
  } catch (e) { out.error = e.message; }
  return out;
}

// Daily series for the last 90 days — installs/uninstalls/opens/purchases/revenue per platform.
// The client sums the tail for each range (24h/7d/30d/90d/all). Returned as a flat array.
async function buildSeries() {
  const map = new Map();
  const bump = (d, p, f, v) => {
    const k = d + '|' + p;
    if (!map.has(k)) map.set(k, { day: d, platform: p, installs: 0, uninstalls: 0, opens: 0, purchases: 0, revenue: 0 });
    map.get(k)[f] += v;
  };
  const ev = await dbConfig.query(
    `SELECT to_char(date_trunc('day',created_at),'YYYY-MM-DD') d, COALESCE(platform,'unknown') p,
            COUNT(*) FILTER (WHERE event='app_open')::int opens,
            COUNT(*) FILTER (WHERE event='uninstall')::int uninstalls
       FROM app_events WHERE created_at > NOW()-INTERVAL '90 days' GROUP BY 1,2`).catch(() => []);
  ev.forEach((r) => { bump(r.d, r.p, 'opens', r.opens || 0); bump(r.d, r.p, 'uninstalls', r.uninstalls || 0); });
  const ins = await dbConfig.query(
    `SELECT to_char(fs::date,'YYYY-MM-DD') d, COALESCE(p,'unknown') p, COUNT(*)::int installs FROM (
       SELECT ${DEVICE} dev, MIN(created_at) fs, (ARRAY_AGG(platform ORDER BY created_at))[1] p
         FROM app_events WHERE ${LIVE} AND (anon_id IS NOT NULL OR user_id IS NOT NULL) GROUP BY 1
     ) t WHERE fs > NOW()-INTERVAL '90 days' GROUP BY 1,2`).catch(() => []);
  ins.forEach((r) => bump(r.d, r.p, 'installs', r.installs || 0));
  const pay = await dbConfig.query(
    `SELECT to_char(date_trunc('day',created_at),'YYYY-MM-DD') d,
            CASE WHEN order_id LIKE 'apple_%' THEN 'ios' ELSE 'android' END p,
            COUNT(*)::int purchases, COALESCE(SUM(amount),0)::float revenue
       FROM payment_orders WHERE status='completed' AND (deleted_at IS NULL) AND created_at > NOW()-INTERVAL '90 days' GROUP BY 1,2`).catch(() => []);
  pay.forEach((r) => { bump(r.d, r.p, 'purchases', r.purchases || 0); bump(r.d, r.p, 'revenue', Number(r.revenue) || 0); });
  return Array.from(map.values());
}

async function recordStoreNotification(d) {
  const price = (d.price != null && !isNaN(Number(d.price))) ? Number(d.price) : null;
  await dbConfig.run(
    `INSERT INTO store_notifications
       (store, notification_type, subtype, event, transaction_id, original_transaction_id, product_id, price, currency, environment, user_id, dedupe_key, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [
      d.store, d.notificationType || null, d.subtype || null, d.event || null,
      d.transactionId || null, d.originalTransactionId || null, d.productId || null,
      price, d.currency || null, d.environment || null,
      Number.isInteger(d.userId) ? d.userId : null, d.dedupeKey || null,
      d.payload ? JSON.stringify(d.payload).slice(0, 8000) : null,
    ]
  ).catch(() => {});
}

// ── Per-user behavior drill-down (admin) ───────────────────────────────────────────────────────
// List recent users with an activity summary, so the admin can pick one to inspect. Search by
// email/name. Anonymous (pre-login) devices are grouped under their anon_id.
async function getUserJourneys({ search = '', limit = 60 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 60, 1), 200);
  const term = String(search || '').trim().toLowerCase().slice(0, 80);
  const rows = await dbConfig.query(
    `SELECT ${UID} AS uid,
            MAX(ae.user_id) AS user_id,
            MIN(ae.created_at) AS first_seen,
            MAX(ae.created_at) AS last_seen,
            COUNT(*)::int AS events,
            COUNT(*) FILTER (WHERE ae.event='signup')::int AS signups,
            (ARRAY_AGG(ae.platform) FILTER (WHERE ae.platform IS NOT NULL))[1] AS platform,
            (ARRAY_AGG(ae.country)  FILTER (WHERE ae.country IS NOT NULL))[1]  AS country,
            (ARRAY_AGG(ae.props->>'provider' ORDER BY ae.id) FILTER (WHERE ae.event IN ('signup','login')))[1] AS provider,
            u.email, u.full_name
       FROM app_events ae
       LEFT JOIN users u ON u.id = ae.user_id
      WHERE ($1 = '' OR LOWER(u.email) LIKE '%'||$1||'%' OR LOWER(u.full_name) LIKE '%'||$1||'%')
      GROUP BY ${UID}, u.email, u.full_name
      ORDER BY MAX(ae.created_at) DESC
      LIMIT ${limit}`,
    [term]
  ).catch((e) => { console.error('[analytics] getUserJourneys:', e.message); return []; });
  return { users: rows };
}

// Full event stream for one user (by numeric user_id) OR one anonymous device (by anon_id),
// newest last, plus a compact per-event-type rollup and any store lifecycle events.
async function getUserTimeline({ userId = null, anonId = null, limit = 500 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 2000);
  const isUser = userId != null && String(userId).trim() !== '';
  const key = isUser ? (parseInt(userId, 10) || 0) : String(anonId || '').slice(0, 80);
  const where = isUser ? 'user_id = $1' : 'anon_id = $1';
  const profile = isUser
    ? await dbConfig.get(`SELECT id, full_name, email, created_at, oauth_provider,
           (resume_path IS NOT NULL) AS has_resume, (photo_path IS NOT NULL) AS has_photo,
           (signature_path IS NOT NULL) AS has_signature FROM users WHERE id = ?`, [key]).catch(() => null)
    : null;
  const events = await dbConfig.query(
    `SELECT id, event, props, platform, app_version, country, created_at
       FROM app_events WHERE ${where} ORDER BY id DESC LIMIT ${limit}`, [key]
  ).catch(() => []);
  const rollup = await dbConfig.query(
    `SELECT event, COUNT(*)::int n, MAX(created_at) last FROM app_events WHERE ${where} GROUP BY event ORDER BY n DESC`, [key]
  ).catch(() => []);
  const purchases = isUser
    ? await dbConfig.query(
        `SELECT store, event, product_id, price, currency, created_at FROM store_notifications
          WHERE user_id = ? ORDER BY id DESC LIMIT 40`, [key]).catch(() => [])
    : [];
  return { profile, events: events.reverse(), rollup, purchases };
}

// ── Date-range analytics (admin) ─────────────────────────────────────────────────────────────
// Re-aggregates the app_events metrics over an ARBITRARY [from, to] window (inclusive of both
// days) — the Live Pulse windows are all fixed to NOW()-24h, so this powers the date-range picker.
// from/to are 'YYYY-MM-DD' strings. Installs use per-device first_seen so a device counts once.
async function getRangeAnalytics(fromDate, toDate) {
  const norm = (s) => (String(s || '').match(/^\d{4}-\d{2}-\d{2}/) || [])[0] || null;
  let from = norm(fromDate), to = norm(toDate);
  if (!from || !to) { const t = new Date(); const d = (x) => x.toISOString().slice(0, 10);
    to = d(t); from = d(new Date(t.getTime() - 6 * 864e5)); }             // default: last 7 days
  if (from > to) { const t = from; from = to; to = t; }
  const fromTs = `${from} 00:00:00`, toTs = `${to} 23:59:59.999`;
  const P = [fromTs, toTs];
  const out = { range: { from, to } };
  try {
    const q1 = await dbConfig.get(
      `SELECT COUNT(*) FILTER (WHERE event='app_open')::int opens,
              COUNT(DISTINCT ${UID}) FILTER (WHERE event='app_open')::int open_users,
              COUNT(DISTINCT ${UID}) FILTER (WHERE ${LIVE})::int active_users,
              COUNT(DISTINCT ${DEVICE})::int devices,
              COUNT(*) FILTER (WHERE event='signup')::int signups,
              COUNT(*) FILTER (WHERE event='login')::int logins,
              COUNT(*) FILTER (WHERE event='uninstall')::int uninstalls,
              COUNT(*)::int total_events
         FROM app_events WHERE created_at >= ? AND created_at <= ?`, P).catch(() => ({}));
    out.opens = { total: q1.opens || 0, unique: q1.open_users || 0 };
    out.activeUsers = q1.active_users || 0;
    out.devices = q1.devices || 0;
    out.signups = q1.signups || 0;
    out.logins = q1.logins || 0;
    out.uninstalls = q1.uninstalls || 0;
    out.totalEvents = q1.total_events || 0;

    // Installs: a device counts as installed in-window only if its FIRST-EVER event lands in range.
    out.installs = (await dbConfig.get(
      `SELECT COUNT(*)::int n FROM (
         SELECT ${DEVICE} dev, MIN(created_at) fs FROM app_events
          WHERE ${LIVE} AND (anon_id IS NOT NULL OR user_id IS NOT NULL) GROUP BY 1
       ) t WHERE fs >= ? AND fs <= ?`, P).catch(() => ({ n: 0 }))).n || 0;

    out.activeByPlatform = await dbConfig.query(
      `SELECT COALESCE(platform,'unknown') platform, COUNT(DISTINCT ${UID})::int users
         FROM app_events WHERE created_at >= ? AND created_at <= ? AND ${LIVE}
        GROUP BY 1 ORDER BY users DESC`, P).catch(() => []);
    out.eventBreakdown = await dbConfig.query(
      `SELECT event, COUNT(*)::int n FROM app_events
         WHERE created_at >= ? AND created_at <= ? GROUP BY event ORDER BY n DESC LIMIT 30`, P).catch(() => []);
    out.byCountry = await dbConfig.query(
      `SELECT COALESCE(country,'—') country, COUNT(DISTINCT ${UID})::int users
         FROM app_events WHERE created_at >= ? AND created_at <= ? AND ${LIVE}
        GROUP BY 1 ORDER BY users DESC LIMIT 12`, P).catch(() => []);
    out.series = await dbConfig.query(
      `SELECT to_char(date_trunc('day',created_at),'YYYY-MM-DD') day,
              COUNT(DISTINCT ${UID})::int users,
              COUNT(*) FILTER (WHERE event='app_open')::int opens,
              COUNT(*) FILTER (WHERE event='signup')::int signups
         FROM app_events WHERE created_at >= ? AND created_at <= ?
        GROUP BY 1 ORDER BY 1`, P).catch(() => []);
    const pay = await dbConfig.get(
      `SELECT COUNT(*)::int n, COALESCE(SUM(amount),0)::float revenue
         FROM payment_orders WHERE status='completed' AND deleted_at IS NULL
           AND created_at >= ? AND created_at <= ?`, P).catch(() => ({ n: 0, revenue: 0 }));
    out.purchases = { count: pay.n || 0, revenue: Number(pay.revenue) || 0 };
  } catch (e) { out.error = e.message; }
  return out;
}

module.exports = { trackEvent, recordUninstall, getLivePulse, recordStoreNotification, getUserJourneys, getUserTimeline, getRangeAnalytics };
