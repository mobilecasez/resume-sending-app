// Ship App Store 4.5 (build 200), superseding 4.4 (183) which is live.
//
// ⚠️ SUBMITS FOR REVIEW. `node _asc44_release.js dry` stops before cancelling or submitting and
// prints exactly what it would do. Same flow as _asc44_release.js — see the comments there for why
// each step is shaped this way (one editable version, rename rather than delete, read the attached
// build back rather than trusting ?include=build).
const { req, get, retry, APP } = require('./_asc37.js');

const VERSION = '4.5';
// Build number is overridable so a later build can be swapped into the SAME 4.4 version while it
// is still WAITING_FOR_REVIEW:  node _asc45_release.js 201        (or `… 201 dry`)
const WANT_BUILD = (process.argv.find((a) => /^\d{2,4}$/.test(a))) || '200';
const DRY = process.argv.includes('dry');

const WHATS_NEW = [
  'Your resume, rebuilt by AI.',
  '',
  '• One tap on the home screen turns your uploaded resume into a designed, ATS-friendly one — see your resume score and a live preview of the result right there.',
  '• 73 resume designs across 15 layouts, organised by country. Pick a region, swipe the layouts, tap a color to restyle. Previewing every design is free.',
  '• The design you pick is the one that travels: it is what gets attached when you apply on portals and what your downloads use.',
  '• A cleaner resume editor: edit any section in place, save it as your resume, regenerate from your story when you want a fresh take.',
  '• Sign-in inside the in-app browser is smoother, and the "open in app / continue in Safari" interruptions while applying are gone.',
  '• Design previews render much faster.',
  '• Plan usage is shown as clear remaining counts on every button.',
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
