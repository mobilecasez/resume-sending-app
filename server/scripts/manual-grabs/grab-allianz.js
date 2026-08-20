// One-off manual grab: Allianz runs Phenom, whose listing is JS-rendered — but each search page
// embeds its slice of results in a `phApp.ddo` object in the HTML. That is why our ATS adapter
// returned 0 for this board and why this is a hand-load rather than an adapter.
const fs = require('fs');
const { fetchText, strip, mapLimit } = require('./server/utils/atsDiscovery');

// There are SEVERAL phApp.ddo objects on the page (the first is site config); take the one that
// actually carries the search results.
function ddoWith(html, needle) {
  let from = 0;
  while (true) {
    const i = html.indexOf('phApp.ddo', from);
    if (i < 0) return null;
    let s = html.indexOf('{', i), d = 0, inS = false, esc = false, end = -1;
    for (let k = s; k < html.length; k++) {
      const c = html[k];
      if (inS) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inS = false; continue; }
      if (c === '"') inS = true; else if (c === '{') d++; else if (c === '}') { d--; if (!d) { end = k + 1; break; } }
    }
    if (end < 0) return null;
    const seg = html.slice(s, end);
    if (seg.includes(needle)) { try { return JSON.parse(seg); } catch { return null; } }
    from = end;
  }
}

(async () => {
  const first = await fetchText('https://careers.allianz.com/us/en/search-results?from=0&s=1');
  const es0 = (ddoWith(first, 'eagerLoadRefineSearch') || {}).eagerLoadRefineSearch;
  const total = (es0 && es0.totalHits) || 0;
  console.log('Allianz total hits:', total);
  const offsets = [];
  for (let f = 0; f < total; f += 10) offsets.push(f);

  const out = new Map();
  await mapLimit(offsets, 4, async (from) => {
    let h;
    try { h = await fetchText(`https://careers.allianz.com/us/en/search-results?from=${from}&s=1`); } catch { return; }
    const es = (ddoWith(h, 'eagerLoadRefineSearch') || {}).eagerLoadRefineSearch;
    const jobs = (es && es.data && es.data.jobs) || [];
    for (const j of jobs) {
      const url = j.applyUrl || j.imApplyUrl;
      if (!j.title || !url || out.has(url)) continue;
      const loc = j.cityStateCountry || j.location || [j.city, j.state, j.country].filter(Boolean).join(', ');
      const skills = Array.isArray(j.ml_skills) ? j.ml_skills.filter(Boolean).slice(0, 12) : [];
      out.set(url, {
        job_url: url,
        title: j.title,
        employer_name: j.employingEntity || 'Allianz',
        location: (j.remote === 'true' || j.remote === true) ? `Remote — ${loc}` : (loc || 'Not specified'),
        region: j.country || null,
        job_type: j.employmentType || null,
        experience: j.jobLevel || null,
        responsibilities: [],
        skills,
        source: 'allianz-manual',
      });
    }
    if (from % 400 === 0) console.log(`  from ${from}: ${out.size} jobs`);
  });

  const arr = [...out.values()];
  fs.writeFileSync(process.argv[2], JSON.stringify(arr, null, 1));
  const byC = {}; for (const j of arr) byC[j.region || '?'] = (byC[j.region || '?'] || 0) + 1;
  console.log(`\nAllianz: ${arr.length} jobs, ${Object.keys(byC).length} countries`);
  console.log('  top:', JSON.stringify(Object.entries(byC).sort((a,b)=>b[1]-a[1]).slice(0,10)));
  console.log('  with skills:', arr.filter(j=>j.skills.length).length);
  console.log('  sample:', JSON.stringify(arr[0]).slice(0,240));
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
