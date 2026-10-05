# dashboard-stats

Read-only Worker behind `/dashboard.html`. Returns one JSON snapshot:
Worker health probes + aggregate enrollment / check-in / training / scorecard counts from REDCap.
No names, emails, tokens, or record_ids (record_id is the participant's email) ever leave the Worker.

## Deploy

```sh
cd workers/dashboard-stats
npx wrangler secret put REDCAP_API_TOKEN   # create a READ-ONLY (export-only) REDCap API token for this
npx wrangler secret put DASHBOARD_SECRET   # long random string; this is the dashboard password
npx wrangler deploy
```

Then confirm `WORKER_URL` in `dashboard.html` matches the deployed URL.
`wrangler deploy` fails if any service named in `wrangler.toml` doesn't exist in the account.

## What the health probes do (and don't) prove

All probes are write-free. "Up" means: deployed, reachable, and — for the module / practice
Workers — its env vars are set (a missing secret returns 500 *before* token validation, so it shows as Degraded).
It does **not** prove each Worker's own `REDCAP_API_TOKEN` is valid: each Worker holds its own copy and
the only way to test it is a real lookup. The separate `redcap` row tests only *this* Worker's token.
Observed error rates need Cloudflare's Workers Analytics (GraphQL API), which this does not use.

`compute-matches` is probed with `OPTIONS` only. Never POST to it from monitoring: it runs the
match-and-email job as soon as the body has an event number.

## Assumptions to verify against the live REDCap project

Fields requested (missing ones are skipped and listed under Data quality, not fatal):
`event_num, event_date, sex, condition, pid, match_count, access_token, module{1-7}_complete,
m{1-6}_started_ts, m7c_chat_started_ts`, plus the scorecard repeating instrument's `event` field.
`m4`–`m6` timestamp names and the probe behaviour of `module4/5/6-submit` were inferred from modules 1–3, not read.
