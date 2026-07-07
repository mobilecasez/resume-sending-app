// Admin Store Analytics — ADDITIVE, read-only. Surfaces Apple App Store + Google Play store data
// plus our recorded transactions. Admin-only (mounted behind authenticateAdmin).
const storeAnalytics = require('../services/storeAnalytics');
const liveAnalytics = require('../services/liveAnalytics');
const uninstallDetection = require('../services/uninstallDetection');

async function getStoreAnalytics(req, res) {
  try {
    const apple = {};
    if (req.query.date) apple.reportDate = String(req.query.date).slice(0, 10);
    if (req.query.frequency) apple.frequency = String(req.query.frequency).toUpperCase();
    const google = {};
    if (req.query.month) google.month = String(req.query.month).replace(/[^0-9]/g, '').slice(0, 6);
    const [data, live] = await Promise.all([
      storeAnalytics.getAnalytics({ apple, google }),
      liveAnalytics.getLivePulse().catch((e) => ({ error: e.message })),
    ]);
    return res.json({ ...data, live });
  } catch (error) {
    console.error('[adminStoreAnalytics] error:', error.message);
    return res.status(500).json({ error: 'Failed to load store analytics' });
  }
}

// Admin-triggered uninstall sweep — sends a silent push to every stored token and logs an uninstall
// for each DeviceNotRegistered receipt. Runs synchronously (~8s for the receipt round-trip).
async function runUninstallSweep(req, res) {
  try {
    const result = await uninstallDetection.sweepUninstalls({ limit: 5000 });
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[uninstallSweep] error:', error.message);
    return res.status(500).json({ error: 'Uninstall sweep failed' });
  }
}

// Admin-only: recent users/devices with an activity summary (for the per-user drill-down page).
async function getUserJourneys(req, res) {
  try {
    const data = await liveAnalytics.getUserJourneys({ search: req.query.q || '', limit: req.query.limit });
    return res.json(data);
  } catch (error) {
    console.error('[userJourneys] error:', error.message);
    return res.status(500).json({ error: 'Failed to load user journeys' });
  }
}

// Admin-only: full event timeline for one user (?userId=) or anonymous device (?anonId=).
async function getUserTimeline(req, res) {
  try {
    const data = await liveAnalytics.getUserTimeline({ userId: req.query.userId || null, anonId: req.query.anonId || null, limit: req.query.limit });
    return res.json(data);
  } catch (error) {
    console.error('[userTimeline] error:', error.message);
    return res.status(500).json({ error: 'Failed to load user timeline' });
  }
}

module.exports = { getStoreAnalytics, runUninstallSweep, getUserJourneys, getUserTimeline };
