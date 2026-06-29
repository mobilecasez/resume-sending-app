// First-party real-time analytics — ADDITIVE. The app reports lightweight events (app_open,
// foreground, key actions) here; we aggregate them into a "live pulse" (active users right now,
// by platform, today's activity, recent feed) that bypasses the 1–3 day store-report delay.
// Append-only writes to app_events; reads are admin-only (via the store-analytics endpoint).
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

const UID = `COALESCE(user_id::text, anon_id, 'anon')`;

async function getLivePulse() {
  const out = {};
  try {
    const active = await dbConfig.query(
      `SELECT COALESCE(platform,'unknown') AS platform, COUNT(DISTINCT ${UID})::int AS users
         FROM app_events WHERE created_at > NOW() - INTERVAL '30 minutes' GROUP BY 1 ORDER BY users DESC`).catch(() => []);
    out.activeNow = { total: (active || []).reduce((s, r) => s + (r.users || 0), 0), byPlatform: active || [] };

    const dau = await dbConfig.query(
      `SELECT COALESCE(platform,'unknown') AS platform, COUNT(DISTINCT ${UID})::int AS users
         FROM app_events WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY 1 ORDER BY users DESC`).catch(() => []);
    out.activeToday = { total: (dau || []).reduce((s, r) => s + (r.users || 0), 0), byPlatform: dau || [] };

    out.opens = await dbConfig.get(
      `SELECT COUNT(*) FILTER (WHERE event='app_open' AND created_at > NOW()-INTERVAL '1 hour')::int AS last_hour,
              COUNT(*) FILTER (WHERE event='app_open' AND created_at > NOW()-INTERVAL '24 hours')::int AS last_24h,
              COUNT(DISTINCT ${UID})::int AS unique_24h
         FROM app_events WHERE created_at > NOW()-INTERVAL '24 hours'`).catch(() => ({}));

    // LIVE installs — a device's first-ever event = a fresh install / first run (Firebase's
    // "first_open" equivalent). This is the real-time download signal Apple/Google never expose.
    out.newInstalls = await dbConfig.get(
      `SELECT COUNT(*) FILTER (WHERE first_seen > NOW()-INTERVAL '1 hour')::int  AS last_hour,
              COUNT(*) FILTER (WHERE first_seen > NOW()-INTERVAL '24 hours')::int AS last_24h,
              COUNT(*) FILTER (WHERE first_seen > NOW()-INTERVAL '7 days')::int   AS last_7d,
              COUNT(*)::int AS all_time
         FROM (SELECT COALESCE(anon_id, user_id::text) AS dev, MIN(created_at) AS first_seen
                 FROM app_events WHERE anon_id IS NOT NULL OR user_id IS NOT NULL GROUP BY 1) t`).catch(() => ({}));
    out.newInstallsByPlatform = await dbConfig.query(
      `SELECT platform, COUNT(*)::int AS installs FROM (
         SELECT COALESCE(anon_id, user_id::text) AS dev, MIN(created_at) AS first_seen,
                (ARRAY_AGG(platform ORDER BY created_at))[1] AS platform
           FROM app_events WHERE anon_id IS NOT NULL OR user_id IS NOT NULL GROUP BY 1
       ) t WHERE first_seen > NOW()-INTERVAL '24 hours' GROUP BY platform ORDER BY installs DESC`).catch(() => []);

    out.topEvents = await dbConfig.query(
      `SELECT event, COUNT(*)::int AS n FROM app_events WHERE created_at > NOW()-INTERVAL '24 hours'
        GROUP BY event ORDER BY n DESC LIMIT 14`).catch(() => []);

    out.hourly = await dbConfig.query(
      `SELECT to_char(date_trunc('hour', created_at), 'MM-DD HH24:00') AS hour, COUNT(DISTINCT ${UID})::int AS users
         FROM app_events WHERE created_at > NOW()-INTERVAL '24 hours'
        GROUP BY date_trunc('hour', created_at) ORDER BY date_trunc('hour', created_at)`).catch(() => []);

    out.byCountry = await dbConfig.query(
      `SELECT COALESCE(NULLIF(country,''),'??') AS country, COUNT(DISTINCT ${UID})::int AS users
         FROM app_events WHERE created_at > NOW()-INTERVAL '24 hours' GROUP BY 1 ORDER BY users DESC LIMIT 10`).catch(() => []);

    out.recent = await dbConfig.query(
      `SELECT event, COALESCE(platform,'?') AS platform, user_id, created_at
         FROM app_events ORDER BY id DESC LIMIT 25`).catch(() => []);

    // Live purchases today — payment_orders is written the instant a purchase is verified (truly live).
    out.purchasesToday = await dbConfig.query(
      `SELECT CASE WHEN order_id LIKE 'apple_%' THEN 'apple' ELSE 'razorpay' END AS platform, currency,
              COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS revenue
         FROM payment_orders WHERE status='completed' AND (deleted_at IS NULL) AND created_at > NOW()-INTERVAL '24 hours'
        GROUP BY 1,2`).catch(() => []);

    // Server-to-server purchase/refund notifications (Apple V2 + Google RTDN), once configured.
    out.storeNotifications = await dbConfig.query(
      `SELECT store, notification_type, subtype, product_id, created_at
         FROM store_notifications ORDER BY id DESC LIMIT 15`).catch(() => []);

    out.totalEvents = (await dbConfig.get(`SELECT COUNT(*)::int c FROM app_events`).catch(() => ({ c: 0 }))).c;
  } catch (e) { out.error = e.message; }
  return out;
}

async function recordStoreNotification(d) {
  await dbConfig.run(
    `INSERT INTO store_notifications (store, notification_type, subtype, transaction_id, original_transaction_id, product_id, user_id, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.store, d.notificationType || null, d.subtype || null, d.transactionId || null, d.originalTransactionId || null, d.productId || null, Number.isInteger(d.userId) ? d.userId : null, d.payload ? JSON.stringify(d.payload).slice(0, 8000) : null]
  ).catch(() => {});
}

module.exports = { trackEvent, getLivePulse, recordStoreNotification };
