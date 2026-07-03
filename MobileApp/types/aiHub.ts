// AI Hub — new feature. Safe to delete without affecting existing app.

/**
 * Represents a hiring contact associated with a specific job posting.
 */
export type Contact = {
  id: string;
  name: string;
  role: string;
  email: string;
  phone?: string | null;
  linkedin?: string | null;    // LinkedIn profile URL e.g. "https://linkedin.com/in/..."
  imageUrl?: string | null;    // Profile photo URL (from page HTML)
  verified: boolean;
  avatarColor: [string, string]; // gradient tuple for LinearGradient [from, to]
};

/**
 * Represents a single job posting with its associated contacts.
 */
export type Job = {
  id: string;
  title: string;
  location: string;
  experience: string;
  salary: string;
  jobType: string;
  workMode?: string | null;   // Remote / Hybrid / Office — work-location arrangement, distinct from jobType (employment type)
  urgent: boolean;
  skills: string[];
  responsibilities: string[];
  contacts: Contact[];
  matchScore?: number | null;   // 0–100 AI-computed resume match; null = not scored yet ("Evaluating…"); -1 = unscorable (no badge)
  createdAt?: string;    // ISO timestamp from the server, used to sort newest-first
  applyUrl?: string | null;
  lang?: string;         // detected language ('en' or e.g. 'de'); non-'en' shows the Translate toggle
  respTotal?: number;    // true responsibilities count — the dashboard LIST ships only the 3 the card shows; /jobs/:id/full has all
};

/**
 * Represents a target employer (company) with its job listings.
 */
export type Employer = {
  id: string;
  jobId?: string; // Optional reference to the async_jobs ID
  name: string;
  subInfo: string;
  logoColor: [string, string]; // gradient tuple for LinearGradient [from, to]
  logoInitial: string;
  status: 'active' | 'watching';
  domain?: string; // full registrable domain WITH TLD (e.g. vertigis.com) — for the company-card website
  jobs: Job[];
  totalJobs?: number;     // TRUE job count — the dashboard list ships only the top-matched page
  totalContacts?: number; // TRUE contact count across ALL the employer's matched jobs
};

/**
 * Represents a pill/tag in the wishlist (target companies) bar.
 */
export type WishlistPill = {
  id: string;
  label: string;
  colorVariant: 'cyan' | 'violet' | 'emerald';
  employerId?: string; // set once Gemini resolves, used to remove cards on pill delete
};
