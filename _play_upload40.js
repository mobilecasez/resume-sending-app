// Upload an AAB straight to Google Play and release it, bypassing EAS Submit.
//
// ⚠️ WHY THIS EXISTS: `eas submit -p android` relays the bundle through EAS's own GCS bucket, and a
// ~94 MB AAB reproducibly dies there with `write EPIPE` partway through the upload. Google's own
// androidpublisher endpoint takes the same file directly with the same service account, so there is
// no reason to keep a third party in the middle of a release.
//
//   node _play_upload.js <path-to-aab> internal          → upload + release to internal
//   node _play_upload.js <path-to-aab> production         → upload + release to production (100%)
//
// Nothing is committed until edits.commit at the very end; any throw before that leaves Play
// untouched, because an abandoned edit changes nothing.
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const KEY = path.join(__dirname, 'Keys', 'cvapplyr-e46cebab373e.json');
const PACKAGE = 'com.cvapplyr.mobile';

const AAB = process.argv[2];
const TRACK = process.argv[3] || 'internal';
const RELEASE_NAME = process.env.RELEASE_NAME || '4.0';

// Play caps release notes at 500 chars per language — asserted below, not hoped for.
const NOTES = "Nothing fails silently any more.\n\n• If our AI service is briefly unavailable, Fetch job says so instead of saving a job with no details.\n• Translate tells you when a page is already English, and no longer switches itself off for later jobs.\n• Fetch job works on an already-saved job, and a failed fetch can be retried.\n• Pop-up sign-in and passkeys cannot work inside any app — we now say so and offer your browser.\n• The Job tools robot cannot be dragged off screen.";

async function main() {
  if (!AAB || !fs.existsSync(AAB)) throw new Error('AAB not found: ' + AAB);
  if (NOTES.length > 500) throw new Error(`release notes ${NOTES.length} chars — Play caps at 500`);
  console.log('AAB:', AAB, `(${(fs.statSync(AAB).size / 1048576).toFixed(1)} MB)`);
  console.log('track:', TRACK, '| notes:', NOTES.length, 'chars');

  const auth = new google.auth.GoogleAuth({ keyFile: KEY, scopes: ['https://www.googleapis.com/auth/androidpublisher'] });
  const ap = google.androidpublisher({ version: 'v3', auth: await auth.getClient() });

  const edit = await ap.edits.insert({ packageName: PACKAGE });
  const editId = edit.data.id;
  console.log('editId:', editId);

  console.log('uploading…');
  const up = await ap.edits.bundles.upload({
    packageName: PACKAGE, editId,
    media: { mimeType: 'application/octet-stream', body: fs.createReadStream(AAB) },
  });
  const vc = Number(up.data.versionCode);
  console.log('uploaded versionCode:', vc);

  await ap.edits.tracks.update({
    packageName: PACKAGE, editId, track: TRACK,
    requestBody: {
      track: TRACK,
      releases: [{
        name: RELEASE_NAME,
        status: 'completed',                       // full rollout, no staged fraction
        versionCodes: [String(vc)],
        releaseNotes: [{ language: 'en-US', text: NOTES }],
      }],
    },
  });
  console.log(`assigned vc ${vc} to ${TRACK}`);

  await ap.edits.validate({ packageName: PACKAGE, editId });
  console.log('validated');
  await ap.edits.commit({ packageName: PACKAGE, editId });
  console.log(`COMMITTED — vc ${vc} released to ${TRACK} (Google review follows)`);
}

main().catch((e) => {
  console.error('ERR', e.errors ? JSON.stringify(e.errors).slice(0, 500) : e.message);
  process.exit(1);
});
