// Universal ATS discovery — detect which Applicant Tracking System a careers page
// uses (even on a CUSTOM company domain) and pull ALL jobs from that ATS's public
// JSON API, fully structured. The durable replacement for URL-pattern guessing:
// one adapter per ATS covers every company on it.
//
// Additive + safe: detectAndFetchAts() returns null on any miss/error, so the caller
// falls straight back to the existing scrape pipeline. Public no-auth endpoints only;
// every adapter is wrapped so a wrong guess never throws.
'use strict';

const https = require('https');
const http = require('http');

const UA = 'Mozilla/5.0 (compatible; CVApplyrBot/1.0; +https://cvapplyr.com)';
const TIMEOUT = 12000;

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('too many redirects'));
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.get(url, { headers: { 'User-Agent': UA, Accept: 'application/json,text/html,*/*' }, timeout: TIMEOUT }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        const next = r.headers.location.startsWith('http') ? r.headers.location : new URL(r.headers.location, url).href;
        return resolve(fetchText(next, redirects + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      let d = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { d += c; if (d.length > 12_000_000) req.destroy(); });
      r.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
async function fetchJson(url) {
  const txt = await fetchText(url);
  // A 200 that isn't JSON (HTML error/maintenance/login wall) would otherwise throw an
  // opaque SyntaxError; surface a clear, diagnosable message instead. (L9)
  try { return JSON.parse(txt); }
  catch { throw new Error(`non-JSON response from ${url} (${String(txt).slice(0, 80).replace(/\s+/g, ' ').trim()}…)`); }
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    let parsed; try { parsed = new URL(url); } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'http:' ? http : https;
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = lib.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA, 'Content-Length': data.length }, timeout: TIMEOUT }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      let d = ''; r.setEncoding('utf8');
      r.on('data', (c) => { d += c; if (d.length > 12_000_000) req.destroy(); });
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(data); req.end();
  });
}

// Extract a JS object literal assigned in page HTML (e.g. `window.pageData = {…}`) by brace-matching
// (string-aware) from the first `{` after the marker. Returns the parsed object or null.
function extractJsonAssign(html, marker) {
  const i = String(html || '').indexOf(marker); if (i < 0) return null;
  const s = html.indexOf('{', i); if (s < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let k = s; k < html.length; k++) {
    const ch = html[k];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(s, k + 1)); } catch { return null; } } }
  }
  return null;
}

// Bounded-concurrency map (for per-job detail fetches on Workday/SmartRecruiters).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; } }
  });
  await Promise.all(workers);
  return out;
}

// ── shared helpers ───────────────────────────────────────────────────────────
const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#?[a-z0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

function bulletsFrom(html) {
  const h = String(html || '');
  let items = [...h.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => strip(m[1]));
  if (items.length === 0) {
    items = strip(h).split(/(?:•|·|‣|◦|•|\.\s+(?=[A-Z])|\n)/).map((s) => s.trim());
  }
  return items.filter((s) => s.length > 3 && s.length < 280);
}

function jobType(code) {
  const c = String(code || '').toLowerCase();
  if (/part/.test(c)) return 'Part-time';
  if (/intern|trainee|werkstud|appren/.test(c)) return 'Internship';
  if (/contract|temp|fixed|interim|freelanc|free/.test(c)) return /free/.test(c) ? 'Freelance' : 'Contract';
  return 'Full-time';
}

function rootDomain(host) {
  const clean = String(host || '').replace(/^www\./i, '').toLowerCase();
  const parts = clean.split('.');
  if (parts.length <= 2) return parts[0] || clean;
  const twoPart = new Set(['co.uk', 'com.au', 'co.in', 'co.jp', 'com.br', 'co.nz', 'com.sg']);
  return twoPart.has(parts.slice(-2).join('.')) ? parts[parts.length - 3] : parts[parts.length - 2];
}

function nameFromHtmlOrDomain(rawHtml, urlOrDomain) {
  const h = String(rawHtml || '');
  const og = h.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  if (og && og[1].trim().length > 1) return og[1].trim();
  const appName = h.match(/<meta[^>]+name=["']application-name["'][^>]+content=["']([^"']+)["']/i);
  if (appName && appName[1].trim().length > 1) return appName[1].trim();
  let host = urlOrDomain;
  try { host = new URL(urlOrDomain).hostname; } catch {}
  const root = rootDomain(host);
  return root ? root.charAt(0).toUpperCase() + root.slice(1) : (urlOrDomain || 'Company');
}

function htmlUnescape(s) {
  return String(s || '').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'").replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');
}
const titleCase = (slug) => String(slug || '').replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, (m) => m.toUpperCase());
// For path-based ATSes the company is the TOKEN (boards.greenhouse.io/AIRBNB), not the
// ATS host — so prefer a real og:site_name, else title-case the token.
function resolveCompany(html, token, url) {
  const h = String(html || '');
  const og = h.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  if (og && og[1].trim().length > 1 && !/greenhouse|lever|ashby|workable|recruitee|breezy/i.test(og[1])) return og[1].trim();
  if (token) return titleCase(token);
  return nameFromHtmlOrDomain(html, url);
}

// Curated skill/keyword vocabulary → short, chip-friendly skills extracted from the
// full job text. Generalises across ATSes (whose "requirements" are long sentences).
const SKILL_VOCAB = [
  'JavaScript','TypeScript','Python','Java','C++','C#','Go','Rust','Ruby','PHP','Swift','Kotlin','Scala','SQL','HTML','CSS','Sass','Bash','Perl','Dart','Elixir','Objective-C',
  'React','React Native','Angular','Vue','Svelte','Next.js','Nuxt','Node.js','Express','Django','Flask','FastAPI','Spring','Spring Boot','Rails','Laravel','.NET','ASP.NET','Symfony','jQuery','Redux','GraphQL','REST','gRPC','Tailwind','Bootstrap',
  'Pandas','NumPy','TensorFlow','PyTorch','scikit-learn','Keras','Spark','Hadoop','Kafka','Airflow','dbt','Snowflake','Redshift','BigQuery','Tableau','Power BI','Looker','Machine Learning','Deep Learning','NLP','Computer Vision','Data Science','Data Engineering','ETL','LLM','Generative AI',
  'AWS','Azure','GCP','Google Cloud','Kubernetes','Docker','Terraform','Ansible','Jenkins','GitLab','GitHub Actions','CI/CD','Helm','Prometheus','Grafana','Datadog','Linux','Nginx','Serverless','Microservices',
  'PostgreSQL','MySQL','MongoDB','Redis','Elasticsearch','Cassandra','DynamoDB','Oracle','SQL Server','Firebase','Supabase',
  'Git','Jira','Confluence','Figma','Sketch','Adobe','Photoshop','Illustrator','Salesforce','HubSpot','SAP','Workday','ServiceNow','Zendesk','Notion','Webflow','Shopify','WordPress',
  'Project Management','Agile','Scrum','Kanban','Product Management','Stakeholder Management','Communication','Leadership','Marketing','SEO','SEM','Content Marketing','Copywriting','Sales','Business Development','Account Management','Customer Success','Customer Support','Financial Modeling','Accounting','Recruiting','Negotiation','Public Speaking',
  'UI/UX','UX Design','UI Design','Product Design','Wireframing','Prototyping','User Research','Design Systems','Branding','Motion Design',
];
const SKILL_MATCHERS = SKILL_VOCAB.map((s) => ({
  display: s,
  re: new RegExp('(^|[^a-z0-9+#.])' + s.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9+#])', 'i'),
}));
function extractSkills(text) {
  const t = ' ' + String(text || '').toLowerCase() + ' ';
  const out = [];
  for (const m of SKILL_MATCHERS) { if (m.re.test(t)) out.push(m.display); }
  return [...new Set(out)].slice(0, 12);
}

// Salary fields vary wildly across ATSes (string, number, or {min,max,currency,period}
// object). Always emit a clean human string or null — never a raw object.
function formatSalary(s) {
  if (s == null) return null;
  if (typeof s === 'number') return String(s);
  if (typeof s === 'string') return s.trim() || null;
  if (typeof s === 'object') {
    const min = s.min ?? s.minimum ?? s.minValue ?? s.from ?? null;
    const max = s.max ?? s.maximum ?? s.maxValue ?? s.to ?? null;
    if (min == null && max == null) return null;
    const cur = s.currency || s.currency_code || s.currencyCode || '';
    const per = s.period || s.unit || s.interval || '';
    const num = (n) => (n == null ? '' : Number(n).toLocaleString('en-US'));
    const range = (min != null && max != null) ? `${num(min)}–${num(max)}` : num(min != null ? min : max);
    const out = `${cur ? cur + ' ' : ''}${range}${per ? '/' + per : ''}`.trim();
    return out || null;
  }
  return null;
}

// Build the normalized raw job. responsibilities = description (+ requirement) bullets;
// skills = curated keyword chips from the full text (clean, short).
function makeJob({ title, location, job_url, employer_name, employmentCode, salary, experience, descHtml, reqHtml }) {
  const fullText = strip(descHtml) + ' \n ' + strip(reqHtml);
  let resp = bulletsFrom(descHtml);
  if (resp.length < 3 && reqHtml) resp = resp.concat(bulletsFrom(reqHtml));
  return {
    title,
    location: location || 'Not specified',
    job_url: job_url || null,
    job_type: jobType(employmentCode),
    salary: formatSalary(salary),
    experience: experience || null,
    responsibilities: resp.slice(0, 10),
    skills: extractSkills(fullText),
    employer_name: employer_name || null,
    _atsApi: true,
  };
}

// ── Adapters ─────────────────────────────────────────────────────────────────
// detect(ctx) → token|false ;  fetch(ctx) → rawJobs[]   ; ctx = { url, origin, host, pathname, html }
const firstSeg = (pathname) => { const m = String(pathname || '').match(/^\/([^/?#]+)/); return m ? m[1] : ''; };
// Generic words that are NEVER a real ATS company token — they leak in from form
// labels (<label for="location">), nav, and JS, and resolve to bogus demo boards.
const JUNK_TOKENS = new Set(['location', 'locations', 'careers', 'career', 'jobs', 'job', 'search', 'name', 'email', 'phone', 'company', 'apply', 'for', 'this', 'that', 'default', 'test', 'demo', 'example', 'sample', 'board', 'embed', 'iframe', 'widget', 'all', 'none', 'true', 'false', 'undefined', 'null', 'home', 'main', 'content', 'header', 'footer', 'menu', 'filter']);
const validToken = (t) => !!t && typeof t === 'string' && t.length >= 2 && !JUNK_TOKENS.has(t.toLowerCase());

const adapters = [
  // RECRUITEE — {origin}/api/offers/ works on custom domains (verified: careers.hostaway.com)
  {
    name: 'recruitee',
    detect: (c) => (/\.recruitee\.com$/i.test(c.host) || /recruiteecdn\.com|\.recruitee\.com|data-recruitee|window\.__recruitee|id=["']recruitee/i.test(c.html || '')) ? c.origin : false,
    async fetch(c) {
      const data = await fetchJson(`${c.origin}/api/offers/`);
      const offers = (data && Array.isArray(data.offers)) ? data.offers : [];
      const company = (offers[0] && (offers[0].company_name || offers[0].company)) || nameFromHtmlOrDomain(c.html, c.origin);
      return offers.filter((o) => o.title).map((o) => makeJob({
        title: o.title,
        location: o.location || [o.city, o.country].filter(Boolean).join(', '),
        job_url: o.careers_url || `${c.origin}/o/${o.slug}`,
        employer_name: company, employmentCode: o.employment_type_code, salary: o.salary,
        experience: (o.experience_code && o.experience_code !== 'not_applicable') ? o.experience_code : null,
        descHtml: o.description, reqHtml: o.requirements,
      }));
    },
  },

  // PERSONIO — {sub}.jobs.personio.com/xml  (public XML positions feed; descriptions inline)
  {
    name: 'personio',
    detect: (c) => {
      const m = c.host.match(/^([a-z0-9-]+)\.jobs\.personio\.(?:com|de)$/i);
      if (m) return m[1];
      const h = String(c.html || '').match(/([a-z0-9-]+)\.jobs\.personio\.(?:com|de)/i);
      return h ? h[1] : false;
    },
    async fetch(c) {
      const sub = c.token;
      let xml = await fetchText(`https://${sub}.jobs.personio.com/xml`).catch(() => '');
      if (!/<position>/i.test(xml)) { const de = await fetchText(`https://${sub}.jobs.personio.de/xml`).catch(() => ''); if (/<position>/i.test(de)) xml = de; }
      const blocks = String(xml).match(/<position>[\s\S]*?<\/position>/gi) || [];
      const company = nameFromHtmlOrDomain(c.html, c.origin) || sub;
      const tag = (b, t) => { const m = b.match(new RegExp('<' + t + '>([\\s\\S]*?)<\\/' + t + '>', 'i')); return m ? strip(m[1]) : ''; };
      return blocks.map((b) => {
        const id = tag(b, 'id');
        // The POSITION name is the <name> that sits BEFORE <jobDescriptions> (the inner
        // jobDescription blocks also have <name> section headers).
        const head = b.split(/<jobDescriptions>/i)[0];
        const nm = head.match(/<name>([\s\S]*?)<\/name>/i);
        const descHtml = (b.match(/<value>([\s\S]*?)<\/value>/gi) || [])
          .map((v) => v.replace(/<\/?value>/gi, '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, ' ')).join(' ');
        return makeJob({
          title: nm ? strip(nm[1]) : '',
          location: tag(b, 'office') || tag(b, 'department') || 'Not specified',
          job_url: `https://${sub}.jobs.personio.com/job/${id}`,
          employer_name: company, employmentCode: tag(b, 'employmentType') || tag(b, 'schedule'),
          descHtml,
        });
      }).filter((j) => j.title);
    },
  },

  // BAMBOOHR — {sub}.bamboohr.com/careers/list (JSON); description via /careers/{id}/detail.
  {
    name: 'bamboohr',
    detect: (c) => {
      const m = c.host.match(/^([a-z0-9-]+)\.bamboohr\.com$/i);
      if (m) return m[1];
      const h = String(c.html || '').match(/([a-z0-9-]+)\.bamboohr\.com/i);
      return h ? h[1] : false;
    },
    async fetch(c) {
      const sub = c.token;
      const data = await fetchJson(`https://${sub}.bamboohr.com/careers/list`);
      const list = (data && Array.isArray(data.result)) ? data.result : [];
      if (!list.length) return [];
      const company = (data.meta && data.meta.companyName) || nameFromHtmlOrDomain(c.html, c.origin) || sub;
      const descById = {};
      await mapLimit(list.slice(0, 120).map((j) => j.id), 10, async (id) => {
        try { const d = await fetchJson(`https://${sub}.bamboohr.com/careers/${id}/detail`); const jo = (d && d.result && d.result.jobOpening) || (d && d.jobOpening) || {}; descById[id] = jo.description || ''; } catch (_) {}
      });
      return list.filter((j) => j.jobOpeningName).map((j) => {
        const loc = j.atsLocation || j.location || {};
        const locStr = [loc.city, loc.state, loc.addressCountry || loc.country].filter(Boolean).join(', ');
        return makeJob({
          title: j.jobOpeningName, location: locStr || 'Not specified',
          job_url: j.jobOpeningShareUrl || `https://${sub}.bamboohr.com/careers/${j.id}`,
          employer_name: company, employmentCode: j.employmentStatusLabel, descHtml: descById[j.id] || '',
        });
      });
    },
  },

  // PINPOINT — {sub}.pinpointhq.com/postings.json (JSON, descriptions inline; no auth).
  {
    name: 'pinpoint',
    detect: (c) => {
      if (/^[a-z0-9-]+\.pinpointhq\.com$/i.test(c.host)) return c.origin;
      const h = String(c.html || '').match(/([a-z0-9-]+\.pinpointhq\.com)/i);
      return h ? `https://${h[1]}` : false;
    },
    async fetch(c) {
      const origin = c.token;
      const data = await fetchJson(`${origin}/postings.json`);
      const list = (data && Array.isArray(data.data)) ? data.data : [];
      if (!list.length) return [];
      const company = nameFromHtmlOrDomain(c.html, c.origin) || new URL(origin).hostname.split('.')[0];
      return list.filter((p) => p.title).map((p) => makeJob({
        title: p.title,
        location: (p.location && (p.location.name || (typeof p.location === 'string' ? p.location : ''))) || 'Not specified',
        job_url: p.url || `${origin}/jobs/${p.id}`,
        employer_name: company, employmentCode: p.employment_type_text || p.employment_type,
        descHtml: [p.description, p.key_responsibilities, p.skills_knowledge_expertise].filter(Boolean).join(' '),
      }));
    },
  },

  // ORACLE FUSION CLOUD RECRUITING (ORC) — *.fa.*.oraclecloud.com/hcmUI/CandidateExperience/.../sites/{site}.
  // Hard JS SPA that paints from a public REST API. List is paginated (limit 25 + offset); the full
  // jobDescription needs a per-req detail GET (like Workday). The `expand=requisitionList…` param is
  // REQUIRED or the list comes back empty.
  {
    name: 'oraclecloud',
    detect: (c) => {
      if (!/\.oraclecloud\.com$/i.test(c.host)) return false;
      const m = c.pathname.match(/\/CandidateExperience\/[^/]*\/sites\/([^/?#]+)/i) || c.pathname.match(/\/sites\/([^/?#]+)/i);
      return m ? m[1] : false;
    },
    async fetch(c) {
      const host = c.host, site = c.token;
      const base = `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations,flexFieldsFacet.values&finder=findReqs;siteNumber=${site},facetsList=LOCATIONS%3BORGANIZATIONS%3BCATEGORIES,sortBy=POSTING_DATES_DESC`;
      const PAGE = 25, CAP = 300, reqs = [];
      let total = Infinity;
      for (let off = 0; off < Math.min(total, CAP); off += PAGE) {
        let data; try { data = await fetchJson(`${base},limit=${PAGE},offset=${off}`); } catch { break; }
        const it = (data && data.items && data.items[0]) || {};
        if (Number.isFinite(it.TotalJobsCount)) total = it.TotalJobsCount;
        const list = it.requisitionList || [];
        if (!list.length) break;
        reqs.push(...list);
        if (reqs.length >= total) break;
      }
      if (!reqs.length) return [];
      const company = nameFromHtmlOrDomain(c.html, c.origin) || host.split('.')[0];
      // Per-req descriptions (capped + concurrency-limited) — the list lacks the body.
      const descById = {};
      await mapLimit(reqs.slice(0, 120).map((r) => r.Id), 10, async (id) => {
        try {
          const d = await fetchJson(`https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=${id},siteNumber=${site}`);
          const it = (d && d.items && d.items[0]) || {};
          descById[id] = [it.ExternalDescriptionStr, it.ExternalQualificationsStr].filter(Boolean).join(' ');
        } catch (_) {}
      });
      return reqs.filter((r) => r.Title).map((r) => makeJob({
        title: r.Title,
        location: r.PrimaryLocation || (r.secondaryLocations && r.secondaryLocations[0] && r.secondaryLocations[0].Name) || 'Not specified',
        job_url: `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${r.Id}`,
        employer_name: company, descHtml: descById[r.Id] || r.ShortDescriptionStr || '',
      }));
    },
  },

  // GREENHOUSE — boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
  {
    name: 'greenhouse',
    detect: (c) => {
      if (/(boards|job-boards)\.greenhouse\.io$/i.test(c.host)) { const t = firstSeg(c.pathname); return validToken(t) ? t : false; }
      // Only trust a bare `for: "token"` when it sits in a GREENHOUSE context (grnhse.js
      // init / greenhouse embed) — NOT a stray <label for="location"> form attribute.
      const m = String(c.html || '').match(/greenhouse\.io\/embed\/job_board\?for=([a-z0-9_]+)|boards\.greenhouse\.io\/([a-z0-9_]+)|(?:grnhse|greenhouse)[\s\S]{0,100}?["']?for["']?\s*[:=]\s*["']([a-z0-9_]+)["']/i);
      const t = m ? (m[1] || m[2] || m[3]) : '';
      return validToken(t) ? t : false;
    },
    async fetch(c) {
      const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${c.token}/jobs?content=true`);
      const jobs = (data && Array.isArray(data.jobs)) ? data.jobs : [];
      const company = resolveCompany(c.html, c.token, c.origin);
      return jobs.filter((j) => j.title).map((j) => {
        const content = htmlUnescape(j.content);
        return makeJob({
          title: j.title, location: (j.location && j.location.name) || 'Not specified',
          job_url: j.absolute_url, employer_name: company, descHtml: content,
        });
      });
    },
  },

  // LEVER — api.lever.co/v0/postings/{company}?mode=json
  {
    name: 'lever',
    detect: (c) => {
      if (/jobs\.(eu\.)?lever\.co$/i.test(c.host)) return firstSeg(c.pathname) || false;
      const m = String(c.html || '').match(/jobs\.lever\.co\/([a-z0-9-]+)/i);
      return m ? m[1] : false;
    },
    async fetch(c) {
      const arr = await fetchJson(`https://api.lever.co/v0/postings/${c.token}?mode=json`);
      const jobs = Array.isArray(arr) ? arr : [];
      const company = resolveCompany(c.html, c.token, c.origin);
      return jobs.filter((j) => j.text).map((j) => {
        const lists = Array.isArray(j.lists) ? j.lists.map((l) => l.content).join(' ') : '';
        return makeJob({
          title: j.text, location: (j.categories && j.categories.location) || 'Not specified',
          job_url: j.hostedUrl, employer_name: company, employmentCode: j.categories && j.categories.commitment,
          descHtml: (j.description || '') + ' ' + lists, reqHtml: lists,
        });
      });
    },
  },

  // ASHBY — api.ashbyhq.com/posting-api/job-board/{org}
  {
    name: 'ashby',
    detect: (c) => {
      if (/jobs\.ashbyhq\.com$/i.test(c.host)) return firstSeg(c.pathname) || false;
      const m = String(c.html || '').match(/jobs\.ashbyhq\.com\/([a-zA-Z0-9-]+)|ashbyhq\.com\/([a-zA-Z0-9-]+)\/embed|_ashby_org["']?\s*[:=]\s*["']([a-zA-Z0-9-]+)/i);
      return m ? (m[1] || m[2] || m[3]) : false;
    },
    async fetch(c) {
      const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${c.token}?includeCompensation=true`);
      const jobs = (data && Array.isArray(data.jobs)) ? data.jobs : [];
      const company = (data && data.organizationName) || resolveCompany(c.html, c.token, c.origin);
      return jobs.filter((j) => j.title).map((j) => makeJob({
        title: j.title,
        location: j.location || (j.secondaryLocations && j.secondaryLocations[0] && j.secondaryLocations[0].location) || 'Not specified',
        job_url: j.jobUrl || j.applyUrl, employer_name: company, employmentCode: j.employmentType,
        descHtml: j.descriptionHtml || j.descriptionPlain,
      }));
    },
  },

  // BREEZY — {company}.breezy.hr/json  (public positions feed)
  {
    name: 'breezy',
    detect: (c) => {
      if (/\.breezy\.hr$/i.test(c.host)) return c.host.replace(/\.breezy\.hr$/i, '');
      const m = String(c.html || '').match(/([a-z0-9-]+)\.breezy\.hr/i);
      return m ? m[1] : false;
    },
    async fetch(c) {
      const arr = await fetchJson(`https://${c.token}.breezy.hr/json`);
      const jobs = Array.isArray(arr) ? arr : [];
      const company = resolveCompany(c.html, c.token, c.origin);
      return jobs.filter((j) => j.name).map((j) => {
        const loc = (j.location && (j.location.name || [j.location.city, j.location.country].filter(Boolean).join(', '))) || 'Not specified';
        return makeJob({
          title: j.name, location: loc, job_url: j.url || `https://${c.token}.breezy.hr/p/${j._id}`,
          employer_name: company, employmentCode: j.type && j.type.name, descHtml: j.description,
        });
      });
    },
  },

  // WORKABLE — apply.workable.com/api/v1/widget/accounts/{account}?details=true
  {
    name: 'workable',
    detect: (c) => {
      if (/\.workable\.com$/i.test(c.host) && !/^apply\./i.test(c.host)) return c.host.replace(/\.workable\.com$/i, '');
      if (/apply\.workable\.com$/i.test(c.host)) return firstSeg(c.pathname) || false;
      const m = String(c.html || '').match(/([a-z0-9-]+)\.workable\.com|workable\.com\/(?:j|spi\/v3\/jobs\/)?([a-z0-9-]+)/i);
      return m ? (m[1] || m[2]) : false;
    },
    async fetch(c) {
      const data = await fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${c.token}?details=true`);
      const jobs = (data && Array.isArray(data.jobs)) ? data.jobs : [];
      const company = (data && data.name) || resolveCompany(c.html, c.token, c.origin);
      return jobs.filter((j) => j.title).map((j) => makeJob({
        title: j.title, location: [j.city, j.country].filter(Boolean).join(', ') || 'Not specified',
        job_url: j.url || j.application_url || j.shortlink, employer_name: company, employmentCode: j.type,
        descHtml: j.description, reqHtml: j.requirements,
      }));
    },
  },

  // WORKDAY — the JS-wall case. Page is a JS shell, but {tenant}.wdN.myworkdayjobs.com
  // exposes a JSON API at /wday/cxs/{tenant}/{site}/jobs (POST, paginated). Job detail
  // (description) at /wday/cxs/{tenant}/{site}{externalPath} (GET).
  {
    name: 'workday',
    detect: (c) => {
      if (/\.myworkdayjobs\.com$/i.test(c.host)) {
        const parts = c.host.split('.');                 // tenant.wdN.myworkdayjobs.com
        const segs = String(c.pathname || '').split('/').filter(Boolean);
        let site = segs[0]; if (/^[a-z]{2}-[A-Za-z]{2}$/.test(segs[0] || '')) site = segs[1];
        return { tenant: parts[0], host: c.host, site: site || null };
      }
      const m = String(c.html || '').match(/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:wday\/cxs\/[a-z0-9-]+\/)?([A-Za-z0-9_]+)/i);
      return m ? { tenant: m[1], host: `${m[1]}.${m[2]}.myworkdayjobs.com`, site: m[3] || null } : false;
    },
    async fetch(c) {
      const { tenant, host } = c.token;
      let site = c.token.site;
      if (!site) { const m = String(c.html || '').match(new RegExp('cxs\\/' + tenant + '\\/([A-Za-z0-9_]+)', 'i')); site = m ? m[1] : null; }
      if (!site) return [];
      const base = `https://${host}/wday/cxs/${tenant}/${site}`;
      const all = []; const CAP = 120;
      for (let offset = 0; offset < CAP; offset += 20) {
        let page; try { page = await postJson(`${base}/jobs`, { appliedFacets: {}, limit: 20, offset, searchText: '' }); } catch { break; }
        const posts = (page && Array.isArray(page.jobPostings)) ? page.jobPostings : [];
        all.push(...posts);
        if (posts.length < 20 || all.length >= (page.total || CAP)) break;
      }
      const company = resolveCompany(c.html, tenant, c.url || `https://${host}`);
      const jobs = await mapLimit(all.slice(0, CAP), 12, async (p) => {
        let descHtml = '';
        try { const d = await fetchJson(`${base}${p.externalPath}`); descHtml = (d && d.jobPostingInfo && d.jobPostingInfo.jobDescription) || ''; } catch {}
        return makeJob({ title: p.title, location: p.locationsText || 'Not specified', job_url: `https://${host}/${site}${p.externalPath}`, employer_name: company, descHtml });
      });
      return jobs.filter(Boolean).filter((j) => j.title);
    },
  },

  // SMARTRECRUITERS — api.smartrecruiters.com/v1/companies/{co}/postings (+ /postings/{id} detail)
  {
    name: 'smartrecruiters',
    detect: (c) => {
      if (/(careers|jobs)\.smartrecruiters\.com$/i.test(c.host)) return firstSeg(c.pathname) || false;
      const m = String(c.html || '').match(/api\.smartrecruiters\.com\/v1\/companies\/([A-Za-z0-9]+)|jobs\.smartrecruiters\.com\/([A-Za-z0-9]+)|["']?companyIdentifier["']?\s*[:=]\s*["']([A-Za-z0-9]+)/i);
      return m ? (m[1] || m[2] || m[3]) : false;
    },
    async fetch(c) {
      const company = c.token;
      const all = []; const CAP = 100;
      for (let offset = 0; offset < CAP; offset += 100) {
        let page; try { page = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${company}/postings?limit=100&offset=${offset}`); } catch { break; }
        const posts = (page && Array.isArray(page.content)) ? page.content : [];
        all.push(...posts);
        if (posts.length < 100) break;
      }
      const name = resolveCompany(c.html, company, c.origin);
      const jobs = await mapLimit(all.slice(0, CAP), 12, async (p) => {
        let descHtml = '', reqHtml = '';
        try { const d = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${company}/postings/${p.id}`); const s = (d && d.jobAd && d.jobAd.sections) || {}; descHtml = (s.jobDescription && s.jobDescription.text) || ''; reqHtml = (s.qualifications && s.qualifications.text) || ''; } catch {}
        const loc = p.location ? [p.location.city, p.location.region, p.location.country].filter(Boolean).join(', ') : 'Not specified';
        return makeJob({ title: p.name, location: loc, job_url: `https://jobs.smartrecruiters.com/${company}/${p.id}`, employer_name: name, employmentCode: p.typeOfEmployment && p.typeOfEmployment.label, descHtml, reqHtml });
      });
      return jobs.filter(Boolean).filter((j) => j.title);
    },
  },
  // ── EXTENDED ATS (fetch-verified keyless public APIs) ────────────────────────
  // TEAMTAILOR — {slug}.teamtailor.com/jobs.json (JSON Feed v1.1; item._jobposting = schema.org)
  {
    name: 'teamtailor',
    detect: (c) => {
      const m = c.host.match(/^([a-z0-9-]+)\.teamtailor\.com$/i); if (m) return m[1];
      const h = String(c.html || '').match(/([a-z0-9-]+)\.teamtailor\.com/i); return h ? h[1] : false;
    },
    async fetch(c) {
      const data = await fetchJson(`https://${c.token}.teamtailor.com/jobs.json`).catch(() => null);
      const items = data && Array.isArray(data.items) ? data.items : [];
      const company = (data && data.title) || resolveCompany(c.html, c.token, c.origin);
      return items.map((it) => {
        const jp = it._jobposting || {};
        const a = Array.isArray(jp.jobLocation) && jp.jobLocation[0] && jp.jobLocation[0].address ? jp.jobLocation[0].address : {};
        const loc = [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(', ');
        return makeJob({ title: it.title, location: loc || 'Not specified', job_url: it.url, employer_name: company, employmentCode: jp.employmentType, descHtml: it.content_html || jp.description || '' });
      }).filter((j) => j.title && j.job_url);
    },
  },

  // RIPPLING — ats.rippling.com/api/v2/board/{slug}/jobs (JSON, paginated)
  {
    name: 'rippling',
    detect: (c) => {
      if (/rippling\.com$/i.test(c.host)) { const b = c.pathname.match(/\/board\/([a-z0-9_-]+)\//i); if (b) return b[1]; const s = firstSeg(c.pathname); return (s && s !== 'api') ? s : false; }
      const m = String(c.html || '').match(/ats\.rippling\.com\/([a-z0-9_-]+)\/jobs/i) || String(c.html || '').match(/"board"\s*,\s*"([a-z0-9_-]+)"/i); return m ? m[1] : false;
    },
    async fetch(c) {
      const out = []; const company = resolveCompany(c.html, c.token, c.origin);
      for (let page = 0; page < 15; page++) {   // Rippling pagination is 0-indexed
        const data = await fetchJson(`https://ats.rippling.com/api/v2/board/${c.token}/jobs?page=${page}&pageSize=100&groupJobsByLocation=false`).catch(() => null);
        const items = data && Array.isArray(data.items) ? data.items : [];
        if (!items.length) break;
        for (const it of items) {
          const l = Array.isArray(it.locations) && it.locations[0] ? it.locations[0] : {};
          out.push(makeJob({ title: it.name, location: [l.city, l.state, l.country].filter(Boolean).join(', ') || (l.name || 'Not specified'), job_url: it.url || `https://ats.rippling.com/${c.token}/jobs/${it.id}`, employer_name: company, employmentCode: it.department && it.department.name }));
        }
        if (!data.totalPages || page + 1 >= data.totalPages) break;
      }
      return out.filter((j) => j.title);
    },
  },

  // JOBSCORE — careers.jobscore.com/careers/{slug}/feed (JSON despite the name)
  {
    name: 'jobscore',
    detect: (c) => {
      if (/careers\.jobscore\.com$/i.test(c.host)) { const m = c.pathname.match(/\/careers\/([^/?#]+)/i); return m ? m[1] : false; }
      const m = String(c.html || '').match(/careers\.jobscore\.com\/careers\/([a-z0-9-]+)/i); return m ? m[1] : false;
    },
    async fetch(c) {
      const data = await fetchJson(`https://careers.jobscore.com/careers/${c.token}/feed`).catch(() => null);
      const jobs = data && Array.isArray(data.jobs) ? data.jobs : [];
      const company = (data && data.company_name) || resolveCompany(c.html, c.token, c.origin);
      return jobs.map((j) => makeJob({ title: j.title, location: j.location || [j.city, j.state, j.country].filter(Boolean).join(', ') || 'Not specified', job_url: j.detail_url || j.apply_url, employer_name: company, employmentCode: j.job_type, descHtml: j.description })).filter((j) => j.title && j.job_url);
    },
  },

  // HOMERUN — feed.homerun.co/{slug} (Atom XML; all jobs in one request)
  {
    name: 'homerun',
    detect: (c) => {
      const m = c.host.match(/^([a-z0-9-]+)\.homerun\.co$/i); if (m && m[1] !== 'feed') return m[1];
      if (/feed\.homerun\.co$/i.test(c.host)) return firstSeg(c.pathname) || false;
      const h = String(c.html || '').match(/feed\.homerun\.co\/([a-z0-9-]+)/i); return h ? h[1] : false;
    },
    async fetch(c) {
      const xml = await fetchText(`https://feed.homerun.co/${c.token}`).catch(() => '');
      if (!/<entry/i.test(xml)) return [];
      const company = htmlUnescape((xml.match(/<feed[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim() || resolveCompany(c.html, c.token, c.origin);
      return xml.split(/<entry/i).slice(1).map((e) => {
        const title = htmlUnescape((e.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        const link = ((e.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) || e.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] || '').trim();
        const desc = (e.match(/<(?:description|content)[^>]*>([\s\S]*?)<\/(?:description|content)>/i) || [])[1] || '';
        return makeJob({ title, location: 'Not specified', job_url: link, employer_name: company, descHtml: desc });
      }).filter((j) => j.title && j.job_url);
    },
  },

  // CLEARCOMPANY — {slug}.hrmdirect.com/employment/rss.php?search=true (RSS)
  {
    name: 'clearcompany',
    detect: (c) => {
      const m = c.host.match(/^([a-z0-9-]+)\.hrmdirect\.com$/i); if (m) return m[1];
      const h = String(c.html || '').match(/([a-z0-9-]+)\.hrmdirect\.com/i); return h ? h[1] : false;
    },
    async fetch(c) {
      const xml = await fetchText(`https://${c.token}.hrmdirect.com/employment/rss.php?search=true`).catch(() => '');
      if (!/<item/i.test(xml)) return [];
      const company = resolveCompany(c.html, c.token, c.origin);
      return xml.split(/<item/i).slice(1).map((it) => {
        const title = htmlUnescape(((it.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '')).trim();
        const link = ((it.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '').trim();
        const desc = (it.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || '';
        return makeJob({ title, location: 'Not specified', job_url: link, employer_name: company, descHtml: desc });
      }).filter((j) => j.title && j.job_url);
    },
  },

  // COMEET — www.comeet.co/careers-api/2.0/company/{uid}/positions?token={token} (JSON array).
  // uid+token are PUBLIC (embedded in the employer's own careers page).
  {
    name: 'comeet',
    detect: (c) => {
      const html = String(c.html || '');
      const um = html.match(/company_uid["']?\s*[:=]\s*["']([0-9.]+)["']/i) || html.match(/careers-api\/2\.0\/company\/([0-9.]+)\//i) || c.pathname.match(/company\/([0-9.]+)\//i);
      const tm = html.match(/["']?token["']?\s*[:=]\s*["']([A-F0-9]{16,})["']/i) || (c.url || '').match(/[?&]token=([A-F0-9]{16,})/i);
      return (um && tm) ? { uid: um[1], tkn: tm[1] } : false;
    },
    async fetch(c) {
      const { uid, tkn } = c.token;
      const arr = await fetchJson(`https://www.comeet.co/careers-api/2.0/company/${uid}/positions?token=${tkn}&details=true`).catch(() => null);
      const list = Array.isArray(arr) ? arr : [];
      return list.map((p) => {
        const lo = p.location || {};
        const desc = Array.isArray(p.details) ? p.details.map((d) => d && d.value).filter(Boolean).join(' ') : '';
        return makeJob({ title: p.name, location: [lo.city, lo.state, lo.country].filter(Boolean).join(', ') || (lo.name || 'Not specified'), job_url: p.url_comeet_hosted_page || p.url_active_page, employer_name: p.company_name, employmentCode: p.employment_type, descHtml: desc });
      }).filter((j) => j.title && j.job_url);
    },
  },

  // EIGHTFOLD — {slug}.eightfold.ai/api/apply/v2/jobs?domain={companyDomain} (JSON positions[])
  {
    name: 'eightfold',
    detect: (c) => {
      const m = c.host.match(/^([a-z0-9-]+)\.eightfold\.ai$/i);
      const dm = String(c.html || '').match(/i18n_override_([a-z0-9.-]+\.[a-z]{2,})/i) || String(c.html || '').match(/[?&]domain=([a-z0-9.-]+\.[a-z]{2,})/i);
      if (m) return { slug: m[1], domain: (dm && dm[1]) || (m[1] + '.com') };
      const h = String(c.html || '').match(/([a-z0-9-]+)\.eightfold\.ai/i); return h ? { slug: h[1], domain: (dm && dm[1]) || (h[1] + '.com') } : false;
    },
    async fetch(c) {
      const { slug, domain } = c.token; const out = [];
      for (let start = 0; start < 2000;) {
        const data = await fetchJson(`https://${slug}.eightfold.ai/api/apply/v2/jobs?domain=${encodeURIComponent(domain)}&start=${start}&num=100&query=`).catch(() => null);
        const pos = data && Array.isArray(data.positions) ? data.positions : [];
        if (!pos.length) break;
        const company = resolveCompany(c.html, slug, c.origin);
        for (const p of pos) out.push(makeJob({ title: p.name, location: p.location || (Array.isArray(p.locations) ? p.locations.join(', ') : '') || 'Not specified', job_url: p.canonicalPositionUrl || `https://${slug}.eightfold.ai/careers/job/${p.id}`, employer_name: company, employmentCode: p.type, descHtml: p.job_description }));
        start += pos.length;
        if (!data.count || start >= data.count) break;
      }
      return out.filter((j) => j.title && j.job_url);
    },
  },

  // JAZZHR — {slug}.applytojob.com/apply/jobs/ (server-rendered HTML; stable job_title_link anchors)
  {
    name: 'jazzhr',
    detect: (c) => {
      const m = c.host.match(/^([a-z0-9-]+)\.applytojob\.com$/i); if (m) return m[1];
      const h = String(c.html || '').match(/([a-z0-9-]+)\.applytojob\.com/i); return h ? h[1] : false;
    },
    async fetch(c) {
      const html = await fetchText(`https://${c.token}.applytojob.com/apply/jobs/`).catch(() => '');
      const company = resolveCompany(c.html, c.token, c.origin) || nameFromHtmlOrDomain(html, c.origin);
      const re = /<a[^>]*class="job_title_link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      const seen = new Set(); const out = []; let m;
      while ((m = re.exec(html))) {
        const href = m[1].replace(/\?&?$/, ''); const title = htmlUnescape(strip(m[2])).trim();
        const url = /^https?:/i.test(href) ? href : `https://${c.token}.applytojob.com${href}`;
        if (!title || seen.has(url)) continue; seen.add(url);
        out.push(makeJob({ title, location: 'Not specified', job_url: url, employer_name: company }));
      }
      return out;
    },
  },

  // PHENOM — POST {careerHost}/widgets (refNum scraped from the careers HTML). Big enterprise skin.
  {
    name: 'phenom',
    detect: (c) => {
      const html = String(c.html || '');
      if (!/phenom|phApp|smashfly|phenompeople/i.test(html)) return false;
      const m = html.match(/["']refNum["']\s*:\s*["']([A-Za-z0-9_-]+)["']/);
      return m ? m[1] : false;
    },
    async fetch(c) {
      const host = c.origin; const refNum = c.token; const out = []; const size = 100;
      const company = resolveCompany(c.html, '', c.origin);
      for (let from = 0; from < 4000;) {
        const body = { lang: 'en', deviceType: 'desktop', country: 'us', pageName: 'search-results', ddoKey: 'refineSearch', size, from, clientName: 'cvapplyr', refNum, jobs: true, keywords: '', location: '', profileData: {} };
        const data = await postJson(`${host}/widgets`, body).catch(() => null);
        const rs = data && data.refineSearch;
        const jobs = rs && rs.data && Array.isArray(rs.data.jobs) ? rs.data.jobs : [];
        if (!jobs.length) break;
        for (const j of jobs) {
          out.push(makeJob({ title: j.title, location: j.location || [j.city, j.state, j.country].filter(Boolean).join(', ') || 'Not specified', job_url: j.applyUrl || `${host}/job/${j.jobId}`, employer_name: company, employmentCode: j.type, descHtml: j.descriptionTeaser || '' }));
        }
        from += jobs.length;
        if (from >= (rs.totalHits || 0)) break;
      }
      return out.filter((j) => j.title && j.job_url);
    },
  },

  // UKG PRO / ULTIPRO — POST recruiting.ultipro.com/{CODE}/JobBoard/{guid}/JobBoardView/LoadSearchResults
  {
    name: 'ukgpro',
    detect: (c) => {
      if (!/^(recruiting|recruiting2)\.ultipro\.com$/i.test(c.host)) {
        const h = String(c.html || '').match(/(recruiting2?\.ultipro\.com)\/([A-Za-z0-9]+)\/JobBoard\/([0-9a-f-]{36})/i);
        return h ? { host: h[1], code: h[2], guid: h[3] } : false;
      }
      const m = c.pathname.match(/\/([A-Za-z0-9]+)\/JobBoard\/([0-9a-f-]{36})/i);
      return m ? { host: c.host, code: m[1], guid: m[2] } : false;
    },
    async fetch(c) {
      const { host, code, guid } = c.token; const base = `https://${host}/${code}/JobBoard/${guid}`;
      const out = []; const Top = 50; const company = resolveCompany(c.html, code, c.origin);
      for (let Skip = 0; Skip < 3000;) {
        const data = await postJson(`${base}/JobBoardView/LoadSearchResults`, { opportunitySearch: { Top, Skip, QueryString: '', OrderBy: [], Filters: [] } }).catch(() => null);
        const ops = data && Array.isArray(data.opportunities) ? data.opportunities : [];
        if (!ops.length) break;
        for (const o of ops) {
          const L = Array.isArray(o.Locations) && o.Locations[0] ? o.Locations[0] : {};
          const a = L.Address || {};
          out.push(makeJob({ title: o.Title, location: L.LocalizedName || [a.City, a.State && a.State.Name, a.Country && a.Country.Name].filter(Boolean).join(', ') || 'Not specified', job_url: `${base}/OpportunityDetail?opportunityId=${o.Id}`, employer_name: company, employmentCode: o.FullTime ? 'Full-time' : null, descHtml: o.BriefDescription || '' }));
        }
        Skip += ops.length;
        if (Skip >= (data.totalCount || 0)) break;
      }
      return out.filter((j) => j.title);
    },
  },

  // PAYLOCITY — jobs are server-embedded as `window.pageData` in the careers HTML (no separate API)
  {
    name: 'paylocity',
    detect: (c) => (/recruiting\.paylocity\.com$/i.test(c.host) && /\/recruiting\/jobs\/All\//i.test(c.pathname)) ? (firstSeg(c.pathname) || true) : (/window\.pageData/.test(String(c.html || '')) && /paylocity/i.test(String(c.html || '')) ? true : false),
    async fetch(c) {
      let html = c.html || '';
      if (!/window\.pageData/.test(html)) html = await fetchText(c.url).catch(() => html);
      const pd = extractJsonAssign(html, 'window.pageData');
      const jobs = pd && Array.isArray(pd.Jobs) ? pd.Jobs : [];
      const company = (pd && pd.ModuleTitle) || resolveCompany(c.html, c.token, c.origin);
      return jobs.map((j) => {
        const L = j.JobLocation || {};
        return makeJob({ title: j.JobTitle, location: j.LocationName || [L.City, L.State, L.Country].filter(Boolean).join(', ') || 'Not specified', job_url: `https://recruiting.paylocity.com/Recruiting/Jobs/Apply/${j.JobId}`, employer_name: company, descHtml: j.Description || '' });
      }).filter((j) => j.title && j.job_url);
    },
  },

  // ICIMS — GET {prefix}-{slug}.icims.com/jobs/search?ss=1&in_iframe=1 (iframe HTML; iCIMS_Anchor rows)
  {
    name: 'icims',
    detect: (c) => {
      if (/^[a-z0-9-]+-[a-z0-9-]+\.icims\.com$/i.test(c.host)) return c.host;
      const h = String(c.html || '').match(/([a-z0-9-]+-[a-z0-9-]+\.icims\.com)/i); return h ? h[1] : false;
    },
    async fetch(c) {
      const base = `https://${c.token}/jobs/search?ss=1&in_iframe=1`;
      const out = []; const seen = new Set();
      // Employer = the icims subdomain slug (careers-peraton.icims.com → "Peraton").
      const slug = String(c.token).split('.')[0].replace(/^(careers|jobs|uscareers|us|apply|search|talent|www)-/i, '');
      const company = slug.replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, (ch) => ch.toUpperCase());
      for (let pr = 0; pr < 12; pr++) {
        const html = await fetchText(pr === 0 ? base : `${base}&pr=${pr}`).catch(() => '');
        if (!/iCIMS_Anchor/i.test(html)) break;
        const tags = html.match(/<a[^>]*class="[^"]*iCIMS_Anchor[^"]*"[^>]*>/gi) || [];
        let added = 0;
        for (const tag of tags) {
          const t = htmlUnescape((tag.match(/title="([^"]*)"/i) || [])[1] || '');
          let h = (tag.match(/href="([^"]+)"/i) || [])[1] || '';
          if (!t || !h) continue;
          const title = t.includes(' - ') ? t.split(' - ').slice(1).join(' - ').trim() : t.trim();
          h = h.replace(/([?&])in_iframe=1&?/i, '$1').replace(/[?&]$/, '');
          const url = /^https?:/i.test(h) ? h : `https://${c.token}${h}`;
          if (!title || seen.has(url)) continue; seen.add(url); added++;
          out.push(makeJob({ title, location: 'Not specified', job_url: url, employer_name: company }));
        }
        if (!added) break;
      }
      return out;
    },
  },

];

/**
 * Detect the ATS for a careers URL and return all its jobs (structured) or null.
 * @param {string} url     the careers/scrape URL
 * @param {string} rawHtml the already-fetched page HTML (for fingerprinting + name)
 * @returns {Promise<{ats:string, companyName:string, jobs:Array}|null>}
 */
// Provenance: are two brand-ish strings the same company? Substring match, or a STRONG
// shared prefix (≥6 chars AND ≥70% of the shorter string) — the old 4-char rule
// false-accepted unrelated brands (e.g. "celonis" vs "celebrity"). (M16)
function _brandRelated(a, b) {
  const na = String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const nb = String(b || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (na.length < 3 || nb.length < 3) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  let i = 0; while (i < na.length && i < nb.length && na[i] === nb[i]) i++;
  return i >= 6 && i >= Math.min(na.length, nb.length) * 0.7;
}

async function detectAndFetchAts(url, rawHtml = '') {
  let origin, host, pathname;
  try { const u = new URL(url); origin = u.origin; host = u.hostname.toLowerCase(); pathname = u.pathname; } catch { return null; }
  const targetRoot = rootDomain(host);
  const targetBrand = (targetRoot.split('.')[0] || targetRoot);
  const targetName = nameFromHtmlOrDomain(rawHtml, url);
  // If the URL is ITSELF an ATS board (the user/agent targeted it directly), trust it —
  // the provenance guard only applies when the target is a real EMPLOYER domain. The host
  // alternatives are ANCHORED to a real host boundary so a legit employer like "clever.co"
  // (contains "lever.co") doesn't bypass the guard. (H2)
  const targetIsAtsHost = /(^|\.)(greenhouse\.io|grnh\.se|lever\.co|ashbyhq\.com|myworkdayjobs\.com|smartrecruiters\.com|recruitee\.com|breezy\.hr|workable\.com|personio\.(de|com)|teamtailor\.com|jobvite\.com|icims\.com|bamboohr\.com|applytojob\.com|jobscore\.com|homerun\.co|rippling\.com|eightfold\.ai|hrmdirect\.com|comeet\.(co|com)|ultipro\.com|paylocity\.com)$/i.test(host);
  for (const a of adapters) {
    let token;
    try { token = a.detect({ url, origin, host, pathname, html: rawHtml }); } catch { token = false; }
    if (!token) continue;
    try {
      const jobs = await a.fetch({ url, origin, host, pathname, html: rawHtml, token });
      if (jobs && jobs.length > 0) {
        // ── PROVENANCE GUARD ──────────────────────────────────────────────────
        // The agent must NEVER return another employer's jobs. If the jobs are hosted
        // on a THIRD-PARTY ATS board (not the target's own domain), the board's identity
        // (its company name OR the detected token) MUST match the target employer. This
        // kills mis-detections like a stray <label for="location"> → a stranger's board.
        let jobRoot = ''; try { jobRoot = rootDomain(new URL(jobs[0].job_url || '').hostname); } catch {}
        const sameDomain = jobRoot && jobRoot === targetRoot;
        const boardCompany = jobs[0].employer_name || '';
        // Coerce object tokens (Workday returns {tenant, site}) to a string so the
        // provenance match doesn't see "[object Object]". (M14)
        const tokenStr = (token && typeof token === 'object') ? (token.tenant || token.token || token.slug || Object.values(token).filter((v) => typeof v === 'string').join('')) : token;
        const idMatch = [tokenStr, boardCompany].some((id) => _brandRelated(id, targetBrand) || _brandRelated(id, targetName));
        if (!targetIsAtsHost && !sameDomain && !idMatch) {
          console.log(`[atsDiscovery] ${a.name} REJECTED (provenance): board "${boardCompany}"/token "${token}" ≠ target "${targetBrand}"/"${targetName}" — not this employer`);
          continue;
        }
        const companyName = boardCompany || targetName;
        console.log(`[atsDiscovery] ${a.name}: ${jobs.length} jobs for "${companyName}"`);
        return { ats: a.name, companyName, jobs };
      }
    } catch (e) {
      console.log(`[atsDiscovery] ${a.name} detected but fetch failed: ${e.message}`);
    }
  }
  return null;
}

// ── Generic SPA job-API parser ────────────────────────────────────────────────
// Hard SPA career boards (e.g. Adyen) load their full job list via an XHR/GraphQL call
// AFTER render; our Playwright layer intercepts that JSON (interceptedJson) but the HTML
// handed to the LLM is just the empty shell. This parses the intercepted payload(s) into
// structured jobs directly — zero LLM cost, full board. Heavily provenance-guarded so a
// stray analytics/ads XHR can't inject jobs.
const _TITLE_KEYS = ['title', 'name', 'jobtitle', 'position', 'positionname', 'positiontitle', 'role', 'displayname', 'vacancyname', 'postingtitle'];
const _URL_KEYS = ['absolute_url', 'url', 'applyurl', 'joburl', 'link', 'href', 'canonicalurl', 'hostedurl', 'applicationurl', 'jobposturl', 'detailurl', 'permalink', 'applylink'];
const _LOC_KEYS = ['location', 'city', 'office', 'locationname', 'primarylocation', 'place', 'region', 'joblocation', 'locations', 'workplace', 'cities'];
const _SAL_KEYS = ['salary', 'salaryrange', 'compensation', 'payrange'];
const _EMP_KEYS = ['employmenttype', 'jobtype', 'contracttype', 'employment', 'schedule', 'worktype'];
const _MODE_KEYS = ['workplacetype', 'workmodel', 'workmode', 'remotetype', 'locationtype', 'remotestatus', 'workstyle'];
const _DESC_KEYS = ['description', 'jobdescription', 'content', 'body', 'summary', 'descriptionhtml'];

const _ci = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return undefined;
  const map = {}; for (const k of Object.keys(obj)) map[k.toLowerCase()] = obj[k];
  for (const k of keys) if (map[k] != null && map[k] !== '') return map[k];
  return undefined;
};
const _strv = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(_strv).filter(Boolean).join(', ');
  if (typeof v === 'object') return _strv(v.name || v.label || v.text || v.title || v.value || v.city || v.displayName || '');
  return '';
};
const _normMode = (s) => {
  const t = String(s || '').toLowerCase();
  if (!t) return null;
  if (/hybrid/.test(t)) return 'Hybrid';
  if (/remote|anywhere|work[\s-]?from[\s-]?home|telecommut/.test(t)) return 'Remote';
  if (/on[\s-]?site|in[\s-]?office|office|on[\s-]?premise/.test(t)) return 'Office';
  return null;
};
const _looksJobish = (o) => o && typeof o === 'object' && !Array.isArray(o) && !!_strv(_ci(o, _TITLE_KEYS));

// Walk an object (bounded depth) and return the LARGEST array of job-ish objects found.
function _findJobArray(root) {
  let best = [];
  const seen = new Set();
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      const jobish = node.filter(_looksJobish);
      if (jobish.length > best.length) best = jobish;
      for (const el of node) if (el && typeof el === 'object') visit(el, depth + 1);
      return;
    }
    if (seen.has(node)) return; seen.add(node);
    for (const k of Object.keys(node)) { const v = node[k]; if (v && typeof v === 'object') visit(v, depth + 1); }
  };
  visit(root, 0);
  return best;
}

function parseJobApiResponse(payload, sourceUrl, origin) {
  if (!payload) return { jobs: [] };
  let targetRoot = ''; try { targetRoot = rootDomain(new URL(origin || sourceUrl).hostname); } catch {}
  const blobs = String(payload).split('\n\n---PAYLOAD---\n\n');
  let best = [];
  for (const blob of blobs) {
    let data; try { data = JSON.parse(blob); } catch { continue; }
    const arr = _findJobArray(data);
    if (arr.length > best.length) best = arr;
  }
  if (best.length < 10) return { jobs: [] };   // provenance: a real board, not a tiny facet / ads XHR

  let employer = '';
  const jobs = best.map((o) => {
    const title = _strv(_ci(o, _TITLE_KEYS));
    let url = _strv(_ci(o, _URL_KEYS));
    if (url && !/^https?:/i.test(url)) { try { url = new URL(url, origin || sourceUrl).href; } catch { url = ''; } }
    const emp = _strv(_ci(o, ['company', 'companyname', 'employer', 'organization', 'brand']));
    if (!employer && emp) employer = emp;
    const desc = _strv(_ci(o, _DESC_KEYS));
    return {
      title,
      location: _strv(_ci(o, _LOC_KEYS)) || 'Not specified',
      job_url: url || null,
      job_type: jobType(_strv(_ci(o, _EMP_KEYS))),
      work_mode: _normMode(_strv(_ci(o, _MODE_KEYS))) || _normMode(title) || _normMode(_strv(_ci(o, _LOC_KEYS))),
      salary: formatSalary(_strv(_ci(o, _SAL_KEYS))) || null,
      experience: null,
      responsibilities: bulletsFrom(desc).slice(0, 10),
      skills: extractSkills(desc),
      employer_name: emp || null,
      _atsApi: true,
    };
  }).filter((j) => j.title);

  // Provenance: if we know the target root, at least one job URL must be same-root-domain
  // (filters cross-domain analytics/ads payloads that merely look list-shaped). Jobs with
  // no URL at all are allowed only when SOME sibling carries a matching-domain URL.
  if (targetRoot) {
    const withUrl = jobs.filter((j) => j.job_url);
    const sameRoot = withUrl.filter((j) => { try { return rootDomain(new URL(j.job_url).hostname) === targetRoot; } catch { return false; } }).length;
    if (withUrl.length > 0 && sameRoot === 0) return { jobs: [] };
  }
  if (jobs.length < 10) return { jobs: [] };

  return { employer: employer || null, jobs };
}

// SKIN → ATS: many "career sites" (Phenom/Happydance/Eightfold/custom) are a thin marketing
// skin over a real ATS — their pages embed the ATS apply/board link. Spot it so we can go
// straight to the ATS's clean public API (complete data + full descriptions + ~$0.001) instead
// of fighting the skin's bot-blocked SPA. Returns a normalized ATS board URL, or null.
function findEmbeddedAts(html) {
  const s = String(html || '');
  // Workday: {tenant}.wdN.myworkdayjobs.com/[lang/]{site}  — keep the site, drop lang / job / login.
  let m = s.match(/https?:\/\/([a-z0-9-]+\.wd\d+\.myworkdayjobs\.com)\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/i);
  if (m && !/^(job|login|introduceYourself|task|apply|search|home)$/i.test(m[2])) return `https://${m[1]}/${m[2]}`;
  m = s.match(/boards\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_]+)/i) || s.match(/greenhouse\.io\/embed\/job_board\?for=([a-z0-9_]+)/i);
  if (m) return `https://boards.greenhouse.io/${m[1]}`;
  m = s.match(/jobs\.lever\.co\/([a-z0-9-]+)/i); if (m) return `https://jobs.lever.co/${m[1]}`;
  m = s.match(/jobs\.ashbyhq\.com\/([a-z0-9-]+)/i); if (m) return `https://jobs.ashbyhq.com/${m[1]}`;
  m = s.match(/(?:careers|jobs)\.smartrecruiters\.com\/([A-Za-z0-9-]+)/i); if (m) return `https://careers.smartrecruiters.com/${m[1]}`;
  m = s.match(/([a-z0-9-]+)\.recruitee\.com/i); if (m) return `https://${m[1]}.recruitee.com`;
  m = s.match(/apply\.workable\.com\/([a-z0-9-]+)/i); if (m) return `https://apply.workable.com/${m[1]}`;
  m = s.match(/([a-z0-9-]+)\.jobs\.personio\.(?:com|de)/i); if (m) return `https://${m[1]}.jobs.personio.com`;
  m = s.match(/([a-z0-9-]+)\.breezy\.hr/i); if (m) return `https://${m[1]}.breezy.hr`;
  return null;
}

module.exports = { detectAndFetchAts, findEmbeddedAts, parseJobApiResponse, extractSkills, fetchText, fetchJson, postJson, mapLimit, makeJob, bulletsFrom, strip, jobType, formatSalary, nameFromHtmlOrDomain };
