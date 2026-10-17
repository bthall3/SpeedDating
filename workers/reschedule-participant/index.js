/* =========================================================================
   reschedule-participant Worker
   -------------------------------------------------------------------------
   POST https://reschedule-participant.<subdomain>.workers.dev/reschedule
   Header: Authorization: Bearer <DASHBOARD_SECRET>
   Body:   { email, event_num, event_date?: "YYYY-MM-DD", confirm?: boolean }

   Moves one participant to a different event (or gives an event to someone
   whose intake finished without one) WITHOUT a terminal. It does exactly
   what re-submitting the Qualtrics survey would do, by replaying the
   participant's own stored values through the existing qualtrics-intake
   Worker (service binding). That keeps one source of truth for the
   training-email / day-before date math and for generate-participant, so
   nothing is re-implemented here.

   Two steps, both POST to the same URL:
     confirm omitted/false -> DRY RUN. Validates, returns what would change.
                              Writes nothing.
     confirm: true         -> applies it, then re-reads the record and
                              returns what REDCap now holds.

   This Worker never writes to REDCap itself -- qualtrics-intake does -- so
   its REDCAP_API_TOKEN can be a READ-ONLY (export) token.

   Refuses when:
     - the participant has already checked in (pid set)
     - the target event is already in the past
     - the participant is already in that event with that date
     - event_date is supplied but disagrees with the date other participants
       of that event already have
     - the event has no known date and none was supplied

   SECRETS:  REDCAP_API_TOKEN (read-only is enough), DASHBOARD_SECRET
             (set to the same value as dashboard-stats so the dashboard
             password works for both), QUALTRICS_SHARED_SECRET (same value
             as qualtrics-intake; lets this Worker call it)
   VARS:     REDCAP_API_URL (default https://redcap.as.ua.edu/api/)
   BINDING:  QUALTRICS_INTAKE -> service "qualtrics-intake"
   ========================================================================= */

const ALLOWED_ORIGINS = [
  "https://bthall3.github.io",
  "https://uaspeeddatingstudy.com",
  "https://www.uaspeeddatingstudy.com"
];

const DEFAULT_REDCAP_URL = "https://redcap.as.ua.edu/api/";
const TIMEZONE = "America/Chicago";

// record_id is the participant's email. These patterns also make the values
// safe to use in REDCap filterLogic / records parameters (no quotes or
// brackets possible).
const EMAIL_RE = /^[^\s@,'"\\\[\]]+@[^\s@,'"\\\[\]]+\.[^\s@,'"\\\[\]]+$/;
const EVENT_RE = /^[A-Za-z0-9_-]{1,10}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

const RECORD_FIELDS = [
  "record_id", "email", "first_name", "sex", "orientation",
  "event_num", "event_date", "training_email_date", "day_before_date",
  "condition", "access_token", "pid"
];

/* ------------------------------------------------------------------ http */

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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

/* ------------------------------------------------------------------ dates */

function todayInTz() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date()); // YYYY-MM-DD
}

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

const isoToUs = iso => { const [y, m, d] = iso.split("-"); return `${m}/${d}/${y}`; };

/* ----------------------------------------------------------------- REDCap */

async function redcapExport(env, params) {
  const res = await withTimeout(fetch(env.REDCAP_API_URL || DEFAULT_REDCAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: env.REDCAP_API_TOKEN, content: "record", format: "json", type: "flat", returnFormat: "json", ...params })
  }), 20000);
  if (!res.ok) throw new Error(`REDCap HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("REDCap returned an error");
  return data;
}

async function getParticipant(env, email) {
  const rows = await redcapExport(env, { records: email, fields: RECORD_FIELDS.join(",") });
  // Base instrument row only (repeating instruments carry redcap_repeat_instrument).
  return rows.find(r => !r.redcap_repeat_instrument) || null;
}

// Date other participants of this event already carry. Most common wins so
// a single typo'd record can't define the event.
async function knownEventDate(env, eventNum) {
  const rows = await redcapExport(env, {
    filterLogic: `[event_num]='${eventNum}'`,
    fields: "record_id,event_date"
  });
  const counts = new Map();
  for (const r of rows) {
    if (r.redcap_repeat_instrument) continue;
    if (ISO_RE.test(r.event_date || "")) counts.set(r.event_date, (counts.get(r.event_date) || 0) + 1);
  }
  let best = null, bestN = 0;
  for (const [d, n] of counts) if (n > bestN) { best = d; bestN = n; }
  return best;
}

function snapshot(r) {
  return {
    event_num: r.event_num || "",
    event_date: r.event_date || "",
    training_email_date: r.training_email_date || "",
    day_before_date: r.day_before_date || "",
    condition: r.condition || "",
    has_token: !!r.access_token
  };
}

/* ------------------------------------------------------------------ entry */

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, origin);

    // Fail closed: an unset secret must never mean "open".
    if (!env.DASHBOARD_SECRET) return json({ error: "server_misconfigured" }, 500, origin);
    const provided = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!provided || !(await secretsMatch(provided, env.DASHBOARD_SECRET))) {
      return json({ error: "unauthorized" }, 401, origin);
    }

    const url = new URL(request.url);
    if (url.pathname !== "/reschedule") return json({ error: "not_found" }, 404, origin);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400, origin); }

    const email = String(body.email || "").trim().toLowerCase();
    const eventNum = String(body.event_num || "").trim();
    const suppliedDate = String(body.event_date || "").trim();
    const confirm = body.confirm === true;

    if (!EMAIL_RE.test(email)) return json({ error: "Enter a valid participant email." }, 422, origin);
    if (!EVENT_RE.test(eventNum)) return json({ error: "Enter a valid event number." }, 422, origin);
    if (suppliedDate && !ISO_RE.test(suppliedDate)) return json({ error: "Event date must be YYYY-MM-DD." }, 422, origin);

    try {
      const person = await getParticipant(env, email);
      if (!person) return json({ error: "No participant found with that email. Check the spelling." }, 404, origin);

      if (person.pid) {
        return json({ error: "This participant has already checked in, so they can't be moved. Handle it in REDCap." }, 409, origin);
      }
      if (!["M", "F"].includes(person.sex)) {
        return json({ error: "Participant record has no valid sex (M/F). Fix it in REDCap first." }, 422, origin);
      }

      const known = await knownEventDate(env, eventNum);
      if (suppliedDate && known && suppliedDate !== known) {
        return json({ error: `Event ${eventNum} is already scheduled for ${known}, not ${suppliedDate}.` }, 409, origin);
      }
      const eventDate = suppliedDate || known;
      if (!eventDate) {
        return json({ error: `No date is on file for event ${eventNum}. Enter the event date.`, needs_date: true }, 422, origin);
      }

      const today = todayInTz();
      const daysUntil = daysBetween(today, eventDate);
      if (daysUntil < 0) return json({ error: `Event ${eventNum} (${eventDate}) is in the past.` }, 422, origin);

      if (person.event_num === eventNum && person.event_date === eventDate) {
        return json({ error: `Already registered for event ${eventNum} on ${eventDate}. Nothing to change.` }, 409, origin);
      }

      const trainingDate = new Date(`${eventDate}T00:00:00Z`);
      trainingDate.setUTCDate(trainingDate.getUTCDate() - 7);
      const trainingIso = trainingDate.toISOString().slice(0, 10);

      const warnings = [];
      if (daysUntil < 7) warnings.push(`The event is ${daysUntil} day(s) away, so the 7-day training email date (${trainingIso}) has already passed. Check whether that email will still send.`);
      if (person.condition && person.event_num && person.event_num !== eventNum) {
        warnings.push(`They keep their existing condition (${person.condition}); it is not re-balanced for the new event.`);
      }

      const preview = {
        first_name: person.first_name || "",
        before: snapshot(person),
        after: { event_num: eventNum, event_date: eventDate, days_until: daysUntil },
        warnings
      };

      if (!confirm) return json({ ok: true, applied: false, preview }, 200, origin);

      if (!env.QUALTRICS_INTAKE || !env.QUALTRICS_SHARED_SECRET) {
        return json({ error: "server_misconfigured" }, 500, origin);
      }

      // Replay the stored values through the normal intake path. orientation,
      // sex and first_name come from the record itself, so nothing else in it
      // changes (a blank value would not overwrite anyway).
      const intakeRes = await withTimeout(env.QUALTRICS_INTAKE.fetch("https://internal/qualtrics-intake", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.QUALTRICS_SHARED_SECRET}` },
        body: JSON.stringify({
          email,
          sex: person.sex === "M" ? "1" : "2",
          first_name: person.first_name || "",
          orientation: person.orientation || "",
          event_num: eventNum,
          event_date: isoToUs(eventDate)
        })
      }), 25000);

      if (!intakeRes.ok) {
        return json({ error: `Intake rejected the update (HTTP ${intakeRes.status}). Nothing was confirmed; check the record in REDCap.` }, 502, origin);
      }

      // Don't trust the intake response; read back what REDCap holds now.
      const after = await getParticipant(env, email);
      const result = after ? snapshot(after) : null;
      const complete = !!(result && result.event_num === eventNum && result.event_date === eventDate &&
        result.training_email_date && result.day_before_date && result.condition && result.has_token);

      return json({
        ok: true,
        applied: true,
        complete,
        first_name: person.first_name || "",
        before: preview.before,
        after: result,
        warnings: complete ? warnings : [...warnings, "Update was sent but the record is not fully populated. Check it in REDCap."]
      }, 200, origin);
    } catch (err) {
      return json({ error: err.message === "timeout" ? "A request timed out. Check the record in REDCap before retrying." : "Something went wrong talking to REDCap." }, 502, origin);
    }
  }
};
