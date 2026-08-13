// Shared normalisation for AI-extracted job fields.
//
// ⚠️ WHY THIS EXISTS: an extraction prompt that just asks for `"skills" (array of strings)` gets
// whatever the requirements section happened to say. Measured on the founder's saved Quickline AG
// job, the LinkedIn extractor returned these as "skills":
//
//   "Several years of experience in the software development of modern solutions, ideally in the
//    telecommunications environment"
//   "In-depth knowledge in the .NET environment"
//   "Enjoyment in implementing demanding technical solutions"
//
// …so the Saved card rendered three sentences as skill chips. The SAME posting, put through the
// capture pipeline's stricter prompt, produced ".NET · Kubernetes · Docker · Microservices · CI/CD".
// The card only looked right after opening the job because that is when the second pipeline ran.
//
// A prompt is a request, not a guarantee, so the shape is enforced here in code as well: whatever a
// model returns, only things actually SHAPED like a skill reach the database.
'use strict';

// Requirement bullets overwhelmingly open with one of these. A real skill never does.
const NOT_A_SKILL_START = /^(several|many|multiple|at least|minimum|min\.|in-?depth|deep|enjoyment|passion|experience|experienced|knowledge|familiarity|ability|able|capacity|strong|good|very good|excellent|proven|solid|sound|hands-on|fluent|fluency|willingness|willing|understanding|comfortable|confident|affinity|interest|degree|bachelor|master|university|you |your |we |our |the |a |an |ideally|preferably|nice to have|plus |and |or )/i;

/**
 * Keep only entries shaped like a skill NAME. Deliberately strict — a missing chip is a smaller
 * problem than a paragraph rendered as one, and the good chips are rarely the ones dropped.
 */
function cleanSkills(list, limit = 30) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(list) ? list : [])) {
    let s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    s = s.replace(/^[-–—•*•]\s*/, '').replace(/[.;:,]+$/, '').trim();
    if (!s) continue;
    if (s.length > 60) continue;                    // a sentence, not a skill
    if (s.split(' ').length > 6) continue;
    // A sentence BREAK, not any dot — ".NET", "Node.js" and "F#" are skills, "Ship it. Fast." is not.
    if (/[.!?]\s/.test(s) || /[!?]$/.test(s)) continue;
    if (NOT_A_SKILL_START.test(s)) continue;
    if (!/[A-Za-z0-9]/.test(s)) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Seniority read off the job title. Only a FALLBACK for when extraction returned nothing — the
 * posting's own words always win. Without it the Saved card showed no level at all until the job was
 * opened and a second, richer extraction ran.
 * Checked most-specific first; "Senior … (Technical Lead)" is a Senior role, so senior beats lead.
 */
function seniorityFromTitle(title) {
  const t = String(title || '');
  if (!t) return '';
  if (/\b(intern|internship|praktikum|stagiaire|trainee|apprentice)\b/i.test(t)) return 'Internship';
  if (/\b(junior|jr\.?|entry[- ]level|graduate|working student|werkstudent)\b/i.test(t)) return 'Junior';
  if (/\b(principal|staff)\b/i.test(t)) return 'Principal';
  if (/\b(senior|sr\.?|snr\.?)\b/i.test(t)) return 'Senior';
  if (/\b(lead|head of|director|vp|chief|cto|manager)\b/i.test(t)) return 'Lead';
  if (/\b(mid[- ]level|intermediate)\b/i.test(t)) return 'Mid-level';
  return '';
}

module.exports = { cleanSkills, seniorityFromTitle };
