// AI Hub — new feature. Safe to delete without affecting existing app.

/**
 * Represents a hiring contact associated with a specific job posting.
 */
export type Contact = {
  id: string;
  name: string;
  role: string;
  email: string;
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
  urgent: boolean;
  skills: string[];
  contacts: Contact[];
  matchScore?: number;   // 0–100, AI-computed resume match
  applyUrl?: string | null;
};

/**
 * Represents a target employer (company) with its job listings.
 */
export type Employer = {
  id: string;
  name: string;
  subInfo: string;
  logoColor: [string, string]; // gradient tuple for LinearGradient [from, to]
  logoInitial: string;
  status: 'active' | 'watching';
  jobs: Job[];
};

/**
 * Represents a pill/tag in the wishlist (target companies) bar.
 */
export type WishlistPill = {
  id: string;
  label: string;
  colorVariant: 'cyan' | 'violet' | 'emerald';
};
