// Admin Store Analytics — ADDITIVE, read-only. Surfaces Apple App Store + Google Play store data
// plus our recorded transactions. Admin-only (mounted behind authenticateAdmin).
const storeAnalytics = require('../services/storeAnalytics');
const liveAnalytics = require('../services/liveAnalytics');

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

module.exports = { getStoreAnalytics };
