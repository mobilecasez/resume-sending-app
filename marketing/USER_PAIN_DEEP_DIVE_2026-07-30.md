# CVApplyr — What Users Are Actually Facing
### A full-database deep dive · 2026-07-30

**Method.** Eight parallel analyses over every production table (app_events, users, searches, scrape logs, cover letters, credits, payments, feedback, fix requests, notifications, the 135,928-job feed) plus the live Apple App Store reviews. All numbers separate REAL users from founder/test accounts — including two hidden ones the analysis uncovered (`rishi.samadhiya@outlook.com` = founder's Outlook, and ~15 `ats***@example.com` accounts). **True real users ≈ 119–134** (146 accounts − 12–27 test).

---

## 1 · The headline: growth is real, retention is zero

- Real signups are **accelerating ~3× in 3 weeks**: 11 → 15 → 29 → 45 per week through July.
- But of 102 real signups since telemetry began: **90 have exactly ONE active day**. D1 return = 7.8%. Nobody has 4+ active days.
- Weekly active users ≈ that week's signups. The bucket is filling exactly as fast as it leaks.
- Activation is **now-or-never**: median signup → résumé upload is **2.3 minutes**. If the first five minutes don't convert a user, they never return.

**The funnel, real users only:**

| Stage | Users | % |
|---|---|---|
| Registered | 134 | 100% |
| Touched anything (profile) | 39 | 29% |
| Uploaded résumé | 37 | 28% |
| Ran a job search | 16 | 13.6% |
| Opened an apply page | 7 | 5% |
| Confirmed completed application | **0–2** | ~1% |
| Paid money | **0** | 0% |

Exactly **one** real user (u136, mahakagrawal46) has visibly completed the whole journey — signup → résumé → search "tcs" → 5 cover letters → download → apply, and she came back two more days. One more (u97) almost certainly submitted an application our detection missed. That's the entire realized product value to date.

---

## 2 · Problem #1: the search box is not what users think it is

This is the single clearest finding in the data. **13 of 20 real search inputs are not URLs.** Users type what they'd type into Google, and the app prepends `https://` and tries to scrape it:

> `https://plulmbing` · `https:// Pacific Plumbing` · `https:// finance` · `https://pakistan` · `https://paint` · `https://amazon` · `https://ems companies` · `https://sai developers` · `https://Foxconn` · `https://aramex` · `https://tcz` (typo for TCS) — and one user pasted **her own employment-letter PDF's local file path**.

Consequences, measured:
- **35% of real searches return zero jobs.** 5 of the 7 zero-result cases are this input mismatch, not scraping failures.
- Intent survives exactly one failure: users retry once after a typo (u83: "plulmbing" → "Pacific Plumbing" 9 min later), then leave. **No real user has ever searched in two different weeks.**
- The founder-era searches that returned 188–198 jobs are gone; **no real search since June has exceeded 20 jobs** (the Google-fallback cap), so even successes look thin.
- The Google fallback is carrying the product: it produced 10 of the 13 successful searches.

**What users expect:** a job search engine. Type a company, an industry ("finance", "paint"), even a country ("pakistan") — get jobs. The URL-scanning model is invisible to them.

---

## 3 · Problem #2: the feed doesn't have jobs where users live

- Feed supply: **US 29.9% + Sweden 29.0% + "Global" 24.0% = 83%** of 135,928 jobs.
- Real users (locatable sample n=37): **India ~43%**, then Pakistan, Philippines, UAE, Sri Lanka, Nepal, Ghana, Lebanon, Afghanistan, Uzbekistan, Bosnia, Albania…
- **Ten user home countries have literally 0 jobs in the feed.** India — the largest user base — has 1,584 jobs (1.2% of the feed).
- Result: 81 real users browsed the feed, only 10 ever opened a job detail (**12% browse→detail**). They look, see nothing near them, and leave. **Zero real users have ever saved a feed job.**
- Demand is also **not tech**: plumber, paint, quoting specialist, sales manager, EMS, business analyst, government — while supply is tech-ATS boards (IT & Software is the #1 field at 22.7%).
- Freshness gaps: Switzerland 97% stale (jobroom ingester silent since Jul 16), arbeitsagentur silent since Jul 19.

---

## 4 · Problem #3: the welcome credits buy exactly one attempt

Price list: search 3–5cr, cover letter 1cr, **download 2cr**. Welcome grant: 5cr.

- The observed pattern is mechanical: **1 search (3cr) + 1–2 letters (1cr) → stranded at 1–2 credits** — below every search price and below the download price.
- **26 real users (20%) sit below the cheapest search price.** 8 are at zero.
- Users who paid 1 credit for a letter sometimes got one addressed to *"Ambitious Estate Agent (Employer Name Not Provided)"* or *"Undisclosed Plumbing Service Provider"* — they paid for a placeholder.
- **Nobody downloads**: 1 real cover-letter download ever. The 2cr price sits exactly above the stranded 1–2cr balance.
- **Real revenue: $0.** 16 of 18 payment orders are founder/test; 1 is the founder's Outlook; the single genuine checkout (Starter, ₹4.99, Razorpay, Apr 17) was **started and never completed** — and that user never did anything again.
- When spending stops, usage stops the same day. Nobody has ever come back to top up.
- There is **no "insufficient credits" event and no paywall-shown event** — we cannot even see how many hit the wall.

---

## 5 · Problem #4: things fail silently, in both directions

**Failures users never learn about:**
- 2 real users' résumés are **stuck in parse-error state forever** (one from the dead dev-key era, one brittle JSON parse). Both have a résumé file uploaded — *they think they're fine* while search/matching silently degrades. (The new retry sweeper should now catch these — needs verification.)
- **76% of real users' job-match rows were never scored** (scored_at NULL → renders as 0%). Six users saw **0% match on every single job**. Among scored rows, median match = 30. The "match score" — a core promise — mostly shows users zeros or low numbers.
- u140 tapped cover-letter-generate **3× in 5 seconds**, u118 2× — no letter was ever persisted for either, and no error event exists. u140 also hit the "Resume Required" nag 3× in 5 seconds — whatever that screen said, it didn't land.
- Apply submit-detection under-counts: u97 filled a **15-answer application** (harvested into autofill memory) with no `apply_complete` recorded.

**Fixes users never learn about:**
- The self-heal loop genuinely works — both real fix-requests (Revolut, Rover) were **resolved within ~1 day**. But there is **no "your search is fixed" notification**: u85 was still active for 2 days after her Revolut fix landed and never knew. The repair was wasted.

**Autofill quality on selects:**
- u97's harvested answers include **State = "Alabama" alongside City = "Bengaluru"** (a US-only dropdown got defaulted/mispicked) and "under-18 employment certificate → Yes" for an adult. The select-guard needs to refuse when nothing matches.

---

## 6 · Problem #5: we are flying blind on unhappiness, and half-deaf on reach

- **Support threads: 0. Support messages: 0.** Negative in-app feedback ever: **0 words.** All 8 feedback rows are 5★, 7 of them founder/testers. Every unhappy user in this report churned **silently**.
- Apple reviews: 3 total, all 5★ (one is the founder). The two organic ones praise exactly the intended value — *"It saved a lot of my time… especially Cover Letter"* and *"Clean, intuitive… works smoothly."* When the loop works, people love it. They just rarely get there.
- **Push reach: 47% overall — and 0% of event-tracked real Android users have a token** (the Firebase fix only shipped in vc58+; real Android users are on older builds). The what's-new push will reach ~57 mostly-iOS users.
- In-app notification read rate: **6.2%**. The inbox is not a channel.
- **~36% of tracked real users are stranded on builds older than 3.3** — before the Job-Hub speed, Auto Fill and guide work.
- **74% of devices that open the app never register** (311 of 422 devices; Android opens actually exceed iOS opens 294:230, yet signed-in users are 73 iOS : 12 Android). Android users install, look at a login wall, and leave.
- At the door itself: 5 users tried to **log in before having an account**, failed, then found signup; **4 more failed login and never registered at all.**
- Security note: the demo account (cvapplyrtest) has taken **446 login attempts from 48 IPs** — ongoing credential-stuffing. Rotate/disable it and rate-limit logins.

---

## 7 · What users expect (in their own actions)

1. **"Type anything, get jobs"** — keyword, brand, industry, country, typos included.
2. **Jobs near them** — South Asia, MEA, Africa; not US/Sweden tech boards.
3. **Non-tech roles treated equally** — plumbing, painting, sales, quoting, EMS, government.
4. **Instant value** — the whole journey happens in minutes or not at all; several users try to browse before registering.
5. **Paste anything** — a job-posting URL, a Google share-link, even a document — "the app should figure it out."
6. **Honest numbers** — a wall of 0% match scores reads as "this app doesn't work for me."

## 8 · What they're not getting — and the fixes, ranked

**P0 — decide whether the product works at all**
1. **Make the search box a real search box.** Classify input (keyword/brand/industry/country vs URL vs job-posting link), route keywords to the global feed + Google live search, fuzzy-match typos, and never construct `https://plulmbing` again. This one change addresses the top observed failure (35% zero results) and the top expectation mismatch.
2. **Get local jobs for the actual user base.** India first (43% of users, 1.2% of supply), then Pakistan/Sri Lanka/Philippines/MEA. National feeds, aggregator boards, country-scoped Google queries seeded from the user's phone country code / address. Default the feed to the user's country.
3. **Let the first loop complete.** Either welcome credits that cover search + letter + download (e.g. 8–10), or make the first download free. Add a top-up prompt at the exact stranded moment, and instrument `insufficient_credits` / paywall views so pricing decisions stop being blind.

**P1 — stop the silent failures**
4. Verify the parse-error sweeper rescued users 66 & 70; surface a visible "we couldn't read your résumé — tap to retry" state.
5. Score matches synchronously or hide unscored ones — never render 0%.
6. Surface cover-letter generation failures (and log them); fix the repeat-tap dead-end on "Resume Required."
7. Wire a **"your search is fixed" notification** to the fix-loop resolution (the backend already knows).
8. Improve submit detection (u97's pattern: heavy form harvest + no complete = assume submitted, confirm with the user).
9. Autofill: never pick a select value without a confident match (the Alabama bug).

**P2 — reach and the front door**
10. **Value before signup**: let anonymous users browse the feed (74% of devices bounce at the door; Android worst).
11. Login screen: OAuth-first, "New here? Create account" prominent (4 users lost at the door).
12. Nudge the ~36% on old builds (server-driven update banner); Android push becomes real only as users reach vc58+.
13. Investigate the iOS résumé-picker stall (7 of 19 checklist tappers, all iOS, tapped Upload and never uploaded).
14. Instrumentation package: populate `last_seen_at`, screen_view on all screens, zero-result & CL-error & credits events, identifiers on login_failed, GoogleJobBrowser events, country columns.
15. Rotate/disable cvapplyrtest and add per-IP login rate-limiting.

## 9 · Honest caveats

- Event telemetry starts late June; ~32 earlier users are invisible. `last_seen_at` was never written.
- User-country sample is 37 of ~119 (the rest gave no address).
- Some "silences" are instrumentation gaps, not user behavior (apply completions, CL failures, paywall hits).
- Several supposedly-real bright spots (searchrks 5★, u33's big June searches) may be acquaintances of the founder — treated as real, but weakly.

## 10 · The one-paragraph verdict

CVApplyr's promise lands when a user reaches it — the only organic reviews praise exactly the cover-letter magic, and the one user who completed the loop came back for more. But between install and that moment sit five walls: a signup wall (74% bounce), a search box that speaks a different language than its users (35% zero results), a feed with no jobs in their country (10+ countries at zero), a credit wallet that empties after one attempt, and failures nobody is told about. Growth is accelerating into these walls at 45 users a week. Fix the search box, the local supply, and the first-loop economics — in that order — and the retention curve is the scoreboard.
