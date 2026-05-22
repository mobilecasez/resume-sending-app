# CVApplyr Mobile App — Claude Code Context

## 🚀 START HERE — Active Task
**Begin immediately with TASK 1 below. Do not ask for clarification — all details are in this file.**
1. Read this entire file first
2. Execute TASK 1 (build `app/(ai-hub)/job-detail.tsx`)
3. Then TASK 2 (wire `services/aiHubService.ts` to real API)
4. Then TASK 3 (create backend routes + controller)
5. After each task, make a git commit with a descriptive message

## Project Overview
CVApplyr is an AI-powered proactive job search hub. Users enter target company names or career page URLs; the AI researches these companies, matches jobs to the user's resume, and automatically finds/verifies hiring manager email addresses.

## Tech Stack
- **Framework**: React Native 0.81.5 / Expo SDK 54, `newArchEnabled: true`, Hermes engine
- **Navigation**: expo-router v6 (file-based routing)
- **Styling**: Pure `StyleSheet.create()` — NO NativeWind, NO Tailwind, NO styled-components
- **Icons**: `@expo/vector-icons` Ionicons ONLY
- **Gradients**: `expo-linear-gradient` LinearGradient
- **Auth**: Google OAuth, Apple Sign-In, Microsoft PKCE
- **Payments**: Apple IAP (react-native-iap) + Razorpay
- **Storage**: AsyncStorage + expo-secure-store
- **HTTP**: axios
- **Backend**: Node.js/Express on Railway (PostgreSQL)

## Critical Rules
1. **DO NOT modify `App.js`** — it is a ~15,000 line monolith. All new work is in separate files.
2. Use only packages already in `package.json`. Do NOT add new dependencies.
3. All styles via `StyleSheet.create()`. Inline styles only for dynamic values.
4. All icons from `@expo/vector-icons` Ionicons only.
5. All new files use TypeScript (`.tsx` / `.ts`).
6. Use `useRouter` and `useLocalSearchParams` from `expo-router`, NOT from `@react-navigation` directly.
7. No third-party UI libraries.
8. Every new file must start with: `// AI Hub — new feature. Safe to delete without affecting existing app.`

## Design Language
- **Background (dark section)**: `#0B1120` (deep navy)
- **Background (feed section)**: `#F0F4FA` with `borderTopLeftRadius: 28, borderTopRightRadius: 28`
- **Cards**: white, `borderRadius: 24`, shadow: `shadowColor '#0F172A', shadowOffset {0,8}, shadowOpacity 0.10, shadowRadius 32, elevation 8`
- **Accent primary**: `#06B6D4` (cyan)
- **Accent secondary**: `#3B82F6` (blue)
- **Apply button**: LinearGradient `['#06B6D4', '#3B82F6']` horizontal
- **Pill colors**: cyan `rgba(6,182,212,0.15)`, violet `rgba(139,92,246,0.15)`, emerald `rgba(16,185,129,0.15)`

## AI Hub Feature — Current Status

### Files Created (all complete and working)
| File | Status | Notes |
|------|--------|-------|
| `types/aiHub.ts` | ✅ Done | Shared types: Contact, Job, Employer, WishlistPill |
| `services/aiHubService.ts` | ⚠️ Mock only | All functions return mock data — needs real API wiring |
| `app/(ai-hub)/_layout.tsx` | ✅ Done | Stack navigator, dark header #0B1120 |
| `app/(ai-hub)/index.tsx` | ✅ Done | Main dashboard (~980 lines) — fully functional with mock data |
| `app/(ai-hub)/add-contact.tsx` | ✅ Done | Modal form, reads jobId param, shows Alert on save |
| `app/(ai-hub)/job-detail.tsx` | ⚠️ Placeholder | Only shows jobId — needs full UI built out |
| `app/(tabs)/job-hub.tsx` | ✅ Done | Tab entry — Redirects to /(ai-hub) |
| `app/(tabs)/_layout.tsx` | ✅ Done | Added Job Hub tab with briefcase-outline icon |

### Remaining Work (priority order)

#### TASK 1 — Build out `job-detail.tsx` (NEXT)
The file currently only shows the jobId param. It needs a full detail view.
See the "Job Detail Prompt" section below.

#### TASK 2 — Wire `aiHubService.ts` to real backend API
Replace all mock resolved Promises with real `axios` calls to the Express backend.
Backend base URL comes from an env/config variable.
See the "Backend Wiring Prompt" section below.

#### TASK 3 — Create backend API endpoints (Express/Node)
New routes in the Express server for the AI Hub feature.
Files to create in `../server/routes/` and `../server/controllers/`.
See the "Backend Endpoints Prompt" section below.

---

## Navigation Structure
```
Bottom Tab Bar → "Job Hub" (briefcase-outline)
  → app/(tabs)/job-hub.tsx  →  Redirect to /(ai-hub)
    → app/(ai-hub)/_layout.tsx  (Stack navigator, dark header)
      ├── app/(ai-hub)/index.tsx         ← Main dashboard (DONE)
      ├── app/(ai-hub)/job-detail.tsx    ← Full job detail (TODO)
      └── app/(ai-hub)/add-contact.tsx  ← Modal: add contact form (DONE)
```

## Key Types (from `types/aiHub.ts`)
```ts
export type Contact = {
  id: string;
  name: string;
  role: string;
  email: string;
  verified: boolean;
  avatarColor: [string, string];
};

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
};

export type Employer = {
  id: string;
  name: string;
  subInfo: string;
  logoColor: [string, string];
  logoInitial: string;
  status: 'active' | 'watching';
  jobs: Job[];
};

export type WishlistPill = {
  id: string;
  label: string;
  colorVariant: 'cyan' | 'violet' | 'emerald';
};
```

## iOS Local Build Fixes (this machine only)
- `ios/.xcode.env.local` must contain:
  `export NODE_BINARY=/Users/rishisamadhiya/.nvm/versions/node/v22.22.2/bin/node`
  (Homebrew Node 24 breaks EXConstants build phase)
- `ios/Pods/Pods.xcodeproj/project.pbxproj` line ~34215: remove `-l` flag from bash invocation
  (`bash -l -c "..."` → `bash "$..."`) — fixes word-split on space in "Shopify Apps/" path
  This fix is wiped by `pod install` and must be re-applied.

---

## TASK 1 PROMPT — Build `app/(ai-hub)/job-detail.tsx`

Paste this into Claude Code chat:

```
Read the file app/(ai-hub)/job-detail.tsx — it's currently a placeholder.
Also read app/(ai-hub)/index.tsx for design patterns and style conventions.
Also read types/aiHub.ts for the type definitions.

Build a full job detail screen at app/(ai-hub)/job-detail.tsx.

CONSTRAINTS:
- DO NOT modify any existing file except job-detail.tsx
- StyleSheet.create() for all styles — NO inline style objects except dynamic values
- Ionicons from @expo/vector-icons only
- expo-linear-gradient for all gradients
- expo-router useLocalSearchParams and useRouter
- TypeScript, default export

LAYOUT (top to bottom, inside SafeAreaView + ScrollView):

1. HERO SECTION (dark navy #0B1120 background)
   - Back button (top left, Ionicons "arrow-back", color white) using router.back()
   - Job title: fontSize 22, fontWeight '800', color white, letterSpacing -0.5
   - Employer row: LinearGradient logo square (same pattern as index.tsx EmployerSection),
     employer name in white, subInfo in rgba(255,255,255,0.5)
   - Urgent badge (if urgent): bg rgba(255,78,100,0.2), border rgba(255,78,100,0.4),
     text '#FF4E64', text "URGENT HIRE", Ionicons "flash-outline" size 11

2. META CARDS ROW (still on dark bg, horizontal ScrollView)
   Four floating cards in a horizontal scroll:
   - Location (Ionicons "location-outline", #06B6D4)
   - Experience (Ionicons "time-outline", #A78BFA)
   - Salary (Ionicons "cash-outline", #34D399)
   - Job Type (Ionicons "briefcase-outline", #FB923C)
   Each card: bg rgba(255,255,255,0.07), borderColor rgba(255,255,255,0.1),
   borderRadius 16, padding 14, minWidth 110

3. LIGHT CONTENT PANEL (bg #F0F4FA, borderTopLeftRadius 28, borderTopRightRadius 28)
   Inside the panel:

   A) SKILLS SECTION
      Label "REQUIRED SKILLS" (same uppercase muted style as index.tsx)
      Skill chips in a flexWrap row — bg white, border #E2E8F0, borderRadius 20,
      fontSize 12, fontWeight '600', color #334155

   B) CONTACTS SECTION
      Label "HIRING CONTACTS"
      Each contact: same ContactRow pattern as index.tsx
      (LinearGradient avatar, name+role, monospace email, verified badge)
      Below contacts: "Add Contact" button — white bg, border #E2E8F0, borderRadius 12,
      Ionicons "person-add-outline", navigates to /(ai-hub)/add-contact with jobId param

   C) ABOUT THE ROLE SECTION (placeholder)
      Label "ABOUT THE ROLE"
      A grey placeholder block (bg #E2E8F0, borderRadius 12, height 120) with
      centered text "AI-generated summary coming soon..." in color #94A3B8

4. STICKY FOOTER (position absolute, bottom 0, full width)
   bg white, borderTopWidth 1, borderTopColor #F1F5F9, padding 16
   "Apply Now" button — full width, LinearGradient ['#06B6D4','#3B82F6'],
   borderRadius 16, height 52, Ionicons "checkmark-done-outline" white,
   text "Apply Now" fontSize 16 fontWeight '800' color white

STATE:
Since job-detail is currently a placeholder with no data passing from index.tsx,
use useLocalSearchParams to read jobId, then look up the job from the same
MOCK_EMPLOYERS data defined inline in this file (copy from index.tsx).
Show a "Job not found" fallback if jobId doesn't match.

Also update app/(ai-hub)/index.tsx — the JobCard component currently calls
Alert on "Apply Now". Change it so tapping "Apply Now" on a card navigates to
job-detail instead:
  router.push({ pathname: '/(ai-hub)/job-detail', params: { jobId: job.id } })
```

---

## TASK 2 PROMPT — Wire `services/aiHubService.ts` to real API

Paste this into Claude Code chat after Task 1 is done:

```
Read services/aiHubService.ts — it currently returns mock resolved Promises.
Read the backend server files in ../server/routes/ and ../server/controllers/
to understand the existing API patterns (auth middleware, response format, etc).

Replace the mock implementations with real axios calls to the Express backend.

CONSTRAINTS:
- DO NOT add any new npm packages — axios is already installed
- Keep the exact same function signatures so the UI layer needs zero changes
- Add proper try/catch with meaningful error messages
- The backend base URL should come from a config constant at the top of the file:
  const API_BASE = 'https://your-railway-app.railway.app/api'; // update with real URL
- Pass the user's auth token in the Authorization header (read from AsyncStorage
  using the same key the rest of the app uses — check App.js for the AsyncStorage key)

Functions to wire:
1. analyzeWishlist(companies) → POST /api/ai-hub/analyze-wishlist
2. fetchJobMatches(companyName) → GET /api/ai-hub/jobs?company={companyName}
3. verifyEmail(email) → POST /api/ai-hub/verify-email
4. addContactToJob(jobId, contact) → POST /api/ai-hub/jobs/{jobId}/contacts
```

---

## TASK 3 PROMPT — Create backend API endpoints

Paste this into Claude Code chat after Task 2:

```
Read ../server/routes/ and ../server/controllers/ to understand the existing
Express routing patterns and middleware used in this project.
Read ../server/middleware/ for the auth middleware.

Create new backend files for the AI Hub feature:

FILE 1: ../server/routes/aiHub.js
Register these routes (all protected by the existing auth middleware):
- POST /api/ai-hub/analyze-wishlist
- GET  /api/ai-hub/jobs
- POST /api/ai-hub/verify-email
- POST /api/ai-hub/jobs/:jobId/contacts

FILE 2: ../server/controllers/aiHubController.js
Implement each route handler. For now, return realistic mock JSON responses
(the same shape as the TypeScript types in MobileApp/types/aiHub.ts).
Add a TODO comment on each handler explaining what the real implementation will do
(e.g., "// TODO: call OpenAI to research company jobs and match to user resume").

FILE 3: Register the new router in ../server.js or ../server/index.js
Add: app.use('/api/ai-hub', aiHubRouter);
Find the exact location by reading the existing route registrations.

CONSTRAINTS:
- Follow the exact same patterns as existing route/controller files
- Use the existing auth middleware — do not create a new one
- Return JSON in the same format as other endpoints in this codebase
- No new npm packages
```
