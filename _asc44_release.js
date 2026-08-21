// Ship App Store 4.4 (build 183), superseding 4.2 (172) which is live.
//
// ⚠️ SUBMITS FOR REVIEW. `node _asc44_release.js dry` stops before cancelling or submitting and
// prints exactly what it would do. Same flow as _asc42_release.js — see the comments there for why
// each step is shaped this way (one editable version, rename rather than delete, read the attached
// build back rather than trusting ?include=build).
const { req, get, retry, APP } = require('./_asc37.js');

const VERSION = '4.4';
// Build number is overridable so a later build can be swapped into the SAME 4.4 version while it
// is still WAITING_FOR_REVIEW:  node _asc44_release.js 184        (or `… 184 dry`)
const WANT_BUILD = (process.argv.find((a) => /^\d{2,4}$/.test(a))) || '183';
const DRY = process.argv.includes('dry');

const WHATS_NEW = [
  'Know where you stand, and what to do next.',
  '',
  '• Résumé score: we read your résumé and give it an honest score out of 100, with the three changes that would lift it most — and a free AI rewrite to make them.',
  '• A guided setup that shows you the next step instead of leaving you to find it, with five short videos — one per step.',
  '• Thousands more jobs, direct from Amazon, Google, SAP, Siemens, Allianz, Zalando, Revolut, Bolt and Personio.',
  '• Job results are now genuinely sorted by how well they match your résumé, highest first. A new "Near me" sort puts your own country first when you want that instead.',
  '• Search remembers what you last looked for, even after you close the app.',
  '• Sign-in: where Google blocks sign-in inside apps, you now get a clear choice instead of a blank page.',
  '• Fixes: the search panel no longer jumps around or hides behind the keyboard, and the tutorial chapters start from the beginning.',
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await retry(() => get(
    `/v1/builds?filter[app]=${APP}&filter[version]=${WANT_BUILD}&limit=5&fields[builds]=version,processingState`));
  const build = (b.data || [])[0];
  if (!build || build.attributes.processingState !== 'VALID') {
    console.error(`build ${WANT_BUILD} is ${build ? build.attributes.processingState : 'not visible'} — stopping, store untouched`);
    process.exit(1);
  }
  console.log(`build ${WANT_BUILD}: VALID (${build.id})`);

  const open = await retry(() => get(
    `/v1/apps/${APP}/reviewSubmissions?filter[platform]=IOS&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES&limit=10`));
  const openSubs = open.data || [];
  console.log(`open submissions: ${openSubs.length}${openSubs.length ? ' (' + openSubs.map((s) => s.id + ':' + s.attributes.state).join(', ') + ')' : ''}`);
  if (!DRY) {
    for (const s of openSubs) {
      const c = await retry(() => req('PATCH', '/v1/reviewSubmissions/' + s.id, {
        data: { type: 'reviewSubmissions', id: s.id, attributes: { canceled: true } } }));
      console.log(`  cancel ${s.id} ->`, c.__status || c.status);
    }
    if (openSubs.length) await sleep(8000);
  }

  const EDITABLE = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'];
  const all = await retry(() => get(
    `/v1/apps/${APP}/appStoreVersions?limit=20&fields[appStoreVersions]=versionString,appStoreState,releaseType`));
  let ver = (all.data || []).find((v) => v.attributes.versionString === VERSION);
  const stale = (all.data || []).find((v) => v.attributes.versionString !== VERSION
    && EDITABLE.includes(v.attributes.appStoreState));
  if (ver) console.log(`version ${VERSION} exists: ${ver.id} (${ver.attributes.appStoreState})`);
  else if (stale && !DRY) {
    console.log(`renaming editable v${stale.attributes.versionString} (${stale.attributes.appStoreState}) -> ${VERSION}`);
    const ren = await retry(() => req('PATCH', '/v1/appStoreVersions/' + stale.id, {
      data: { type: 'appStoreVersions', id: stale.id, attributes: { versionString: VERSION } } }));
    ver = ren.data;
    if (!ver) { console.error('rename failed:', JSON.stringify(ren.errors || ren).slice(0, 500)); process.exit(1); }
    console.log(`renamed -> ${VERSION} (${ver.id})`);
  } else if (DRY) {
    console.log(`DRY: would ${stale ? 'rename v' + stale.attributes.versionString : 'create'} -> ${VERSION}`);
  } else {
    const created = await retry(() => req('POST', '/v1/appStoreVersions', {
      data: { type: 'appStoreVersions', attributes: { platform: 'IOS', versionString: VERSION },
              relationships: { app: { data: { type: 'apps', id: APP } } } } }));
    ver = created.data;
    if (!ver) { console.error('create failed:', JSON.stringify(created.errors || created).slice(0, 500)); process.exit(1); }
    console.log(`created ${VERSION}: ${ver.id}`);
  }
  if (DRY && !ver) { console.log('\nDRY RUN — nothing changed.'); return; }
  const VID = ver.id;

  const attach = await retry(() => req('PATCH', `/v1/appStoreVersions/${VID}/relationships/build`, {
    data: { type: 'builds', id: build.id } }));
  console.log('attach ->', attach.__status || attach.status);
  const rel = await retry(() => get(`/v1/appStoreVersions/${VID}/build?fields[builds]=version`));
  console.log('attached build (read back):', rel.data?.attributes?.version || 'NONE');
  if (String(rel.data?.attributes?.version || '') !== WANT_BUILD) {
    console.error('the attached build is not ' + WANT_BUILD + ' — stopping before submit');
    process.exit(1);
  }

  const locs = await retry(() => get(`/v1/appStoreVersions/${VID}/appStoreVersionLocalizations?limit=50&fields[appStoreVersionLocalizations]=locale,whatsNew`));
  for (const l of locs.data || []) {
    const r = await retry(() => req('PATCH', `/v1/appStoreVersionLocalizations/${l.id}`, {
      data: { type: 'appStoreVersionLocalizations', id: l.id, attributes: { whatsNew: WHATS_NEW } } }));
    console.log(`  whatsNew ${l.attributes.locale} ->`, r.__status || r.status);
  }

  const v2 = await retry(() => get(`/v1/appStoreVersions/${VID}?fields[appStoreVersions]=versionString,appStoreState,releaseType`));
  console.log(`\nabout to submit: v${v2.data?.attributes?.versionString} | ${v2.data?.attributes?.appStoreState} | ${v2.data?.attributes?.releaseType} | build ${rel.data?.attributes?.version}`);
  if (DRY) { console.log('\nDRY RUN — not submitting.'); return; }

  let sub = await retry(() => req('POST', '/v1/reviewSubmissions', {
    data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' },
            relationships: { app: { data: { type: 'apps', id: APP } } } } }));
  let subId = sub.data?.id;
  if (!subId) {
    const again = await retry(() => get(`/v1/apps/${APP}/reviewSubmissions?filter[platform]=IOS&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES&limit=5`));
    subId = (again.data || [])[0]?.id;
    console.log('reusing submission:', subId || 'none');
    if (!subId) { console.error(JSON.stringify(sub.errors || sub).slice(0, 400)); process.exit(1); }
  }
  const item = await retry(() => req('POST', '/v1/reviewSubmissionItems', {
    data: { type: 'reviewSubmissionItems',
            relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id: subId } },
                             appStoreVersion: { data: { type: 'appStoreVersions', id: VID } } } } }));
  console.log('add to submission ->', item.__status || item.status,
    item.data?.id ? 'added' : JSON.stringify(item.errors || item).slice(0, 400));

  const done = await retry(() => req('PATCH', '/v1/reviewSubmissions/' + subId, {
    data: { type: 'reviewSubmissions', id: subId, attributes: { submitted: true } } }));
  console.log('SUBMIT ->', done.__status || done.status, '| state:',
    done.data?.attributes?.state || JSON.stringify(done.errors || done).slice(0, 400));
})().catch((e) => { console.error('ERR', e.message || e); process.exit(1); });
