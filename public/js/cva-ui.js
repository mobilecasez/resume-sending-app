/* ──────────────────────────────────────────────────────────────────────────
   cva-ui.js — shared desktop helpers, ported from the mobile app.
   Exposes window.CVA: { apiFetch, pollJob, REGION_OPTIONS, RESUME_REGION_OPTIONS,
   regionFromCountry, regionLabel, creditGuard, progressButton, segmented,
   lightbox, toast }.  Pair with css/cva-ui.css.
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── Auth-aware fetch (mirrors the mobile Bearer pattern; 401/403 → /login) ──
  async function apiFetch(path, opts) {
    opts = opts || {};
    const token = localStorage.getItem('authToken');
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {},
      opts.headers || {}
    );
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    if (res.status === 401 || res.status === 403) {
      try { localStorage.removeItem('authToken'); } catch (e) {}
      window.location.href = '/login';
      throw new Error('Unauthorized');
    }
    return res;
  }

  // ── Async-job poller (mirrors the mobile pollUntilDone) ──
  // jobId from a 202 response. `poller` = '/api/job-status' (env-gated routes)
  // OR '/api/ai-hub/job-status' (opt-in __async routes). Resolves with data, rejects on failure.
  function pollJob(jobId, opts) {
    opts = opts || {};
    const base = opts.poller || '/api/job-status';
    const interval = opts.interval || 2000;
    const onProgress = opts.onProgress;
    const maxAttempts = opts.maxAttempts || 600; // ~20 min ceiling
    let attempts = 0;
    return new Promise(function (resolve, reject) {
      function tick() {
        apiFetch(base + '/' + jobId, { method: 'GET' })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
          .then(function (x) {
            var d = x.d || {};
            if (d.status === 'completed') { resolve(d.data); return; }
            if (d.status === 'failed')    { reject(new Error(d.error || 'Job failed')); return; }
            if (!x.ok)                    { reject(new Error(d.error || ('Request failed (' + x.status + ')'))); return; }
            if (onProgress) { try { onProgress(d); } catch (e) {} }
            if (++attempts > maxAttempts) { reject(new Error('This is taking too long — please try again.')); return; }
            setTimeout(tick, interval);
          })
          .catch(function () { setTimeout(tick, interval); }); // transient network error → retry
      }
      tick();
    });
  }

  // POST that opts into the server's async mode and polls. For __async routes use poller '/api/ai-hub/job-status'.
  async function postAndPoll(path, body, opts) {
    opts = opts || {};
    const res = await apiFetch(path, { method: 'POST', body: JSON.stringify(Object.assign({}, body || {}, { __async: true })) });
    const data = await res.json().catch(function () { return {}; });
    if (data && data.jobId) return pollJob(data.jobId, { poller: opts.poller || '/api/ai-hub/job-status', onProgress: opts.onProgress });
    if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
    return data;
  }

  // ── Region helpers (verbatim port of MobileApp/regionUtils.js) ──
  function regionFromCountry(text) {
    const s = (text || '').toLowerCase();
    if (!s.trim()) return 'generic';
    const has = function () { var k = [].slice.call(arguments); return k.some(function (x) { return s.indexOf(x) >= 0; }); };
    if (has('united states', 'usa', 'u.s.a', 'u.s.', 'america', 'canada', 'toronto', 'vancouver',
            'new york', 'san francisco', 'california', 'texas', 'seattle', 'boston') || /\bus\b/.test(s)) return 'us_ca';
    if (has('united kingdom', 'england', 'scotland', 'wales', 'britain', 'london', 'manchester',
            'australia', 'sydney', 'melbourne', 'brisbane', 'new zealand', 'auckland') || /\buk\b/.test(s)) return 'uk_au';
    if (has('india', 'bangalore', 'bengaluru', 'mumbai', 'delhi', 'hyderabad', 'pune', 'chennai',
            'gurugram', 'gurgaon', 'noida', 'kolkata', 'ahmedabad', 'bangladesh', 'nepal', 'sri lanka', 'pakistan')) return 'india';
    if (has('germany', 'deutschland', 'berlin', 'munich', 'münchen', 'frankfurt', 'hamburg', 'cologne', 'stuttgart',
            'austria', 'österreich', 'vienna', 'wien', 'switzerland', 'zurich', 'zürich', 'geneva', 'basel')) return 'dach';
    if (has('france', 'paris', 'spain', 'madrid', 'barcelona', 'italy', 'rome', 'milan', 'milano',
            'netherlands', 'amsterdam', 'belgium', 'brussels', 'ireland', 'dublin', 'portugal', 'lisbon',
            'sweden', 'stockholm', 'poland', 'warsaw', 'denmark', 'norway', 'finland', 'europe')) return 'eu';
    if (has('singapore')) return 'sg';
    return 'generic';
  }
  const REGION_OPTIONS = [
    { id: 'generic', label: 'Generic',            sub: 'Original · any country' },
    { id: 'us_ca',   label: 'USA / Canada',       sub: 'Direct, achievement-based' },
    { id: 'uk_au',   label: 'UK / Australia',     sub: 'Professional, respectful' },
    { id: 'india',   label: 'India / South Asia', sub: 'Skills & projects' },
    { id: 'dach',    label: 'Germany / DACH',     sub: 'Formal, qualification-led' },
    { id: 'eu',      label: 'Europe / EU',        sub: 'Motivation & fit' },
    { id: 'sg',      label: 'Singapore',          sub: 'Corporate, concise' },
    { id: 'global',  label: 'Global / Entry',     sub: 'Graduate & entry-level' }
  ];
  const RESUME_REGION_OPTIONS = REGION_OPTIONS.filter(function (r) { return r.id !== 'global'; });
  function regionLabel(id) { return (REGION_OPTIONS.find(function (r) { return r.id === id; }) || REGION_OPTIONS[0]).label; }

  // ── Credits ── authoritative balance from /api/user/credits (handles expiry)
  async function getCredits() {
    try { const r = await apiFetch('/api/user/credits', { method: 'GET' }); const d = await r.json(); return (d && typeof d.balance === 'number') ? d.balance : 0; }
    catch (e) { return 0; }
  }
  // Run `fn` only if the user has >= cost credits; otherwise toast + return false.
  async function creditGuard(cost, fn) {
    const bal = await getCredits();
    if (bal < cost) { toast('Not enough credits — you need ' + cost + '.'); return false; }
    return fn();
  }

  // ── Progress-in-button helper ──
  // el = a .cva-btn-primary. Returns { start(label), set(pct,label), done(label), reset(idleHTML) }.
  function progressButton(el) {
    const idleHTML = el.innerHTML;
    function render(state, pct, label) {
      el.classList.remove('is-loading', 'is-done');
      if (state === 'loading') {
        el.classList.add('is-loading'); el.disabled = true;
        el.innerHTML =
          '<span class="cva-fill" style="width:' + (pct || 0) + '%"></span>' +
          '<span class="cva-shimmer"></span>' +
          '<span class="cva-ring"></span>' +
          '<span class="cva-label">' + (label || 'Working…') + '</span>' +
          '<span class="cva-pct">' + Math.round(pct || 0) + '%</span>';
      } else if (state === 'done') {
        el.classList.add('is-done'); el.disabled = true;
        el.innerHTML = '<span class="cva-label">✓ ' + (label || 'Done') + '</span>';
      } else {
        el.disabled = false; el.innerHTML = idleHTML;
      }
    }
    return {
      start: function (label) { render('loading', 0, label); },
      set:   function (pct, label) {
        var fill = el.querySelector('.cva-fill'); var p = el.querySelector('.cva-pct'); var l = el.querySelector('.cva-label');
        if (fill) fill.style.width = pct + '%'; if (p) p.textContent = Math.round(pct) + '%'; if (l && label) l.textContent = label;
      },
      done:  function (label) { render('done', 100, label); },
      reset: function () { render('idle'); }
    };
  }

  // ── Segmented control wiring (e.g. gender). groupEl has buttons[data-value];
  //    writes the chosen value to hiddenInput; tap-again clears. Returns current value. ──
  function segmented(groupEl, hiddenInput, opts) {
    opts = opts || {};
    function select(val) {
      hiddenInput.value = val || '';
      Array.prototype.forEach.call(groupEl.querySelectorAll('[data-value]'), function (b) {
        b.classList.toggle('selected', b.getAttribute('data-value') === val && !!val);
      });
      if (opts.onChange) opts.onChange(hiddenInput.value);
    }
    Array.prototype.forEach.call(groupEl.querySelectorAll('[data-value]'), function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-value');
        select(hiddenInput.value === v ? '' : v); // toggle off if re-tapped
      });
    });
    return { select: select, get: function () { return hiddenInput.value; } };
  }

  // ── Lightbox (image preview overlay) ──
  function lightbox(imgSrc, title) {
    var box = document.getElementById('cva-lightbox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'cva-lightbox'; box.className = 'cva-lightbox';
      box.innerHTML = '<button class="cva-lightbox-close" aria-label="Close">×</button><div class="cva-lightbox-inner"><img alt="preview"></div>';
      document.body.appendChild(box);
      box.querySelector('.cva-lightbox-close').addEventListener('click', function () { box.classList.remove('open'); });
      box.addEventListener('click', function (e) { if (e.target === box) box.classList.remove('open'); });
    }
    box.querySelector('img').src = imgSrc;
    box.classList.add('open');
  }

  // ── Toast ──
  let toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('cva-toast');
    if (!t) { t = document.createElement('div'); t.id = 'cva-toast'; t.className = 'cva-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }

  window.CVA = {
    apiFetch: apiFetch, pollJob: pollJob, postAndPoll: postAndPoll,
    regionFromCountry: regionFromCountry, REGION_OPTIONS: REGION_OPTIONS,
    RESUME_REGION_OPTIONS: RESUME_REGION_OPTIONS, regionLabel: regionLabel,
    getCredits: getCredits, creditGuard: creditGuard,
    progressButton: progressButton, segmented: segmented, lightbox: lightbox, toast: toast
  };
})();
