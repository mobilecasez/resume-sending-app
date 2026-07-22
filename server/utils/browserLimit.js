// Shared chromium launch limiter.
//
// WHY: resume/cover-letter previews were failing on Railway with
//   `browserType.launch: Failed to launch: Error: spawn chrome-headless-shell EAGAIN`.
// EAGAIN on spawn = the container can't fork another process — chromium spawns many threads, and when
// several instances launch at once (the job scraper + a preview render + a grounding call) the
// container's process/thread budget is exhausted. The scraper already caps itself; the renderers did
// NOT, so they launched on top of everything else. PDF downloads survived because they fall back to
// PDFKit; previews (screenshots) have no fallback, so they were the visible casualty.
//
// This bounds how many chromium instances start concurrently and RETRIES a transient spawn EAGAIN
// after a short backoff (by then an earlier browser has usually closed and freed the slot).

const MAX = Math.max(1, Number(process.env.CHROMIUM_MAX_CONCURRENT || 2));

let active = 0;
const waiters = [];

function acquire() {
  return new Promise((resolve) => {
    if (active < MAX) { active += 1; resolve(); }
    else waiters.push(resolve);
  });
}
function release() {
  const next = waiters.shift();
  if (next) next();            // hand the slot straight to the next waiter (active stays the same)
  else active = Math.max(0, active - 1);
}

const TRANSIENT = /EAGAIN|ETXTBSY|spawn|Resource temporarily unavailable|Target closed|Failed to launch/i;

// Launch chromium through the limiter. Returns a browser whose .close() also frees the slot exactly
// once, so existing `try { … } finally { browser.close() }` call sites need no other change.
async function launchChromium(chromium, opts = {}, tries = 4) {
  await acquire();
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    try {
      const browser = await chromium.launch(opts);
      const origClose = browser.close.bind(browser);
      let released = false;
      browser.close = async () => {
        try { await origClose(); } finally { if (!released) { released = true; release(); } }
      };
      return browser;
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);
      if (i < tries - 1 && TRANSIENT.test(msg)) {
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));   // 0.4s, 0.8s, 1.2s …
        continue;
      }
      release();                // give the slot back — we're done trying
      throw e;
    }
  }
  release();
  throw lastErr;
}

module.exports = { launchChromium };
