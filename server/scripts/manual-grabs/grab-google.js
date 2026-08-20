// One-off manual grab: Google Careers renders client-side, but every results page ships its jobs
// inside an AF_initDataCallback blob (key ds:1) in the HTML. No API, no key — the same public page
// a browser loads. Deliberately NOT an adapter: this blob format is Google-internal and brittle,
// which is exactly why it does not belong in the firehose.
const fs = require('fs');
const { fetchText, strip, bulletsFrom, extractSkills, mapLimit } = require('./server/utils/atsDiscovery');
const { ISO2_COUNTRY } = require('./server/utils/jobLocation');

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);

// Brace-matched extraction so a "]" inside a job description can't truncate the array.
function afData(html, wantKey) {
  const re = /AF_initDataCallback\((\{[\s\S]*?\})\);<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1];
    if (((raw.match(/key:\s*'([^']+)'/) || [])[1]) !== wantKey) continue;
    const di = raw.indexOf('data:');
    const s = raw.indexOf('[', di);
    let depth = 0, inStr = false, esc = false;
    for (let i = s; i < raw.length; i++) {
      const c = raw[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '[') depth++;
      else if (c === ']') { depth--; if (!depth) { try { return JSON.parse(raw.slice(s, i + 1)); } catch { return null; } } }
    }
  }
  return null;
}

const html2 = (v) => (Array.isArray(v) ? (v[1] || '') : (v || ''));

(async () => {
  const out = new Map();
  const PAGES = parseInt(process.env.G_PAGES || '190', 10);
  let empty = 0;
  const pages = Array.from({ length: PAGES }, (_, i) => i + 1);

  await mapLimit(pages, 4, async (page) => {
    if (empty > 3) return;
    let html;
    try { html = await fetchText(`https://www.google.com/about/careers/applications/jobs/results?page=${page}`); }
    catch { return; }
    const d = afData(html, 'ds:1');
    const jobs = (d && Array.isArray(d[0])) ? d[0] : [];
    if (!jobs.length) { empty++; return; }
    for (const j of jobs) {
      const id = j[0]; const title = j[1];
      if (!id || !title || out.has(id)) continue;
      const locs = Array.isArray(j[9]) ? j[9] : [];
      const first = locs[0] || [];
      const locStr = first[0] || 'Not specified';
      const cc = first[5] || '';
      const respHtml = html2(j[3]);
      const qualHtml = html2(j[4]);
      const aboutHtml = html2(j[10]);
      out.set(id, {
        job_url: `https://www.google.com/about/careers/applications/jobs/results/${id}-${slug(title)}`,
        title,
        employer_name: j[7] || 'Google',
        location: locs.length > 1 ? `${locStr} (+${locs.length - 1} more)` : locStr,
        region: ISO2_COUNTRY[cc] || null,
        job_type: 'Full-time',
        responsibilities: bulletsFrom(respHtml).slice(0, 10),
        skills: extractSkills(strip(respHtml) + ' ' + strip(qualHtml) + ' ' + strip(aboutHtml)),
        source: 'google-manual',
      });
    }
    if (page % 20 === 0) console.log(`  page ${page}: ${out.size} jobs so far`);
  });

  const arr = [...out.values()];
  fs.writeFileSync(process.argv[2], JSON.stringify(arr, null, 1));
  const byC = {}; for (const j of arr) byC[j.region || '?'] = (byC[j.region || '?'] || 0) + 1;
  const byE = {}; for (const j of arr) byE[j.employer_name] = (byE[j.employer_name] || 0) + 1;
  console.log(`\nGoogle: ${arr.length} jobs`);
  console.log('  employers:', JSON.stringify(Object.entries(byE).sort((a,b)=>b[1]-a[1]).slice(0,8)));
  console.log('  countries:', Object.keys(byC).length, JSON.stringify(Object.entries(byC).sort((a,b)=>b[1]-a[1]).slice(0,10)));
  console.log('  with responsibilities:', arr.filter(j=>j.responsibilities.length).length, '| with skills:', arr.filter(j=>j.skills.length).length);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
