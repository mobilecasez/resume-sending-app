// Tiny helper to emit a first-party analytics event from an authenticated request context.
// ADDITIVE + best-effort: never throws, never blocks the response. Server-side events work
// regardless of app version (they fire on the already-installed app), and always carry user_id.
const live = require('./liveAnalytics');

function emit(req, event, props = {}) {
  try {
    live.trackEvent({
      event,
      userId: (req && req.user && req.user.id) || null,
      platform: (req && (req.headers['x-client-platform'] || (req.body && req.body.platform))) || null,
      appVersion: (req && (req.headers['x-app-version'] || (req.body && req.body.appVersion))) || null,
      country: (req && (req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-appengine-country'])) || null,
      props: props || {},
    }).catch(() => {});
  } catch (_) { /* analytics must never break the request */ }
}

module.exports = { emit };
