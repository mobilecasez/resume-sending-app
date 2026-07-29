// iOS App Store production submission for v3.4 (ADMIN key 8B7UN3VG74 — App-Manager 33Y3J5248R 403s on version/review ops).
//  SUBMIT=0 (default): wait for build → create/find version 3.4 → attach build → set whatsNew on ALL localizations. Draft, safe.
//  SUBMIT=1:           also create + submit the review submission (auto-releases after Apple approves).
const fs = require('fs'), jwt = require('jsonwebtoken'), https = require('https');
const KEY = fs.readFileSync('Keys/AuthKey_8B7UN3VG74.p8', 'utf8');
const KID = '8B7UN3VG74', ISS = 'bc162399-5ecc-4cdd-baf4-a143d5b1eb65', APP = '6762126502';
const VERSION = '3.4';
const DO_SUBMIT = process.env.SUBMIT === '1';
const MIN_BUILD = Number(process.env.MIN_BUILD || 129);  // 129 = the crash-fix build; never ship 126-128
const WHATSNEW =
  'Find jobs on the real Google, right inside the app — then let CVApplyr do the paperwork.\n' +
  '• Search Google in a full in-app browser and save any job you find in one tap\n' +
  '• A floating helper guides you step by step — profile, résumé, finding jobs, cover letters and Auto Fill — with videos and full-screen visual guides\n' +
  '• New in-app support: raise an issue and chat with us directly\n' +
  '• Scanned/image résumés are now read too\n' +
  '• Faster, more reliable job details, and many bug fixes';

function tok(){ return jwt.sign({ iss: ISS, aud: 'appstoreconnect-v1' }, KEY, { algorithm: 'ES256', keyid: KID, expiresIn: '12m' }); }
function req(method, path, body){
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request('https://api.appstoreconnect.apple.com' + path,
      { method, headers: { Authorization: 'Bearer ' + tok(), 'Content-Type': 'application/json' } },
      (resp) => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => {
        let j = {}; try { j = d ? JSON.parse(d) : {}; } catch (e) {}
        if (resp.statusCode >= 200 && resp.statusCode < 300) res(j);
        else rej({ status: resp.statusCode, body: j });
      }); });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}
const get = p => req('GET', p), post = (p, b) => req('POST', p, b), patch = (p, b) => req('PATCH', p, b);

async function waitForBuild(){
  for (let i = 0; i < 40; i++){
    const b = await get('/v1/builds?filter[app]=' + APP + '&sort=-uploadedDate&limit=5&fields[builds]=version,processingState');
    const rows = (b.data || []).map(x => ({ v: Number(x.attributes.version), st: x.attributes.processingState, id: x.id }));
    const cand = rows.find(x => x.v >= MIN_BUILD);
    console.log('  [build] newest=' + rows.slice(0, 3).map(x => x.v + '/' + x.st).join(' '));
    if (cand && cand.st === 'VALID') return cand;
    await new Promise(r => setTimeout(r, 30000));
  }
  throw new Error(VERSION + ' build (>=' + MIN_BUILD + ') did not reach VALID in time');
}

(async () => {
  console.log('=== iOS ' + VERSION + ' submission (' + (DO_SUBMIT ? 'SETUP + SUBMIT' : 'SETUP ONLY') + ') ===');
  const build = await waitForBuild();
  console.log('Using build', build.v, '(' + build.id + ')');

  let ver;
  const ex = await get('/v1/apps/' + APP + '/appStoreVersions?filter[versionString]=' + VERSION + '&filter[platform]=IOS');
  if (ex.data && ex.data.length){ ver = ex.data[0]; console.log('version ' + VERSION + ' exists:', ver.id, ver.attributes.appStoreState); }
  else { const c = await post('/v1/appStoreVersions', { data: { type: 'appStoreVersions', attributes: { platform: 'IOS', versionString: VERSION, releaseType: 'AFTER_APPROVAL' }, relationships: { app: { data: { type: 'apps', id: APP } } } } }); ver = c.data; console.log('created version ' + VERSION + ':', ver.id); }

  await patch('/v1/appStoreVersions/' + ver.id + '/relationships/build', { data: { type: 'builds', id: build.id } });
  console.log('attached build', build.v);

  const locs = await get('/v1/appStoreVersions/' + ver.id + '/appStoreVersionLocalizations?fields[appStoreVersionLocalizations]=locale,whatsNew');
  const have = {}; (locs.data || []).forEach(l => have[l.attributes.locale] = l.id);
  console.log('locales:', Object.keys(have).join(',') || '(none)');
  for (const locale of Object.keys(have)){
    await patch('/v1/appStoreVersionLocalizations/' + have[locale], { data: { type: 'appStoreVersionLocalizations', id: have[locale], attributes: { whatsNew: WHATSNEW } } });
    console.log('  set whatsNew for', locale);
  }

  if (!DO_SUBMIT){ console.log('\nSETUP DONE — ' + VERSION + ' has the build + notes (draft). Re-run with SUBMIT=1 to submit for review.'); return; }

  let rsId;
  try { const rs = await post('/v1/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: APP } } } } }); rsId = rs.data.id; console.log('created reviewSubmission', rsId); }
  catch (e){ console.log('reviewSubmission create failed (' + e.status + '), looking for an open one...'); const o = await get('/v1/reviewSubmissions?filter[app]=' + APP + '&filter[state]=READY_FOR_REVIEW,UNRESOLVED_ISSUES,COMPLETING&limit=5'); const reuse = (o.data || [])[0]; if (!reuse) throw e; rsId = reuse.id; console.log('reusing reviewSubmission', rsId); }
  await post('/v1/reviewSubmissionItems', { data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id: rsId } }, appStoreVersion: { data: { type: 'appStoreVersions', id: ver.id } } } } });
  console.log('added ' + VERSION + ' to the review submission');
  await patch('/v1/reviewSubmissions/' + rsId, { data: { type: 'reviewSubmissions', id: rsId, attributes: { submitted: true } } });
  console.log('\n✅ SUBMITTED ' + VERSION + ' for App Store review (auto-release after approval).');
})().catch(e => { console.error('\nERROR', e.status || '', JSON.stringify(e.body || e.message || String(e)).slice(0, 800)); process.exit(1); });
