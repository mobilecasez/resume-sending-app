// Admin notification TEMPLATE CATALOGUE — ADDITIVE. Pure data + pure functions, no DB access.
//
// Every template is a ready-to-send push/in-app message the admin can fire at ONE user (from the
// user-detail page) or at a whole SEGMENT. A template carries:
//   key          stable id (also the dedupe key in admin_notification_log)
//   label        short human name for the admin UI
//   description  what it does / when to use it
//   category     ⚠️ MUST be a real notification_preferences column — that is how opt-outs are honoured
//                (replies | application_updates | reminders | digest | marketing)
//   notifType    the in-app notifications.type bucket (matches the types the existing feed renders)
//   title(ctx)   push + in-app title
//   body(ctx)    push + in-app body
//   route        deep-link route for the push data payload
//   params(ctx)  deep-link params for the push data payload
//   suggestWhen(state) → { suggested?, applicable?, reason? } — relevance for THIS user's live state
//
// DEEP-LINK CONTRACT (data = { route, params }) — the routes the app handles, and nothing else:
//   '/(discover)' + { jobId }        → Explore opens that one job's detail
//   '/(discover)' + { sort:'match' } → Explore, best matches first
//   '/(ai-hub)'                      → Job Hub dashboard (optional { tab:'search'|'saved'|'myjobs' })
//   'profile'  + { section }           → App.js profile screen via the AsyncStorage handoff
//   'help'                           → in-app tutorial
//   'support'  + { focus:'1' }        → Help & support; focus opens the "what went wrong" picker
//   'usage'                          → Plans & Usage (quota, trial state, bonus)
//   'rewards'                        → Earn free credits
// Do NOT invent a new route value here without the app-side handler learning it first — an unknown
// route degrades to "just open the app", which is safe but wastes the notification. The app side is
// MobileApp/services/pushRouting.ts (resolveRoute) and its test MobileApp/scripts/test-push-routing.js.
//
// ⚠️ 'support', 'usage' and 'rewards' were added in app build 143. Older installs do not know them
// and will land on "just open the app" — acceptable degradation, but it is why these three are only
// used by nudges whose value survives the user arriving at the home screen.
'use strict';

// The five real notification_preferences columns. A category outside this list is NEVER gated
// (notificationPrefs.isEnabled fails open on unknown categories), so straying from it silently
// breaks opt-outs. Kept here so the catalogue can self-validate.
const PREF_CATEGORIES = ['replies', 'application_updates', 'reminders', 'digest', 'marketing'];

// ── small pure helpers ───────────────────────────────────────────────────────
const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};
const nOf = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
// The user's first name, or null when we have nothing usable.
// ⚠️ Returns NULL rather than a filler like "there": every call site puts this at the START of a
// lock-screen title, so a filler produced "there, add your résumé" — lowercase, mid-sentence, and
// obviously a broken mail-merge. Placeholder names people actually sign up with are rejected too;
// "Hi User" reads worse than no greeting at all.
const PLACEHOLDER_NAMES = /^(user|test|testing|admin|demo|guest|none|na|null|undefined|unknown|abc|asdf|qwerty)$/i;
const firstName = (ctx) => {
  const raw = String((ctx && (ctx.firstName || ctx.fullName)) || '').trim();
  const f = (raw.split(/\s+/)[0] || '').replace(/[^\p{L}\p{M}'-]/gu, '');
  if (!f || f.length < 2 || f.length > 20) return null;
  if (PLACEHOLDER_NAMES.test(f)) return null;
  if (!/\p{L}/u.test(f)) return null;
  return f;
};
/** `named` gets the name interpolated; `plain` is the version that reads correctly without one. */
const greet = (ctx, named, plain) => { const n = firstName(ctx); return n ? named(n) : plain; };
const S = (ctx) => (ctx && ctx.state) || {};
const J = (ctx) => (ctx && ctx.job) || null;

// ── the catalogue ────────────────────────────────────────────────────────────
const TEMPLATES = [
  // ── announcements ─────────────────────────────────────────────────────────
  {
    key: 'whats_new',
    label: 'What’s new (release announcement)',
    description: 'Release highlights — written for 3.4 (Google job search, the step-by-step guide, in-app support). Use overrides to adapt it for later releases. Opens the Jobs page.',
    category: 'marketing',
    notifType: 'jobs',
    route: '/(discover)',
    params: () => ({}),
    title: (ctx) => greet(ctx, (n) => `${n}, CVApplyr just got a big upgrade ✨`, 'CVApplyr just got a big upgrade ✨'),
    body: () => 'Search jobs on the real Google inside the app, follow the new step-by-step guide, and chat with support any time. Plus faster job details and many fixes — update and try it!',
    suggestWhen: () => ({ suggested: true, reason: 'Release announcement — applies to every reachable user.' }),
  },
  // ── job discovery ─────────────────────────────────────────────────────────
  {
    key: 'best_matches',
    label: 'Your best matches',
    description: 'Opens Explore sorted by résumé match. The default "come back and look at jobs" nudge.',
    category: 'marketing',
    notifType: 'jobs',
    route: '/(discover)',
    params: () => ({ sort: 'match' }),
    title: (ctx) => {
      const n = nOf(S(ctx).strongMatches);
      return n ? `${n} strong ${n === 1 ? 'match' : 'matches'} waiting 🎯` : 'Your best job matches are ready 🎯';
    },
    body: (ctx) => {
      const s = S(ctx);
      const top = s.topMatch;
      if (top && top.title) return clip(`${top.match}% match — ${top.title}${top.employer_name ? ` at ${top.employer_name}` : ''}. Tap to see the rest.`, 180);
      return s.field
        ? `Fresh ${s.field} roles ranked against your résumé. Tap to see the best ones.`
        : 'Jobs ranked against your résumé. Tap to see the best ones.';
    },
    suggestWhen: (s) => {
      if (!s.hasParsedResume) return { applicable: false, reason: 'No parsed résumé — nothing to match jobs against.' };
      if (!nOf(s.strongMatches)) return { suggested: false, reason: 'Résumé parsed, but no job currently scores 50%+.' };
      if (s.daysSinceLastSeen != null && s.daysSinceLastSeen < 2) return { suggested: false, reason: 'Opened the app in the last 2 days — already looking.' };
      return { suggested: true, reason: `${s.strongMatches} jobs at 50%+ match, last seen ${s.daysSinceLastSeen == null ? 'never' : s.daysSinceLastSeen + 'd ago'}.` };
    },
  },
  {
    key: 'specific_job',
    label: 'One specific job',
    description: 'Hand-picks a single job and deep-links straight to it. Requires a jobId (use the Matched jobs list).',
    category: 'marketing',
    notifType: 'jobs',
    needsJob: true,
    route: '/(discover)',
    params: (ctx) => {
      const j = J(ctx);
      return j && j.id ? { jobId: String(j.id) } : {};
    },
    title: (ctx) => {
      const j = J(ctx);
      if (!j) return 'A job picked for you 🎯';
      const m = nOf(j.match);
      return clip(m ? `${m}% match: ${j.title}` : `New role for you: ${j.title}`, 90);
    },
    body: (ctx) => {
      const j = J(ctx);
      if (!j) return 'Tap to see the role.';
      const bits = [];
      if (j.employer_name) bits.push(j.employer_name);
      if (j.location) bits.push(j.location);
      if (j.work_mode) bits.push(j.work_mode);
      if (j.salary) bits.push(j.salary);
      const line = bits.join(' · ');
      return clip(line ? `${line}. Tap to see the full role and apply.` : 'Tap to see the full role and apply.', 180);
    },
    suggestWhen: (s) => {
      if (!s.hasParsedResume) return { applicable: false, reason: 'No parsed résumé — no match score to pick a job with.' };
      if (!nOf(s.matchedJobCount)) return { applicable: false, reason: 'No matching jobs in the feed right now.' };
      const top = s.topMatch;
      if (top && nOf(top.match) >= 60) return { suggested: true, reason: `Top match is ${top.match}% (${top.title}).` };
      return { suggested: false, reason: 'Matches exist but none is strong enough (60%+) to single out.' };
    },
  },
  {
    key: 'new_jobs_in_field',
    label: 'New jobs in your field this week',
    description: 'Weekly "fresh roles in {field}" nudge. Only meaningful once the résumé has been classified.',
    category: 'marketing',
    notifType: 'jobs',
    route: '/(discover)',
    params: () => ({ sort: 'match' }),
    title: (ctx) => {
      const s = S(ctx);
      const n = nOf(s.newJobsThisWeek);
      if (n && s.field) return clip(`${n} new ${s.field} ${n === 1 ? 'job' : 'jobs'} this week`, 90);
      return n ? `${n} new ${n === 1 ? 'job' : 'jobs'} this week` : 'New jobs added this week';
    },
    body: (ctx) => {
      const s = S(ctx);
      return s.field
        ? `Fresh ${s.field} roles landed on CVApplyr. Tap to see the ones that fit your résumé.`
        : 'Fresh roles landed on CVApplyr. Tap to see the ones that fit your résumé.';
    },
    suggestWhen: (s) => {
      if (!s.field) return { applicable: false, reason: 'No field derived from the résumé yet.' };
      const n = nOf(s.newJobsThisWeek);
      if (!n) return { suggested: false, reason: `No new ${s.field} jobs added in the last 7 days.` };
      return { suggested: n >= 5, reason: `${n} new ${s.field} jobs in the last 7 days.` };
    },
  },
  {
    key: 'welcome_back_dormant',
    label: 'Welcome back (dormant)',
    description: 'Re-engagement for users who have not opened the app in a while.',
    category: 'marketing',
    notifType: 'jobs',
    route: '/(discover)',
    params: () => ({ sort: 'match' }),
    title: (ctx) => greet(ctx, (n) => `${n}, new jobs landed while you were away 👋`, 'New jobs landed while you were away 👋'),
    body: (ctx) => {
      const s = S(ctx);
      const n = nOf(s.strongMatches);
      if (n) return `${plural(n, 'job')} now match your résumé at 50%+. Two minutes is all it takes to look.`;
      return 'We added thousands of new roles since your last visit. Tap to see what fits you now.';
    },
    suggestWhen: (s) => {
      if (s.daysSinceLastSeen == null) return { suggested: false, reason: 'No app activity on record — cannot tell if they are dormant.' };
      if (s.daysSinceLastSeen < 7) return { suggested: false, reason: `Last seen ${s.daysSinceLastSeen}d ago — not dormant yet.` };
      return { suggested: true, reason: `Last seen ${s.daysSinceLastSeen}d ago.` };
    },
  },

  // ── setup / activation ────────────────────────────────────────────────────
  {
    key: 'upload_resume',
    label: 'Upload your résumé',
    description: 'The single highest-leverage nudge — without a résumé nothing in the app works.',
    category: 'reminders',
    notifType: 'profile',
    route: 'profile',
    params: () => ({ section: 'resume' }),
    title: (ctx) => greet(ctx, (n) => `${n}, add your résumé to unlock matches 📄`, 'Add your résumé to unlock matches 📄'),
    body: () => 'One upload and every job gets a match score against your real experience. Takes 30 seconds.',
    suggestWhen: (s) => {
      if (s.hasResume) return { applicable: false, reason: 'A résumé is already on file.' };
      return { suggested: true, reason: 'No résumé uploaded — the app cannot match or apply without one.' };
    },
  },
  {
    key: 'complete_profile',
    label: 'Complete your profile',
    description: 'Generic profile-completion nudge. Names the biggest gap in the body.',
    category: 'reminders',
    notifType: 'profile',
    route: 'profile',
    params: (ctx) => {
      const miss = (S(ctx).completeness && S(ctx).completeness.missing) || [];
      const focusable = ['resume', 'photo', 'signature'];
      const hit = miss.find((m) => focusable.includes(m));
      return { section: hit || 'profile' };
    },
    title: (ctx) => {
      const p = nOf((S(ctx).completeness || {}).percent);
      return p ? `Your profile is ${p}% complete` : 'Finish setting up your profile';
    },
    body: (ctx) => {
      const miss = (S(ctx).completeness && S(ctx).completeness.missing) || [];
      const nice = { resume: 'your résumé', photo: 'a photo', signature: 'your signature', phone_number: 'your phone number', address: 'your address', date_of_birth: 'your date of birth', full_name: 'your name' };
      const named = miss.slice(0, 2).map((m) => nice[m] || m).join(' and ');
      return named
        ? `Add ${named} and your applications go out complete — recruiters skip half-finished profiles.`
        : 'A complete profile means faster, stronger applications. Tap to finish it.';
    },
    suggestWhen: (s) => {
      const p = nOf((s.completeness || {}).percent);
      if (p >= 100) return { applicable: false, reason: 'Profile is already 100% complete.' };
      if (p < 70) return { suggested: true, reason: `Profile only ${p}% complete.` };
      return { suggested: false, reason: `Profile ${p}% complete — close enough that a targeted nudge works better.` };
    },
  },
  {
    key: 'add_photo',
    label: 'Add a profile photo',
    description: 'Targeted nudge for the missing profile picture.',
    category: 'reminders',
    notifType: 'profile',
    route: 'profile',
    params: () => ({ section: 'photo' }),
    title: () => 'Add a photo to your profile 📸',
    body: () => 'Applications with a photo feel personal. It takes one tap and it is reused everywhere.',
    suggestWhen: (s) => {
      if (s.hasPhoto) return { applicable: false, reason: 'Photo already uploaded.' };
      if (!s.hasResume) return { suggested: false, reason: 'Résumé is missing — nudge that first, it matters far more.' };
      return { suggested: true, reason: 'Résumé is in place but there is no photo.' };
    },
  },
  {
    key: 'add_signature',
    label: 'Add your signature',
    description: 'Targeted nudge for the missing signature (used on generated cover letters).',
    category: 'reminders',
    notifType: 'profile',
    route: 'profile',
    params: () => ({ section: 'signature' }),
    title: () => 'Sign off your cover letters ✍️',
    body: () => 'Add your signature once and every cover letter you generate is properly signed.',
    suggestWhen: (s) => {
      if (s.hasSignature) return { applicable: false, reason: 'Signature already uploaded.' };
      if (!s.hasResume) return { suggested: false, reason: 'Résumé is missing — nudge that first.' };
      return { suggested: true, reason: 'Résumé is in place but there is no signature.' };
    },
  },
  {
    key: 'profile_complete_celebrate',
    label: 'Profile complete — celebrate',
    description: 'Positive reinforcement the moment setup is finished, with a push into the job feed.',
    category: 'reminders',
    notifType: 'profile',
    route: '/(discover)',
    params: () => ({ sort: 'match' }),
    title: (ctx) => greet(ctx, (n) => `Nice work, ${n} — your profile is complete ✅`, 'Your profile is complete ✅'),
    body: (ctx) => {
      const n = nOf(S(ctx).strongMatches);
      return n
        ? `${plural(n, 'job')} already match you at 50%+. Tap to see them.`
        : 'Everything is set up. Tap to see the jobs that fit you best.';
    },
    suggestWhen: (s) => {
      const p = nOf((s.completeness || {}).percent);
      if (p < 100) return { applicable: false, reason: `Profile is only ${p}% complete.` };
      if (nOf(s.applications)) return { suggested: false, reason: 'Already applied to something — the celebration has passed.' };
      return { suggested: true, reason: 'Profile is complete but no application has been sent yet.' };
    },
  },
  {
    key: 'resume_parse_failed',
    label: 'Résumé could not be read',
    description: 'Tells a user whose résumé parse failed to re-upload — otherwise they silently get no match scores.',
    category: 'application_updates',
    notifType: 'error',
    route: 'profile',
    params: () => ({ section: 'resume' }),
    title: () => 'We could not read your résumé',
    body: () => 'Re-upload it as a PDF or Word file and every job will show how well you match. Tap to fix it.',
    suggestWhen: (s) => {
      if (!s.hasResume) return { applicable: false, reason: 'No résumé on file at all — use "Upload your résumé".' };
      // ⚠️ Only a real parse ERROR counts. Judging by "no skills extracted" would tell someone whose
      // résumé parsed perfectly well that we could not read it — alarming, and untrue: a valid
      // résumé can legitimately yield no recognised skills, and 'pending' just means not finished yet.
      const st = String(s.parseStatus || '').toLowerCase();
      if (st === 'error') return { suggested: true, reason: 'Résumé parse_status = error — they get no match scores until it is re-uploaded.' };
      if (st === 'pending' || !st) return { applicable: false, reason: `Parse is ${st || 'not recorded'}, not failed — wait for it to finish.` };
      return { applicable: false, reason: 'Résumé parsed fine.' };
    },
  },
  {
    key: 'how_it_works',
    label: 'How CVApplyr works (tutorial)',
    description: 'Opens the in-app video tutorial. For users who signed up and then stalled.',
    category: 'reminders',
    notifType: 'reminder',
    route: 'help',
    params: () => ({}),
    title: () => 'See how CVApplyr works in 60 seconds ▶️',
    body: () => 'Short guides: find jobs, generate a cover letter, and apply without retyping anything.',
    suggestWhen: (s) => {
      if (nOf(s.applications)) return { suggested: false, reason: 'Already applied — they know how it works.' };
      if (nOf(s.searches)) return { suggested: false, reason: 'Already searched — partly activated.' };
      if (nOf(s.daysSinceSignup) < 1) return { suggested: false, reason: 'Signed up today — give them a moment.' };
      return { suggested: true, reason: `Signed up ${s.daysSinceSignup}d ago with no search and no application.` };
    },
  },

  // ── mid-funnel: they looked but did not finish ────────────────────────────
  {
    key: 'generate_cover_letter',
    label: 'Generate a cover letter',
    description: 'For users with saved jobs but no cover letter yet — the step right before applying.',
    category: 'reminders',
    notifType: 'reminder',
    route: '/(ai-hub)',
    params: () => ({ tab: 'saved' }),
    title: () => 'Your cover letter writes itself ✍️',
    body: (ctx) => {
      const n = nOf(S(ctx).savedJobs);
      return n
        ? `You have ${plural(n, 'saved job')}. Tap one and CVApplyr drafts a tailored cover letter in seconds.`
        : 'Pick a job and CVApplyr drafts a tailored cover letter in seconds.';
    },
    suggestWhen: (s) => {
      if (nOf(s.coverLetters)) return { suggested: false, reason: 'Has already generated a cover letter.' };
      if (!nOf(s.savedJobs)) return { applicable: false, reason: 'No saved jobs to write a letter for.' };
      return { suggested: true, reason: `${s.savedJobs} saved jobs and zero cover letters.` };
    },
  },
  {
    key: 'saved_not_applied',
    label: 'Saved but never applied',
    description: 'The strongest intent signal in the app: they saved a job and stopped.',
    category: 'reminders',
    notifType: 'reminder',
    route: '/(ai-hub)',
    params: () => ({ tab: 'saved' }),
    title: (ctx) => {
      const n = nOf(S(ctx).savedJobs);
      return n ? `${plural(n, 'saved job')} still waiting` : 'Your saved jobs are waiting';
    },
    body: () => 'Postings close fast. Tap to finish the application while it is still open.',
    suggestWhen: (s) => {
      if (!nOf(s.savedJobs)) return { applicable: false, reason: 'Has not saved any job.' };
      if (nOf(s.applications)) return { suggested: false, reason: 'Already applied to something.' };
      return { suggested: true, reason: `${s.savedJobs} saved jobs and no application sent.` };
    },
  },
  {
    key: 'finish_first_application',
    label: 'Cover letter ready — finish applying',
    description: 'They generated a cover letter and never applied. Highest-intent stall in the funnel.',
    category: 'reminders',
    notifType: 'reminder',
    route: '/(ai-hub)',
    params: () => ({ tab: 'myjobs' }),
    title: () => 'Your cover letter is ready — send it 🚀',
    body: (ctx) => {
      const n = nOf(S(ctx).coverLetters);
      return n
        ? `${plural(n, 'cover letter')} generated and not sent yet. Tap to finish the application.`
        : 'Your cover letter is written and waiting. Tap to finish the application.';
    },
    suggestWhen: (s) => {
      if (!nOf(s.coverLetters)) return { applicable: false, reason: 'No cover letter generated yet.' };
      if (nOf(s.applications)) return { suggested: false, reason: 'Already applied to something.' };
      return { suggested: true, reason: `${s.coverLetters} cover letters generated, zero applications.` };
    },
  },
  {
    key: 'stalled_application',
    label: 'Follow up on a stalled application',
    description: 'An application sent a while ago with no reply — nudge a follow-up.',
    category: 'reminders',
    notifType: 'reminder',
    route: '/(ai-hub)',
    params: () => ({ tab: 'myjobs' }),
    title: () => 'Time for a follow-up?',
    body: (ctx) => {
      const p = S(ctx).pendingApplication;
      if (p && p.company) return clip(`No reply from ${p.company} after ${plural(nOf(p.days), 'day')}. A short follow-up often unsticks it.`, 180);
      return 'One of your applications has had no reply. A short follow-up often unsticks it.';
    },
    suggestWhen: (s) => {
      const p = s.pendingApplication;
      if (!p) return { applicable: false, reason: 'No application older than 7 days without a reply.' };
      return { suggested: true, reason: `${p.company || 'An application'} sent ${p.days}d ago with no reply.` };
    },
  },

  // ── credits ───────────────────────────────────────────────────────────────
  {
    key: 'low_credits',
    label: 'Running low on credits',
    description: 'Balance is nearly spent. Opens Job Hub, where the credit balance and top-up live.',
    // ⚠️ 'marketing', not 'application_updates'. This asks the user to spend money, so it must obey
    // the opt-out people actually use to stop being sold to. Filed under application_updates it
    // reached users who had switched OFF both marketing AND reminders — the one category nobody
    // turns off is the one carrying "top up", which is precisely the abuse the toggle exists to stop.
    category: 'marketing',
    notifType: 'credits',
    route: '/(ai-hub)',
    params: () => ({}),
    title: (ctx) => (nOf(S(ctx).credits) <= 0 ? 'You are out of credits' : 'Running low on credits'),
    body: (ctx) => {
      const c = nOf(S(ctx).credits);
      return c <= 0
        ? 'Top up to keep generating cover letters and applying to jobs.'
        : `${plural(c, 'credit')} left. Top up so you never miss a match.`;
    },
    suggestWhen: (s) => {
      const c = nOf(s.credits);
      if (c >= 5) return { applicable: false, reason: `Balance is ${c} — not low (5 is the free signup grant).` };
      if (!nOf(s.applications) && !nOf(s.coverLetters)) return { suggested: false, reason: 'Low balance but they have never used the app — activation matters more than a top-up.' };
      return { suggested: true, reason: `Only ${c} credits left and they are actively using the app.` };
    },
  },
  {
    key: 'credits_expiring',
    label: 'Credits expiring soon',
    description: 'Warns before unused credits expire. Only fires when an expiry_date is actually set.',
    category: 'reminders',
    notifType: 'credits',
    route: '/(ai-hub)',
    params: () => ({}),
    title: () => 'Your credits expire soon ⏳',
    body: (ctx) => {
      const s = S(ctx);
      const d = nOf(s.creditsExpireInDays);
      const c = nOf(s.credits);
      if (d && c) return `${plural(c, 'credit')} expire in ${plural(d, 'day')}. Use them on a cover letter before they are gone.`;
      return 'Your unused credits expire soon. Use them before they are gone.';
    },
    suggestWhen: (s) => {
      if (s.creditsExpireInDays == null) return { applicable: false, reason: 'No expiry date set on this account (credit expiry is not in effect).' };
      if (!nOf(s.credits)) return { applicable: false, reason: 'No credits left to expire.' };
      if (s.creditsExpireInDays > 7) return { suggested: false, reason: `Credits expire in ${s.creditsExpireInDays}d — too early to warn.` };
      return { suggested: true, reason: `${s.credits} credits expire in ${s.creditsExpireInDays}d.` };
    },
  },

  // ── quota / trial ─────────────────────────────────────────────────────────
  {
    key: 'trial_ending',
    label: 'Trial ending soon',
    description: 'The free trial runs out in a few days and they still have unused letters. Opens Plans & Usage.',
    category: 'reminders',
    notifType: 'credits',
    route: 'usage',
    params: () => ({}),
    title: (ctx) => {
      const d = nOf(S(ctx).trialDaysLeft);
      return d <= 1 ? 'Your free trial ends tomorrow ⏳' : `Your free trial ends in ${plural(d, 'day')} ⏳`;
    },
    body: (ctx) => {
      const s = S(ctx);
      const l = nOf(s.lettersLeft);
      return l
        ? `You still have ${plural(l, 'free cover letter')} to use. Tap to put ${l === 1 ? 'it' : 'them'} to work before the trial closes.`
        : 'Tap to see what you have used and what happens next.';
    },
    suggestWhen: (s) => {
      const d = s.trialDaysLeft;
      if (d == null) return { applicable: false, reason: 'Not on a trial (or no trial row).' };
      if (d > 3) return { suggested: false, reason: `Trial has ${d} days left — too early to warn.` };
      if (d < 0) return { applicable: false, reason: 'Trial already ended.' };
      if (!nOf(s.lettersLeft) && !nOf(s.resumesLeft)) return { suggested: false, reason: 'Trial is already fully used — nothing left to come back for.' };
      return { suggested: true, reason: `Trial ends in ${d}d with ${s.lettersLeft} letters unused.` };
    },
  },

  // ── "is something broken?" ────────────────────────────────────────────────
  {
    key: 'support_checkin',
    label: 'Are you facing any issue?',
    description: 'Asks a stalled user whether something went wrong and opens Help & support with the "what went wrong" picker focused. Their answer becomes a real support thread in the staff inbox.',
    // 'reminders' rather than 'marketing': this asks nothing of the user and sells nothing — it is
    // the app checking whether it broke. Filing it under marketing would hide it from exactly the
    // frustrated people who switched marketing off because the product was not working for them.
    category: 'reminders',
    notifType: 'reminder',
    route: 'support',
    params: () => ({ focus: '1' }),
    title: (ctx) => greet(ctx, (n) => `${n}, did something not work?`, 'Did something not work?'),
    body: () => 'You started but did not get through. If something broke or was confusing, tell us in one line — a real person reads every message and replies here.',
    suggestWhen: (s) => {
      // ASK THE PEOPLE WHO TRIED AND GOT NOTHING — that is the whole rule.
      //
      // This used to wait for two earlier nudges before it would fire, which was a proxy for "we
      // tried to help and nothing moved". The proxy was wrong: it delayed the question by days for
      // exactly the people who needed it on the day it broke. What we actually want is evidence of
      // a FAILED ATTEMPT, and the app already records it.
      //
      // ⚠️ "Searched and saved nothing" is NOT enough on its own. Several users searched, saved
      // nothing, and still generated cover letters — they got where they were going by another
      // route, and asking them what went wrong is noise. Progress of ANY kind disqualifies.
      if (s.hasOpenSupportThread) return { applicable: false, reason: 'Already has an open support conversation — asking again would fork it.' };
      if (nOf(s.applications)) return { applicable: false, reason: 'Has applied to a job — the flow worked for them.' };

      const searches = nOf(s.searches);
      const repeats = nOf(s.repeatSearches);
      const progress = nOf(s.savedJobs) + nOf(s.coverLetters);

      // The strongest signal we hold: running the SAME search again and again. Nobody repeats a
      // search that worked.
      if (repeats >= 2 && !progress) {
        return { suggested: true, reason: `Ran the same search ${repeats}x and it produced nothing — a retry loop, not a browse.` };
      }
      // Searched at all and came away with nothing to show for it.
      if (searches >= 1 && !progress) {
        return { suggested: true, reason: `${plural(searches, 'search')} and not one saved job or letter — the search is not working for them.` };
      }
      // Got as far as saving something, then stalled before applying.
      if (nOf(s.savedJobs) && !nOf(s.coverLetters) && nOf(s.daysSinceLastSeen) >= 3) {
        return { suggested: true, reason: `Saved ${s.savedJobs} job(s) then stopped — last seen ${s.daysSinceLastSeen}d ago.` };
      }
      if (!searches && !progress) {
        return { applicable: false, reason: 'Never attempted a search — nothing has broken yet, so an activation nudge fits better.' };
      }
      return { suggested: false, reason: 'Made real progress (saved jobs / letters) — no evidence anything is broken.' };
    },
  },

  // ── digest ────────────────────────────────────────────────────────────────
  {
    key: 'weekly_digest',
    label: 'Weekly summary',
    description: 'A short "your week on CVApplyr" recap. Uses the digest preference column.',
    category: 'digest',
    notifType: 'digest',
    route: '/(ai-hub)',
    params: () => ({ tab: 'myjobs' }),
    title: () => 'Your week on CVApplyr 📊',
    body: (ctx) => {
      const s = S(ctx);
      const parts = [];
      if (nOf(s.applications7d)) parts.push(plural(nOf(s.applications7d), 'application') + ' sent');
      if (nOf(s.coverLetters7d)) parts.push(plural(nOf(s.coverLetters7d), 'cover letter'));
      if (nOf(s.strongMatches)) parts.push(`${s.strongMatches} strong matches waiting`);
      return parts.length ? `Last 7 days: ${parts.join(' · ')}. Keep the momentum going.` : 'A quiet week — new jobs are waiting whenever you are ready.';
    },
    suggestWhen: (s) => {
      if (s.daysSinceLastSeen == null) return { suggested: false, reason: 'Never opened the app — a digest of nothing is noise.' };
      if (!nOf(s.applications) && !nOf(s.coverLetters) && !nOf(s.searches)) return { suggested: false, reason: 'No activity to summarise.' };
      return { suggested: true, reason: 'Has real activity worth recapping.' };
    },
  },
];

// ── index + accessors ────────────────────────────────────────────────────────
const BY_KEY = new Map(TEMPLATES.map((t) => [t.key, t]));

function get(key) { return BY_KEY.get(String(key || '')) || null; }
function keys() { return TEMPLATES.map((t) => t.key); }
function all() { return TEMPLATES.slice(); }

// Any template whose category is NOT a real preferences column would bypass opt-outs entirely.
// Surfaced (rather than thrown) so a bad edit shows up in the admin UI instead of silently spamming.
function invalidCategories() {
  return TEMPLATES.filter((t) => !PREF_CATEGORIES.includes(t.category)).map((t) => t.key);
}

// relevance for one user's live state → { relevance, reason }
function relevanceFor(tpl, state) {
  if (!tpl) return { relevance: 'not_applicable', reason: 'Unknown template.' };
  if (!state) return { relevance: 'available', reason: 'No user state supplied — relevance not computed.' };
  let r;
  try { r = tpl.suggestWhen ? tpl.suggestWhen(state) : null; } catch (e) { r = null; }
  if (!r) return { relevance: 'available', reason: '' };
  if (r.applicable === false) return { relevance: 'not_applicable', reason: r.reason || '' };
  if (r.suggested) return { relevance: 'suggested', reason: r.reason || '' };
  return { relevance: 'available', reason: r.reason || '' };
}

// Render a template for a user. `overrides` (admin-typed title/body) always win.
function render(tpl, ctx = {}, overrides = {}) {
  const safe = (fn, fallback) => {
    try { const v = fn ? fn(ctx) : null; return v == null || v === '' ? fallback : String(v); }
    catch (e) { return fallback; }
  };
  const title = clip(overrides && overrides.title ? overrides.title : safe(tpl.title, tpl.label), 90);
  const body = clip(overrides && overrides.body ? overrides.body : safe(tpl.body, tpl.description), 200);
  let params = {};
  try { params = (tpl.params ? tpl.params(ctx) : {}) || {}; } catch (e) { params = {}; }
  return { title, body, route: tpl.route, params, category: tpl.category, notifType: tpl.notifType || 'jobs' };
}

// The admin-facing catalogue entry (no functions — safe to JSON.stringify).
function describe(tpl, state, ctx) {
  const rel = relevanceFor(tpl, state);
  const preview = render(tpl, ctx || { state: state || {} });
  return {
    key: tpl.key,
    label: tpl.label,
    description: tpl.description,
    category: tpl.category,
    title: preview.title,
    body: preview.body,
    route: preview.route,
    params: preview.params,
    needsJob: !!tpl.needsJob,
    relevance: rel.relevance,
    reason: rel.reason,
  };
}

module.exports = { PREF_CATEGORIES, TEMPLATES, get, keys, all, relevanceFor, render, describe, invalidCategories };
