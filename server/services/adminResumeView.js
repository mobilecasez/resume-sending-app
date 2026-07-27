// The admin's readable view of a user's résumé — and a PDF of it.
//
// WHY NOT JUST SERVE THE FILE. The admin page used to drop the uploaded PDF into a WebView. That
// fails in ways that look identical to "the file is gone": Android's system WebView cannot render
// PDFs at all, and the viewer is deliberately hardened (scripts off, empty originWhitelist, a
// same-URL navigation guard) because it renders a file a stranger uploaded into a screen holding an
// admin token. Loosening that to make PDFs render would be trading a real security property for a
// preview. So the primary view becomes the PARSED résumé, which is better anyway: it is the same
// content the matching engine and the cover-letter writer actually see. If those look wrong here,
// that is the bug — the PDF would have hidden it.
//
// TWO SOURCES, ONE SHAPE. `user_resumes.resume_data` (built in the app) is richest but rare — 6 of
// 109 users. `resume_metadata` is what the parser extracted from an upload and covers 26. Both are
// normalised to the same object so the UI never branches on provenance, and `source` says which one
// it got so the admin is never guessing.

const dbConfig = require('../../db-config');

const str = (v) => (v == null ? '' : String(v)).trim();
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * Skills arrive in at least four shapes across the two sources: string[], string[][],
 * [{group, items}], and — the builder's — a plain object {technical: [...], soft: [...]}. The last
 * one is why builder résumés showed ZERO skills in the first version of this view: the walker only
 * looked for known key names and a {technical, soft} object matched none of them. When no key is
 * recognised, walk the object's VALUES rather than giving up.
 */
function flattenSkills(v) {
  const out = [];
  const walk = (x, depth = 0) => {
    if (x == null || depth > 4) return;
    if (Array.isArray(x)) { x.forEach((e) => walk(e, depth + 1)); return; }
    if (typeof x === 'object') {
      const known = x.items || x.skills || x.values || x.name || x.label;
      if (known != null) { walk(known, depth + 1); return; }
      Object.values(x).forEach((e) => walk(e, depth + 1));
      return;
    }
    const s = str(x);
    if (s) out.push(s);
  };
  walk(v);
  const seen = new Set();
  return out.filter((s) => (seen.has(s.toLowerCase()) ? false : (seen.add(s.toLowerCase()), true)));
}

/** Pull one named group out of a {technical: [...], soft: [...]} skills object; [] otherwise. */
function skillGroup(v, ...keys) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  for (const k of keys) if (v[k] != null) return flattenSkills(v[k]);
  return [];
}

/** Education/experience rows arrive with wildly different key names. Read them all, emit one shape. */
function normEntries(v, kind) {
  return arr(v).map((e) => {
    if (typeof e === 'string') return { title: str(e), org: '', period: '', detail: '' };
    const o = e || {};
    return {
      title: str(o.title || o.role || o.position || o.degree || o.qualification || o.course || o.name),
      org: str(o.company || o.employer || o.organisation || o.organization || o.institution || o.school || o.university),
      period: str(o.period || o.duration || o.dates
        || [str(o.start_date || o.from || o.start), str(o.end_date || o.to || o.end)].filter(Boolean).join(' – ')),
      detail: str(o.description || o.summary || o.details || o.detail
        || (Array.isArray(o.highlights) ? o.highlights.join(' • ') : o.highlights)),
      location: str(o.location || o.city || o.place),
      kind,
    };
  }).filter((e) => e.title || e.org);
}

/** Parse a jsonb column that may already be an object, or may be a JSON string. */
function j(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch { return null; }
}

/**
 * Build the admin's résumé view for a user.
 * Returns { available, source, ... } — `available:false` when there is nothing parsed to show,
 * with `reason` explaining which of the two sources was empty so the admin can act on it.
 */
async function getResumeProfile(userId) {
  const id = parseInt(userId, 10);
  if (!id) return { available: false, reason: 'bad_user_id' };

  const u = await dbConfig.get(
    `SELECT id, full_name, email, phone_number, address, city, country, resume_path, photo_path, created_at
       FROM users WHERE id = $1 AND deleted_at IS NULL`, [id]).catch(() => null);
  if (!u) return { available: false, reason: 'user_not_found' };

  const [builderRow, meta] = await Promise.all([
    dbConfig.get(`SELECT resume_data, updated_at FROM user_resumes WHERE user_id = $1`, [id]).catch(() => null),
    dbConfig.get(`SELECT * FROM resume_metadata WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [id]).catch(() => null),
  ]);

  const file = {
    has_file: !!str(u.resume_path),
    stored_path: str(u.resume_path) || null,
    filename: str(u.resume_path).split('/').pop() || null,
    // The extension is all we can promise without touching disk; the download endpoint checks
    // existence for real and says so if the row points at nothing.
    ext: (str(u.resume_path).match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase() || null,
  };

  const identity = {
    full_name: str(u.full_name),
    email: str(u.email),
    phone: str(u.phone_number),
    location: [str(u.city), str(u.country)].filter(Boolean).join(', ') || str(u.address),
  };

  // ── Source A: the in-app builder résumé (richest) ──────────────────────────
  const rd = j(builderRow && builderRow.resume_data);
  if (rd && (rd.summary || arr(rd.experience).length || arr(rd.education).length)) {
    const pi = rd.personal_info || {};
    return {
      available: true,
      source: 'builder',
      source_label: 'Built in the app (resume builder)',
      updated_at: builderRow.updated_at || null,
      identity: {
        full_name: str(pi.full_name) || identity.full_name,
        email: str(pi.email) || identity.email,
        phone: str(pi.phone) || identity.phone,
        location: str(pi.location || pi.address) || identity.location,
        headline: str(pi.title || pi.headline),
        links: [pi.linkedin, pi.github, pi.website, pi.portfolio].map(str).filter(Boolean),
      },
      summary: str(rd.summary),
      skills: flattenSkills(rd.skills),
      technical_skills: skillGroup(rd.skills, 'technical', 'hard', 'tech'),
      soft_skills: skillGroup(rd.skills, 'soft', 'interpersonal'),
      experience_years: null,
      experience: normEntries(rd.experience, 'experience'),
      education: normEntries(rd.education, 'education'),
      projects: normEntries(rd.projects, 'project'),
      certifications: flattenSkills(rd.certifications),
      languages: flattenSkills(rd.languages),
      achievements: flattenSkills(rd.achievements),
      job_titles: [],
      industries: [],
      parse_status: 'builder',
      parsed_at: builderRow.updated_at || null,
      raw_text: '',
      file,
      can_render_pdf: true,
    };
  }

  // ── Source B: what the parser pulled out of the uploaded file ──────────────
  if (!meta) {
    return {
      available: false, reason: 'never_parsed', file, identity,
      detail: file.has_file
        ? 'A résumé file is on record but it was never parsed, so there is nothing structured to show. Download the file below.'
        : 'This user has not uploaded a résumé.',
    };
  }
  const parsed = {
    available: true,
    source: 'parsed',
    source_label: 'Extracted from the uploaded file',
    updated_at: meta.parsed_at || meta.updated_at || null,
    identity,
    summary: str(meta.summary),
    skills: flattenSkills(meta.skills),
    technical_skills: flattenSkills(j(meta.technical_skills)),
    soft_skills: flattenSkills(meta.soft_skills),
    experience_years: meta.experience_years == null ? null : Number(meta.experience_years),
    experience_summary: str(meta.experience_summary),
    experience: [],
    education: normEntries(j(meta.education), 'education'),
    projects: [],
    certifications: flattenSkills(j(meta.certifications)),
    languages: flattenSkills(j(meta.languages)),
    achievements: [],
    job_titles: flattenSkills(j(meta.job_titles)),
    industries: flattenSkills(j(meta.industries)),
    parse_status: str(meta.parse_status) || null,
    parse_error: str(meta.parse_error) || null,
    parsed_at: meta.parsed_at || null,
    raw_text: str(meta.raw_text),
    file,
    can_render_pdf: true,
  };

  const empty = !parsed.summary && !parsed.skills.length && !parsed.technical_skills.length
    && !parsed.education.length && !parsed.raw_text;
  if (empty) {
    return {
      available: false,
      reason: parsed.parse_status === 'error' ? 'parse_failed' : 'parsed_but_empty',
      parse_error: parsed.parse_error,
      file,
      identity,
      detail: parsed.parse_status === 'error'
        ? `Parsing this résumé failed${parsed.parse_error ? `: ${parsed.parse_error}` : '.'} Nothing was extracted, which means matching and cover letters have nothing to work from either.`
        : 'The résumé was processed but produced no usable content — matching and cover letters are running blind for this user.',
    };
  }
  return parsed;
}

/**
 * Shape the profile into the object the résumé TEMPLATES expect, so the admin's "generate PDF"
 * runs the exact renderer users get rather than a lookalike. A parsed résumé has no per-role
 * entries, so its body becomes the summary plus the skill groups — honest about what we hold.
 */
function toTemplateResume(p) {
  const idy = p.identity || {};
  const bullet = (label, items) => (items && items.length
    ? { title: label, company: '', period: '', description: items.join(' • ') } : null);

  const experience = p.experience && p.experience.length
    ? p.experience.map((e) => ({
        title: e.title, company: e.org, period: e.period, location: e.location, description: e.detail,
      }))
    : [
        p.experience_summary ? { title: 'Experience', company: '', period: p.experience_years ? `${p.experience_years} yrs` : '', description: p.experience_summary } : null,
        bullet('Industries', p.industries),
        bullet('Previous titles', p.job_titles),
      ].filter(Boolean);

  return {
    personal_info: {
      full_name: idy.full_name || '', email: idy.email || '', phone: idy.phone || '',
      location: idy.location || '', title: idy.headline || (p.job_titles || [])[0] || '',
    },
    summary: p.summary || '',
    skills: [...(p.skills || []), ...(p.technical_skills || []), ...(p.soft_skills || [])].slice(0, 60),
    experience,
    education: (p.education || []).map((e) => ({
      degree: e.title, institution: e.org, period: e.period, description: e.detail,
    })),
    projects: (p.projects || []).map((e) => ({ name: e.title, description: e.detail })),
    certifications: p.certifications || [],
    languages: p.languages || [],
    achievements: p.achievements || [],
  };
}

module.exports = { getResumeProfile, toTemplateResume, flattenSkills, skillGroup, normEntries };
