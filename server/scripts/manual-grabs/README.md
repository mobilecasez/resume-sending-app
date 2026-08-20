# Manual employer grabs

One-off loaders for the target employers whose boards **cannot** be served by an adapter in
`server/utils/atsDiscovery.js`. Everything here is deliberately *not* wired into the firehose.

## Why these are not adapters

An adapter has to survive unattended runs every 6 hours. These boards can't offer that:

| Employer | Why it can't be an adapter | How it was read |
|---|---|---|
| **Google** | Jobs live in an `AF_initDataCallback` blob (`ds:1`) — a Google-internal array format with no field names, positional and free to change silently | `grab-google.js` (Node) |
| **Siemens** | **Moved portals.** `jobs.siemens.com/careers` now serves a "we have moved" notice — which is exactly why our adapter reported zero. Live board is `/en_US/externaljobs/SearchJobs`, hard-capped at 6 results/page | `grab-siemens.js` (Node) |
| **Allianz** | Phenom, JS-rendered. Results are embedded in a `phApp.ddo` object — but only on `/us/en/search-results`, and only in the *second* such object on the page | `grab-allianz.js` (Node) |
| **Revolut** | Returns **403** to any non-browser user agent. Its whole board sits in `__NEXT_DATA__`, readable only from a real browser session | browser |
| **Personio** | Returns **429** to non-browser requests; the list is fetched client-side after render | browser |
| **Bolt** | Client-side pagination with no URLs — page buttons carry no `href`, so pages only advance by clicking | browser |

⚠️ The `bolt.pinpointhq.com` entry that used to sit in `global_job_sources.json` was **not Bolt** —
it is Pinpoint the ATS vendor's own careers page, returning 6 jobs under the employer "Pinpointhq".
It has been removed.

## Loading

Every grab writes the same JSON shape and is loaded by the shared loader, which reuses the
firehose's own `classifyTitle` / `resolveCountry` / clipping / upsert so hand-loaded rows are
indistinguishable from ingested ones:

```
node server/scripts/manual-grabs/grab-google.js /tmp/google.json
node server/scripts/load-manual-jobs.js /tmp/google.json --env /path/to/prod.env --dry
node server/scripts/load-manual-jobs.js /tmp/google.json --env /path/to/prod.env
```

Always `--dry` first: it reports rejects, per-employer counts and the country split, which is where
a broken location parse shows up. (It did once — an early Siemens parser keyed on `•` separators
that are CSS pseudo-elements and therefore vanish under `strip()`, filing all 803 jobs under
country `Global`.)

## Browser-only boards

For Revolut / Personio / Bolt the data was read in the browser and moved to disk WITHOUT going
through the model's context, using a `window.name` handoff: the source page stages its rows in
`window.name` (which survives cross-origin navigation), then the browser navigates to a tiny
local-only receiver on `127.0.0.1` that reads it and writes the file. This is necessary because the
source sites' CSP blocks their own pages from talking to localhost. The receiver takes the FILENAME
from its own query string, never from the data.
