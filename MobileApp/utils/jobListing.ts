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
  /wellfound\.com\/(jobs|role)/i,
  /(simplyhired|ziprecruiter|talent)\.[a-z.]+\/(search|jobs\?|q-)/i,
];

export function isListingUrl(u: string): boolean {
  const s = String(u || '');
  if (!s) return false;
  if (JOB_RE.some((r) => r.test(s))) return false;
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
// Allows a few keyword words between the number and "Jobs" ("500+ [.Net] Jobs", "1,234 [Dotnet] Openings").
export function listingCountFromTitle(title: string): string | null {
  const m = String(title || '').match(/([\d][\d,.]*\s*\+?)\s+(?:[a-z0-9.#+&()/-]+\s+){0,4}?(?:jobs?|openings?|vacanc)/i);
  return m ? m[1].replace(/\s+/g, '') : null;
}
