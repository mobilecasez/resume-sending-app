# CVApplyr — What Changed for Users (and What Didn't)
### Follow-up deep dive · 2026-08-01 · vs the 2026-07-30 baseline

**Method.** Seven parallel analyses over every production table, same real-vs-test separation as the baseline (test ids excluded, `ats***@example.com` excluded). Window: the ~48 hours since the July-30 changes (free-flip + trials at ~18:00 UTC Jul 30, +2,913 target-country jobs, 57 hand-researched demand jobs, 19 job-match pushes Jul 31). **Caveat up front: two days is a short window and n is small — treat every rate as directional.**

---

## 1 · The scoreboard: five walls, one moved

| Baseline wall | What we shipped since | Did user behavior move? |
|---|---|---|
| #1 Search box speaks URL, users speak keywords | Fix built, but **only in TestFlight 3.5** — store users still on 3.4/3.3 | **No. Worse, if anything**: 4 of 5 post-flip search attempts returned zero/failed |
| #2 No jobs where users live | India +61% → 2,547 · Pakistan 0→199 · Sri Lanka 0→103 · UAE 915 · South Africa 619 · Morocco 20 · Portugal 206 | **Supply fixed, demand never saw it**: 0 views, 0 saves, 0 matches on any new job |
| #3 Credits buy one attempt | Everything free except letters/resumes; 134 users got 7-day trials (5 CL + 2 resumes) | **1 trial letter consumed. Total.** 2 of 109 dormant users returned (1.8%) |
| #4 Silent failures | Scorer now works (forward), parse sweeper holds for new users | **Half-moved**: new stuff works, old damage untouched, new silent failure found |
| #5 Blind on reach | Match pushes wired; token coverage 47%→53% | **The pushes flopped: 19 sent, 0 read, 1 ambiguous return** — and the "it's free now" broadcast was never sent |

The one-line story: **we fixed the warehouse and never opened the shop door.** The supply, the pricing, and the scoring were all repaired server-side — but the two channels that could tell users (the store app build and push notifications) either don't carry the changes or carried them badly.

---

## 2 · Proof the product works: u163's thirteen minutes

Abdessamad (Morocco, waiter) signed up **90 minutes after the flip** on the store 3.4 build:

> 19:32 signup → 19:36 searched "Waiter" → 7 jobs (Google fallback) → **all 7 match-scored 60–85% within 3 minutes** (the 0%-wall is gone for new searches) → 19:38 résumé uploaded, parsed clean → 19:41 opened a job → 19:42 generated a cover letter (Windstar Cruises, Assistant Waiter) — **the first and only trial consumption in the entire user base** — and he came back on Aug 1.

Signup → scored jobs → cover letter in **13 minutes, at zero cost, with honest match numbers**. That's the product as designed, working end-to-end on the current store build. Everything else in this report is about why he's the only one.

---

## 3 · The delivery failure (this period's new headline problem)

**The match pushes inverted geography.** The first wave (before the targeting fix landed) told: the Vancouver plumber → *"7 new commercial jobs in South Africa"* · the Morocco waiter → *"1 new hygiene standards job in India"* · the Portugal hospitality user → *"10 new server jobs in India"* · the France HR pro → *"60 new manager jobs in India"* · the India SQL dev → *"60 new specialist jobs in Sweden"*. Meanwhile **the right jobs existed** — 6 Burnaby plumber roles, 17 Morocco Accor hotels, 9 Pestana Lisbon — built for exactly these people, one day after most of them last opened the app. *(Targeting was fixed Aug 1 — country now required from the résumé, generic terms blocked, dry-run verified — but that wave is spent.)*

- **0 of 19 pushes were read.** 1 of 19 recipients had any app event after (u163, 22h later, ambiguous).
- **The "everything is free now + you have a trial" broadcast never went out.** Notification log confirms: no whats-new/announcement type exists. 107 of 109 dormant users have no way to know the economics changed.
- **The store build can't show it either**: plans/usage/interest screens are in TestFlight 3.5 — **zero external testers**; 52% of active real users are still on 3.3, before even the Search-tab redesign.
- Android is still deaf: **1 push token across 16 Android users (6%)**; Android door bounce got *worse* (91% of new Android devices never register vs 74% baseline overall).

---

## 4 · The search box remains the product's front door, and it's still locked

Store users still get `https://` prepended to whatever they type:

- u85 pasted her Google **share-link** three times in 16 minutes → "Phase 1 returned no jobs" ×3 → gone. (Her Revolut fix from last week never mattered — she doesn't search that way.)
- u170 typed `electrical` → the pipeline **hard-failed server-side** ("No JSON object found") with **no scrape-log row and no user-visible error** — a new, fully invisible failure mode. He never came back.
- u122 `pakistan` → 0. u142 pasted **her own employment-letter's file path** → 0.
- Of the 7 searchers in the Jul-28+ cohort, **6 typed keywords, not URLs** (baseline: 13 of 20). The Google fallback still produces most successes and still caps at ~7–20 jobs.

Nothing about Problem #1 changed for real users, because the fix hasn't reached them.

---

## 5 · New-cohort funnel (n=48, Jul 28→Aug 1)

| Stage | Now | Baseline |
|---|---|---|
| Registered | 100% | 100% |
| Touched profile | 35% | 29% |
| Uploaded résumé | **19%** | 28% |
| Ran a search | 15% | 13.6% |
| Opened apply | 8% | 5% |
| Confirmed applied | **0%** | ~1% |

- Growth continues (64 real signups this week vs 45 last) — but **Jul 31 dipped to 3 signups**, worth checking ads.
- D1 return 11–15% vs 7.8% baseline — directionally better, tiny n.
- Still **nobody reaches a confirmed application**. Still nobody with 3+ active days.
- 63% start onboarding; the résumé step is where they stall (u166: 27 events, 6 profile fields, photo, signature — never a résumé, never a search).

---

## 6 · Silent failures: forward-fixed, backward-frozen

- **Match scores**: post-flip rows score perfectly (7/7, in ~3 min). Pre-flip damage untouched: **103 unscored rows (76.3% — byte-identical to baseline)**, now **7 users** who see 0% on everything.
- **u66 and u70's résumés are still broken.** u66's retry failed again on the same brittle-JSON bug; u70 hasn't been retried at all. They still think they're fine.
- **u140 burned a third session** (3 taps in 4.3s) on the same silent "Resume Required" dead-end — 6 lifetime generate-taps, 0 letters, 0 errors shown. u158 joined her.
- Still no error/paywall/zero-result events; `app_error` has fired exactly once ever (the founder's drag crash).

---

## 7 · Two genuine bright spots

1. **The first-ever real support thread.** u166 (Italy) reported "Translation did not work" within 3 hours of signup — the support channel works, and the report is actionable (cover-letter language for Italian). The baseline's "0 threads ever" is broken.
2. **The credential-stuffing on cvapplyrtest stopped** (last attempt Jul 29, after 446 attempts/48 IPs) — dormant, though still not rotated or rate-limited.

---

## 8 · Re-ranked fixes (what actually blocks users this week)

**P0 — delivery, not features**
1. **Ship 3.5 to the stores.** The search classifier, plans/trial UI, and interests only exist where no user is. Until the store build changes, walls #1 and #3 are immovable regardless of backend work.
2. **Send the announcement** ("everything except letters is now free + your 7-day trial") — the broadcast machinery exists and was never fired; trials expire **Aug 6**, so this has a 5-day fuse. Pair it with a *correctly targeted* re-run of the match push (targeting is now fixed + dry-run-able): the plumber should finally hear "6 plumber jobs in Vancouver".
3. **Deep-link pushes to the jobs they name** and log delivery receipts + push-opens; a push nobody can act on is spam.

**P1 — finish the half-fixed**
4. Backfill the 103 unscored match rows; hide unscored instead of rendering 0%.
5. Rescue u66/u70 (different parser path) and surface a visible "we couldn't read your résumé" state.
6. Fix the Resume-Required dead-end (u140 ×3 sessions): if no résumé, route to upload, don't swallow the tap.
7. Surface search failures (u170's class): failed async job → user-visible error + retry, and log it.
8. Android: door (91% bounce) + tokens (6%) — value-before-signup matters most on Android.

**P2 — instrumentation still owed**
9. `job_detail` job id · zero-result events · paywall/quota-denied events · Google-browser events · `users.country` · `last_seen_at` · push receipts. (Every analysis in this report hit these same holes.)
10. Freshness honesty: `is_active` is true for 100% of 149,857 jobs; jobroom (Jul 16) and arbeitsagentur (Jul 19) are still dead; the xray source is frozen since Jul 28. Deactivate stale rows or stop counting them.

---

## 9 · Verdict

The July-30 wave proved something important: **when a user meets the fixed product, the loop completes in minutes** — u163 did signup→scored jobs→cover letter in 13 minutes on day one, for free, and came back. But the wave changed almost nothing at scale because it never reached anyone: the fixes live in a build with zero testers, the pushes that should have announced them pointed at the wrong countries and went 0-for-19 on reads, and the free-economy launch was never announced at all. The walls didn't move; the users never saw the door. **This week's job is not building — it's shipping 3.5, sending the announcement, and re-running the (now-fixed) match push before the trials lapse on Aug 6.**
