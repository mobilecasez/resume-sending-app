// AI Hub — new feature. Safe to delete without affecting existing app.
// Classify a search-result URL as a LISTING (a page of many jobs — "500+ .NET jobs in Gurgaon") vs an
// individual posting. Listing pages must never be fetched as ONE job; they get their own affordances:
// LinkedIn listings expand into individual cards in-place, everything else opens in the Browse & Fetch
// in-app browser where the user picks a job and taps the floating "Fetch" button.

// Individual-posting URL shapes (checked FIRST — a match here always wins over the listing patterns).
const JOB_RE: RegExp[] = [
  /linkedin\.com\/jobs\/view\//i,
  /indeed\.[a-z.]+\/(viewjob|m\/viewjob|rc\/clk)/i,
  /naukri\.com\/job-listings-/i,
  /glassdoor\.[a-z.]+\/job-listing\//i,
  /monsterindia\.com\/job\//i,
  /foundit\.(in|com)[^?#]*\/job\//i,
  /shine\.com\/jobs\/[^/]+\/\d/i,
  /timesjobs\.com\/job-detail/i,
  /wellfound\.com\/jobs\/\d/i,          // individual postings are /jobs/{numericId}-{slug}
];

// Listing / search-results URL shapes per major job board.
const LISTING_RE: RegExp[] = [
  /linkedin\.com\/jobs\/search/i,
  /linkedin\.com\/jobs\/[a-z0-9%+-]*-jobs(-[a-z0-9%+-]+)?\/?([?#]|$)/i,   // /jobs/dot-net-jobs-gurgaon
  /linkedin\.com\/jobs\/?([?#]|$)/i,
  /indeed\.[a-z.]+\/(q-[^/]+-jobs|jobs\?|m\/jobs|browsejobs)/i,
  /naukri\.com\/[a-z0-9-]*-jobs(-in-[a-z0-9-]+)?\/?([?#]|$)/i,            // /dot-net-jobs-in-gurgaon
  /naukri\.com\/[a-z0-9-]*-jobs\?/i,
  /glassdoor\.[a-z.]+\/(Job\/|Jobs\/|job\/[a-z-]*jobs)/i,
  /monsterindia\.com\/(srp|search)/i,
  /foundit\.(in|com)\/(srp|search)/i,
  /shine\.com\/job-search\//i,
  /timesjobs\.com\/.*job-search/i,
  /instahyre\.com\/search/i,
  /cutshort\.io\/jobs/i,
  /wellfound\.com\/(jobs\/?([?#]|$)|role\/)/i,   // only the /jobs index + /role/… browse pages, NOT /jobs/{id}-{slug}
  // Host-anchored (preceded by "//" or ".") with a constrained TLD so "talent." can't swallow a company
  // careers subdomain like talent.acmecorp.com — only the boards themselves (talent.com, ziprecruiter.com…).
  /(\/\/|\.)(simplyhired|ziprecruiter|talent)\.[a-z]{2,6}(\.[a-z]{2})?\/(search|jobs\?|q-)/i,
];

// A job-identifying QUERY PARAM means a specific job is open even when the PATH is a listing —
// SPA boards keep the search URL and open the job as an overlay: Glassdoor `?jl=`, Indeed
// `?vjk=`/`?jk=`, LinkedIn `?currentJobId=`, generic `jobId=`/`jobListingId=`/`jobkey=`.
const JOB_QUERY_RE = /[?&](jl|vjk|jk|jobid|joblistingid|jobkey|currentjobid)=[\w-]/i;

export function isListingUrl(u: string): boolean {
  const s = String(u || '');
  if (!s) return false;
  if (JOB_RE.some((r) => r.test(s))) return false;
  if (JOB_QUERY_RE.test(s)) return false;
  return LISTING_RE.some((r) => r.test(s));
}

// Parse a LinkedIn LISTING url into { keywords, location } so the expansion can also paginate the guest
// jobs API for depth. Handles both /jobs/search?keywords=&location= and /jobs/{kw}-jobs-{city} slugs.
export function parseLinkedInListing(u: string): { keywords: string; location: string } | null {
  const s = String(u || '');
  if (!/linkedin\.com\/jobs/i.test(s)) return null;
  try {
    const url = new URL(s);
    const qk = url.searchParams.get('keywords') || '';
    const ql = url.searchParams.get('location') || '';
    if (qk) return { keywords: qk, location: ql };
    const m = url.pathname.match(/\/jobs\/([a-z0-9%+-]+)-jobs(?:-([a-z0-9%+-]+))?\/?$/i);
    if (m) {
      const dec = (x: string) => decodeURIComponent(x || '').replace(/-/g, ' ').trim();
      return { keywords: dec(m[1]), location: dec(m[2] || '') };
    }
  } catch {}
  return null;
}

// Pull the advertised job count out of a listing card's title ("500+ .Net Jobs in Gurgaon" → "500+").
// Allows a few keyword words between the number and "Jobs" ("500+ [.Net] Jobs"), rejects experience
// figures ("5 Years Exp Jobs" — lookahead on years/yrs; digit-free bridge words so "(5-10 Years) - 500
// Vacancies" can't bridge 10→Vacancies), scans ALL matches keeping the largest, trims trailing ",.".
export function listingCountFromTitle(title: string): string | null {
  const s = String(title || '');
  const re = /([\d][\d,.]*\+?)(?!\s*(?:years?|yrs?)\b)\s+(?:[a-z.#+&]+\s+){0,4}?(?:jobs?|openings?|vacanc)/gi;
  let best: string | null = null; let bestVal = -1;
  for (const m of s.matchAll(re)) {
    const cap = m[1].replace(/[.,]+$/, '');
    const val = parseInt(cap.replace(/[^\d]/g, ''), 10) || 0;
    if (val > bestVal) { bestVal = val; best = cap; }
  }
  return best;
}
