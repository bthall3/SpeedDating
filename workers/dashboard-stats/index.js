/* =========================================================================
   dashboard-stats Worker  (read-only)
   -------------------------------------------------------------------------
   GET https://dashboard-stats.<subdomain>.workers.dev/snapshot
   Header: Authorization: Bearer <DASHBOARD_SECRET>

   Returns one JSON snapshot for dashboard.html:
     - health: per-Worker liveness/config probes + REDCap reachability
     - stats:  AGGREGATE enrollment / check-in / training / scorecard counts
               per event (no names, emails, tokens, or record_ids)

   Never writes to REDCap. Never calls compute-matches with a POST (that
   Worker runs the match-and-email job as soon as it sees an event number).

   SECRETS:   REDCAP_API_TOKEN (read access is enough), DASHBOARD_SECRET
   VARS:      REDCAP_API_URL (default https://redcap.as.ua.edu/api/)
   BINDINGS:  one service binding per probed Worker -- see wrangler.toml.
              Required because a Worker cannot fetch() another Worker on
              workers.dev (Cloudflare error 1042).
   ========================================================================= */

const ALLOWED_ORIGINS = [
  "https://bthall3.github.io",
  "https://uaspeeddatingstudy.com",
  "https://www.uaspeeddatingstudy.com"
];

const DEFAULT_REDCAP_URL = "https://redcap.as.ua.edu/api/";
const TIMEZONE = "America/Chicago";
const PROBE_TIMEOUT_MS = 8000;
const STATS_CACHE_MS = 20000; // protects REDCap from refresh spam

// Modules each condition is expected to complete (mirrors generate-participant
// + CLAUDE.md: control none, review 1-6, practice 1-7).
const REQUIRED_MODULES = { control: [], review: [1, 2, 3, 4, 5, 6], practice: [1, 2, 3, 4, 5, 6, 7] };
const CONDITIONS = ["control", "review", "practice"];
const MODULE_COUNT = 7;

/* ------------------------------------------------------------------ probes
   Every probe is side-effect free:
   - OPTIONS is answered before auth/config in every Worker we read.
   - POST {} on the module/practice Workers fails token validation (400)
     BEFORE any REDCap/OpenAI call, but AFTER the env-var check -- so a 500
     there means a missing secret/variable. That is the only config signal
     available without touching participant data.
   - qualtrics-intake / generate-participant: unauthenticated POST -> 401.
   `expect` = statuses that mean healthy.                                    */
const PROBES = [
  { id: "resolve-token",     group: "Training",  binding: "RESOLVE_TOKEN",     method: "GET",  path: "/resolve-token", expect: [404], note: "GET without token -> generic 404" },
  ...[1, 2, 3, 4, 5, 6].map(n => ({
    id: `module${n}-submit`, group: "Training", binding: `MODULE${n}_SUBMIT`, method: "POST", path: "/", body: "{}", expect: [400], configCheck: true
  })),
  { id: "module7-planning",  group: "Training",  binding: "MODULE7_PLANNING",  method: "POST", path: "/", body: "{}", expect: [400], configCheck: true },
  { id: "practice-chat",     group: "Practice chatbot (OpenAI)", binding: "PRACTICE_CHAT",     method: "POST", path: "/", body: "{}", expect: [400], configCheck: true },
  { id: "practice-feedback", group: "Practice chatbot (OpenAI)", binding: "PRACTICE_FEEDBACK", method: "POST", path: "/", body: "{}", expect: [400], configCheck: true },
  { id: "practice-log",      group: "Practice chatbot (OpenAI)", binding: "PRACTICE_LOG",      method: "POST", path: "/", body: "{}", expect: [400], configCheck: true },
  { id: "qualtrics-intake",  group: "Intake & events", binding: "QUALTRICS_INTAKE",  method: "POST", path: "/qualtrics-intake",  expect: [401], note: "unauthenticated POST -> 401" },
  { id: "generate-participant", group: "Intake & events", binding: "GENERATE_PARTICIPANT", method: "POST", path: "/generate-participant", expect: [401], note: "unauthenticated POST -> 401" },
  { id: "checkin",           group: "Intake & events", binding: "CHECKIN",           method: "OPTIONS", path: "/check-in", expect: [200, 204], note: "liveness only (PIN-gated)" },
  { id: "scorecard-submit",  group: "Intake & events", binding: "SCORECARD_SUBMIT",  method: "POST", path: "/submit", body: "{}", expect: [422], note: "empty body -> 422" },
  { id: "compute-matches",   group: "Intake & events", binding: "COMPUTE_MATCHES",   method: "OPTIONS", path: "/", expect: [200, 204], note: "liveness only; never POSTed" }
];

/* ------------------------------------------------------------------ http */

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Vary": "Origin"
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(origin) }
  });
}

// Constant-time comparison via SHA-256 digests (equal length by construction).
async function secretsMatch(provided, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected))
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ---------------------------------------------------------------- health */

async function runProbe(probe, env) {
  const started = Date.now();
  const base = { id: probe.id, group: probe.group, note: probe.note || null };
  const binding = env[probe.binding];
  if (!binding) {
    return { ...base, status: "unknown", detail: `service binding ${probe.binding} not configured`, ms: null };
  }
  try {
    const res = await withTimeout(binding.fetch(`https://internal${probe.path}`, {
      method: probe.method,
      headers: probe.body ? { "Content-Type": "application/json" } : {},
      body: probe.body
    }), PROBE_TIMEOUT_MS);
    const ms = Date.now() - started;
    if (probe.expect.includes(res.status)) return { ...base, status: "up", http: res.status, ms };
    if (res.status === 500 && probe.configCheck) {
      return { ...base, status: "degraded", http: 500, ms, detail: "500 before token validation: likely missing secret/variable (REDCAP_API_TOKEN, REDCAP_API_URL or OPENAI_API_KEY)" };
    }
    return { ...base, status: "degraded", http: res.status, ms, detail: `unexpected HTTP ${res.status} (expected ${probe.expect.join("/")})` };
  } catch (err) {
    return { ...base, status: "down", ms: Date.now() - started, detail: err.message === "timeout" ? `no response in ${PROBE_TIMEOUT_MS / 1000}s` : "request failed" };
  }
}

async function probeRedcap(env) {
  const started = Date.now();
  try {
    const res = await withTimeout(redcapPost(env, { content: "project", format: "json", returnFormat: "json" }), PROBE_TIMEOUT_MS);
    const ms = Date.now() - started;
    if (!res.ok) return { id: "redcap", group: "Dependencies", status: "down", http: res.status, ms, detail: `REDCap API returned HTTP ${res.status} (token revoked or REDCap down?)` };
    return { id: "redcap", group: "Dependencies", status: "up", http: res.status, ms };
  } catch (err) {
    return { id: "redcap", group: "Dependencies", status: "down", ms: Date.now() - started, detail: "REDCap unreachable" };
  }
}

async function getHealth(env) {
  const results = await Promise.all([probeRedcap(env), ...PROBES.map(p => runProbe(p, env))]);
  const counts = { up: 0, degraded: 0, down: 0, unknown: 0 };
  for (const r of results) counts[r.status]++;
  return {
    checked_at: new Date().toISOString(),
    summary: counts,
    // What "up" means is deliberately narrow -- see README "Limits".
    scope: "Worker is deployed, reachable, and (where marked) has its env vars set. Does not prove each Worker's own REDCap token is valid.",
    workers: results
  };
}

/* ----------------------------------------------------------------- REDCap */

function redcapPost(env, params) {
  return fetch(env.REDCAP_API_URL || DEFAULT_REDCAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: env.REDCAP_API_TOKEN, ...params })
  });
}

async function redcapJson(env, params) {
  const res = await withTimeout(redcapPost(env, params), 25000);
  if (!res.ok) throw new Error(`REDCap HTTP ${res.status}`);
  const data = await res.json();
  if (data && data.error) throw new Error("REDCap error");
  return data;
}

// Requesting a field that doesn't exist makes REDCap reject the whole export,
// so intersect what we want with the project's real data dictionary first.
let fieldNameCache = { at: 0, names: null };
async function getFieldNames(env) {
  if (fieldNameCache.names && Date.now() - fieldNameCache.at < 10 * 60 * 1000) return fieldNameCache.names;
  const meta = await redcapJson(env, { content: "metadata", format: "json", returnFormat: "json" });
  fieldNameCache = { at: Date.now(), names: new Set(meta.map(m => m.field_name)) };
  return fieldNameCache.names;
}

function wantedBaseFields() {
  const f = ["record_id", "event_num", "event_date", "sex", "condition", "pid", "match_count", "access_token"];
  for (let n = 1; n <= MODULE_COUNT; n++) f.push(`module${n}_complete`);
  for (let n = 1; n <= 6; n++) f.push(`m${n}_started_ts`);
  f.push("m7c_chat_started_ts");
  return f;
}

/* ------------------------------------------------------------------ stats */

function todayInTz() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date()); // YYYY-MM-DD
}

function daysUntil(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate || "")) return null;
  return Math.round((Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${todayInTz()}T00:00:00Z`)) / 86400000);
}

const blankSexCounts = () => ({ M: 0, F: 0, other: 0 });
const sexKey = s => (s === "M" || s === "F" ? s : "other");
const condKey = c => (CONDITIONS.includes(c) ? c : "unassigned");

function newEvent(ev) {
  const byCond = () => ({ control: 0, review: 0, practice: 0, unassigned: 0 });
  return {
    event: ev,
    event_date: null,
    days_until: null,
    signed_up: 0,
    by_sex: blankSexCounts(),
    by_condition: byCond(),
    condition_by_sex: { M: byCond(), F: byCond(), other: byCond() },
    checked_in: { total: 0, ...blankSexCounts() },
    matches_processed: 0,
    training: Object.fromEntries(CONDITIONS.filter(c => REQUIRED_MODULES[c].length).map(c => [c, {
      n: 0,
      all_complete: 0,
      none_started: 0,
      modules: REQUIRED_MODULES[c].map(m => ({ module: m, completed: 0, started_not_finished: 0 }))
    }])),
    at_risk: 0, // non-control, training incomplete, event <= 3 days away (or past) and not checked in
    scorecards: { rows: 0, raters: 0 }
  };
}

function computeStats(baseRows, scorecardRows, fieldNames) {
  const events = new Map();
  const quality = { total_records: 0, missing_event: 0, missing_sex: 0, missing_condition: 0, missing_token: 0, duplicate_pids: [] };
  const pidCounts = new Map();

  for (const r of baseRows) {
    quality.total_records++;
    const ev = String(r.event_num || "").trim();
    if (!ev) { quality.missing_event++; }
    if (!sexKey(r.sex) || sexKey(r.sex) === "other") quality.missing_sex++;
    if (!CONDITIONS.includes(r.condition)) quality.missing_condition++;
    if (!r.access_token) quality.missing_token++;
    if (r.pid) pidCounts.set(r.pid, (pidCounts.get(r.pid) || 0) + 1);
    if (!ev) continue;

    if (!events.has(ev)) events.set(ev, newEvent(ev));
    const e = events.get(ev);
    const sx = sexKey(r.sex);
    const cd = condKey(r.condition);

    e.signed_up++;
    e.by_sex[sx]++;
    e.by_condition[cd]++;
    e.condition_by_sex[sx][cd]++;
    if (r.event_date && !e.event_date) e.event_date = r.event_date;
    const checkedIn = !!r.pid;
    if (checkedIn) { e.checked_in.total++; e.checked_in[sx]++; }
    if (r.match_count !== undefined && r.match_count !== "") e.matches_processed++;

    const required = REQUIRED_MODULES[cd];
    if (required && required.length) {
      const t = e.training[cd];
      t.n++;
      let completedAll = true;
      let anyStarted = false;
      required.forEach((m, i) => {
        const done = r[`module${m}_complete`] === "1";
        const startedField = m === 7 ? "m7c_chat_started_ts" : `m${m}_started_ts`;
        const started = !!r[startedField];
        if (done) { t.modules[i].completed++; anyStarted = true; }
        else {
          completedAll = false;
          if (started) { t.modules[i].started_not_finished++; anyStarted = true; }
        }
      });
      if (completedAll) t.all_complete++;
      if (!anyStarted) t.none_started++;
      e._incomplete = (e._incomplete || 0) + (completedAll ? 0 : 1);
      e._incompleteNotCheckedIn = (e._incompleteNotCheckedIn || 0) + (completedAll || checkedIn ? 0 : 1);
    }
  }

  for (const [pid, n] of pidCounts) if (n > 1) quality.duplicate_pids.push(pid);

  // Scorecards: counts only.
  const ratersByEvent = new Map();
  for (const s of scorecardRows) {
    const ev = String(s.event || "").trim();
    if (!ev) continue;
    if (!events.has(ev)) events.set(ev, newEvent(ev));
    events.get(ev).scorecards.rows++;
    if (!ratersByEvent.has(ev)) ratersByEvent.set(ev, new Set());
    ratersByEvent.get(ev).add(s.record_id);
  }

  const list = [...events.values()].map(e => {
    e.days_until = daysUntil(e.event_date);
    e.scorecards.raters = ratersByEvent.has(e.event) ? ratersByEvent.get(e.event).size : 0;
    if (e.days_until !== null && e.days_until <= 3) e.at_risk = e._incompleteNotCheckedIn || 0;
    delete e._incomplete;
    delete e._incompleteNotCheckedIn;
    return e;
  });
  list.sort((a, b) => (a.event_date || "9999").localeCompare(b.event_date || "9999") || a.event.localeCompare(b.event, undefined, { numeric: true }));

  return {
    generated_at: new Date().toISOString(),
    today: todayInTz(),
    timezone: TIMEZONE,
    fields_missing_from_project: wantedBaseFields().filter(f => !fieldNames.has(f)),
    scorecard_tracking: fieldNames.has("event"),
    quality,
    events: list
  };
}

let statsCache = { at: 0, data: null };
async function getStats(env) {
  if (statsCache.data && Date.now() - statsCache.at < STATS_CACHE_MS) return statsCache.data;

  const names = await getFieldNames(env);
  const fields = wantedBaseFields().filter(f => names.has(f));

  const base = await redcapJson(env, { content: "record", format: "json", type: "flat", returnFormat: "json", fields: fields.join(",") });
  const baseRows = base.filter(r => !r.redcap_repeat_instrument);

  let scorecardRows = [];
  if (names.has("event")) {
    const sc = await redcapJson(env, { content: "record", format: "json", type: "flat", returnFormat: "json", fields: "record_id,event" });
    scorecardRows = sc.filter(r => r.redcap_repeat_instrument === "scorecard");
  }

  statsCache = { at: Date.now(), data: computeStats(baseRows, scorecardRows, names) };
  return statsCache.data;
}

/* ------------------------------------------------------------------ entry */

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, origin);

    // Fail closed: an unset secret must never mean "open".
    if (!env.DASHBOARD_SECRET) return json({ error: "server_misconfigured" }, 500, origin);
    const provided = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!provided || !(await secretsMatch(provided, env.DASHBOARD_SECRET))) {
      return json({ error: "unauthorized" }, 401, origin);
    }

    const url = new URL(request.url);
    if (url.pathname !== "/snapshot") return json({ error: "not_found" }, 404, origin);

    // Sections fail independently so a REDCap outage still shows Worker health.
    const [health, stats] = await Promise.allSettled([getHealth(env), getStats(env)]);
    return json({
      health: health.status === "fulfilled" ? health.value : null,
      stats: stats.status === "fulfilled" ? stats.value : null,
      errors: {
        health: health.status === "rejected" ? "health_check_failed" : null,
        stats: stats.status === "rejected" ? "redcap_stats_failed" : null
      }
    }, 200, origin);
  }
};

// Exported for the offline test only.
export { computeStats, daysUntil };
