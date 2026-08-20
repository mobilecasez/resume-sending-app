// One-off manual grab: Siemens MOVED PORTALS — jobs.siemens.com/careers now serves a
// "we have moved" notice, which is exactly why our ATS adapter reported zero. The live board is
// /en_US/externaljobs/SearchJobs, server-rendered, hard-capped at 6 results per page
// (folderRecordsPerPage is accepted and then ignored), so this pages through by offset.
const fs = require('fs');
const { fetchText, strip, mapLimit } = require('./server/utils/atsDiscovery');

const PER = 6;
const BASE = 'https://jobs.siemens.com/en_US/externaljobs/SearchJobs/?folderRecordsPerPage=6&folderOffset=';

function parsePage(html) {
  const out = [];
  const blocks = html.split(/<article class="article article--result/).slice(1);
  for (const b of blocks) {
    const m = b.match(/href="(https:\/\/jobs\.siemens\.com\/[^"]*\/JobDetail\/(\d+))"[^>]*>([\s\S]{0,200}?)<\/a>/i);
    if (!m) continue;
    const title = strip(m[3]);
    if (!title) continue;
    // ⚠️ The "•" separators between location / Job ID / category are CSS pseudo-elements, so they
    // do NOT survive strip() — an earlier version keyed on them and produced "Not specified" for
    // all 803 jobs, which would have filed every Siemens role under country 'Global'.
    // The location is simply the text between the title and "Job ID:".
    const text = strip(b);
    const i = text.indexOf(title);
    const after = i >= 0 ? text.slice(i + title.length) : text;
    const rawLoc = (after.match(/^([\s\S]*?)\s*Job ID:/) || [])[1] || '';
    // strip() leaves a space before each comma ("Melbourne , Victoria , Australia").
    const loc = rawLoc.replace(/\s+,/g, ',').replace(/\s+/g, ' ').trim();
    const cat = ((after.match(/Job ID:\s*\d+\s*([\s\S]*?)\s*(?:Share|Learn more|$)/) || [])[1] || '').replace(/\s+/g, ' ').trim();
    out.push({ job_url: m[1], title, location: loc || 'Not specified', category: cat || null });
  }
  return out;
}

(async () => {
  const out = new Map();
  const CAP = parseInt(process.env.SIEMENS_CAP || '9000', 10);
  let offset = 0, dry = 0;
  while (offset < CAP && dry < 2) {
    const batch = [];
    for (let k = 0; k < 24 && offset + k * PER < CAP; k++) batch.push(offset + k * PER);
    const before = out.size;
    await mapLimit(batch, 6, async (off) => {
      let h;
      try { h = await fetchText(BASE + off); } catch { return; }
      for (const j of parsePage(h)) if (!out.has(j.job_url)) out.set(j.job_url, j);
    });
    if (out.size === before) dry++; else dry = 0;
    offset += batch.length * PER;
    if ((offset / PER) % 96 === 0) console.log(`  offset ${offset}: ${out.size} jobs`);
  }

  const arr = [...out.values()].filter((j) => j.title).map((j) => ({
    job_url: j.job_url,
    title: j.title,
    employer_name: 'Siemens',
    location: j.location,
    region: null,
    job_type: null,
    experience: null,
    responsibilities: [],
    skills: [],
    source: 'siemens-manual',
  }));
  fs.writeFileSync(process.argv[2], JSON.stringify(arr, null, 1));
  const { resolveCountry } = require('./server/utils/jobLocation');
  const byC = {}; for (const j of arr) { const c = resolveCountry(j.location, null); byC[c] = (byC[c] || 0) + 1; }
  console.log(`\nSiemens: ${arr.length} jobs, ${Object.keys(byC).length} countries`);
  console.log('  top:', JSON.stringify(Object.entries(byC).sort((a,b)=>b[1]-a[1]).slice(0,12)));
  console.log('  sample:', JSON.stringify(arr[0]));
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
