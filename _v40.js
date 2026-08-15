// Create/prepare App Store version 3.9, set What's New, attach build 167, and (with SUBMIT=1) send
// it for review.
//
// ⚠️ SUBMIT=1 IS THE IRREVERSIBLE STEP and it also CLOSES THE 3.9 TRAIN — no further build can be
// uploaded under 3.9 afterwards (ITMS 90186). Run without it first and read the state back.
const { req, get, retry, APP } = require('./_asc37.js');

const VERSION = '4.0';
const WANT_BUILD = process.env.MIN_BUILD || '168';
const SUBMIT = process.env.SUBMIT === '1';

const WHATS_NEW = "Nothing fails silently any more.\n\n• When our AI service is briefly unavailable, Fetch job now says so instead of quietly saving a job with no details, and Translate explains itself rather than just failing.\n• Translate now tells you when a page is already in English — and an English page no longer switches translation off for every job you open afterwards.\n• Fetch job works on a job you already saved, and a fetch that failed can be retried.\n• Sign-in that needs a pop-up window (Google on some job sites) can't work inside any app, so we now say so up front and offer to open the job in your browser — instead of leaving you on a blank page with your half-filled form gone.\n• Passkey and Face ID sign-in: same story. We now tell you immediately and let the site offer its password option, instead of a button that spins forever.\n• The Job tools robot can no longer be dragged off the screen.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`notes ${WHATS_NEW.length} chars (limit 4000)`);
  if (WHATS_NEW.length > 4000) { console.error('notes too long'); process.exit(1); }

  // 1. Find or create the version.
  let vers = await retry(() => get(
    `/v1/apps/${APP}/appStoreVersions?filter[versionString]=${VERSION}&limit=1&fields[appStoreVersions]=versionString,appStoreState,releaseType`));
  let v = (vers.data || [])[0];
  if (!v) {
    const created = await retry(() => req('POST', '/v1/appStoreVersions', {
      data: {
        type: 'appStoreVersions',
        attributes: { platform: 'IOS', versionString: VERSION, releaseType: 'AFTER_APPROVAL' },
        relationships: { app: { data: { type: 'apps', id: APP } } },
      },
    }));
    v = created.data;
    if (!v) { console.error('create failed:', JSON.stringify(created.errors || created).slice(0, 400)); process.exit(1); }
    console.log('created version', VERSION, v.id);
  } else {
    console.log('version', VERSION, 'exists:', v.id, v.attributes.appStoreState);
  }
  const VID = v.id;

  // 2. What's New on EVERY locale — a submission 409s if any locale is missing it.
  const locs = await retry(() => get(`/v1/appStoreVersions/${VID}/appStoreVersionLocalizations?limit=20`));
  for (const l of (locs.data || [])) {
    const r = await retry(() => req('PATCH', '/v1/appStoreVersionLocalizations/' + l.id, {
      data: { type: 'appStoreVersionLocalizations', id: l.id, attributes: { whatsNew: WHATS_NEW } },
    }));
    console.log('  whatsNew', l.attributes.locale, '->', r.__status || r.status);
  }

  // 3. Wait for the build, then attach it.
  let build = null;
  for (let i = 0; i < 40; i++) {
    const b = await retry(() => get(
      `/v1/builds?filter[app]=${APP}&filter[version]=${WANT_BUILD}&limit=2&fields[builds]=version,processingState`));
    build = (b.data || [])[0];
    const st = build && build.attributes.processingState;
    console.log(`[${i}] build ${WANT_BUILD}:`, build ? st : 'not visible yet');
    if (build && st === 'VALID') break;
    if (build && (st === 'FAILED' || st === 'INVALID')) { console.error('BUILD REJECTED:', st); process.exit(1); }
    await sleep(30000);
  }
  if (!build || build.attributes.processingState !== 'VALID') { console.error('build never became VALID'); process.exit(1); }

  const at = await retry(() => req('PATCH', `/v1/appStoreVersions/${VID}/relationships/build`, {
    data: { type: 'builds', id: build.id },
  }));
  console.log('attach ->', at.__status || at.status);
  // Read the relationship back directly — the ?include=build form reports NONE even when attached.
  const rel = await retry(() => get(`/v1/appStoreVersions/${VID}/build?fields[builds]=version`));
  console.log('attached build:', rel.data && rel.data.attributes.version);

  if (!SUBMIT) { console.log('\nDRY RUN — not submitted. Re-run with SUBMIT=1.'); return; }

  // 4. Submit.
  let sub = await retry(() => req('POST', '/v1/reviewSubmissions', {
    data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' },
            relationships: { app: { data: { type: 'apps', id: APP } } } },
  }));
  let subId = sub.data && sub.data.id;
  if (!subId) {
    console.log('create submission ->', sub.__status, JSON.stringify(sub.errors || sub).slice(0, 300));
    const open = await retry(() => get(`/v1/apps/${APP}/reviewSubmissions?filter[platform]=IOS&limit=5`));
    subId = ((open.data || []).find((x) => ['READY_FOR_REVIEW', 'WAITING_FOR_REVIEW', 'UNRESOLVED_ISSUES'].includes(x.attributes.state)) || {}).id;
    if (!subId) { console.error('no usable submission'); process.exit(1); }
    console.log('reusing open submission', subId);
  }
  const item = await retry(() => req('POST', '/v1/reviewSubmissionItems', {
    data: { type: 'reviewSubmissionItems',
            relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id: subId } },
                             appStoreVersion: { data: { type: 'appStoreVersions', id: VID } } } },
  }));
  console.log('add item ->', item.__status || item.status, item.data ? 'added' : JSON.stringify(item.errors || item).slice(0, 300));
  const done = await retry(() => req('PATCH', '/v1/reviewSubmissions/' + subId, {
    data: { type: 'reviewSubmissions', id: subId, attributes: { submitted: true } },
  }));
  console.log('SUBMIT ->', done.__status || done.status, '| state:', (done.data && done.data.attributes.state) || JSON.stringify(done.errors || done).slice(0, 300));
})().catch((e) => { console.error('ERR', e.message || e); process.exit(1); });
