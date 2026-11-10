/* =========================================================================
   /practice-log Worker
   -------------------------------------------------------------------------
   POST https://<this-worker>.workers.dev/
   Body: { token, attempt_id, stage, persona, transcript, categories,
           overall_note, duration_seconds, chat_started_ts }

   The only one of the three practice-* Workers that touches REDCap.

   Every practice date ("attempt") is kept, as its own instance of the
   repeating instrument `module_7_chatbot_log` (fields prefixed m7a_). The page
   POSTs twice per attempt, with the same client-generated attempt_id:
     stage "timer_end"  -- sent automatically when the 4-minute timer hits
                           0, so the transcript survives even if the
                           participant closes the tab before clicking
                           Complete Module. Feedback is not ready yet.
     stage "completed"  -- sent by the Complete Module button, with the
                           feedback ratings.
   The second POST updates the same instance (matched on m7a_attempt_id)
   instead of adding a new one. A missing attempt_id (an old cached copy
   of the page) gets one generated here, so it always becomes a new
   instance.

   The flat fields on `module7_chat_response` (m7c_*) and module7_complete
   keep their original meaning: the FIRST attempt the participant
   completed (clicked Complete Module on). They are written only on a
   "completed" POST, and only while module7_complete is not yet 1 (the
   same overwrite guard as the other module Workers). A "timer_end" POST
   never writes them and never sets module7_complete.

   If feedback generation failed client-side (categories/overall_note are
   null), the session is still logged -- losing the transcript because
   feedback broke would be worse than logging blank rating fields.

   REQUIRED SECRETS: REDCAP_API_TOKEN
   REQUIRED VAR:     REDCAP_API_URL  (https://redcap.as.ua.edu/api/)

   REDCAP SETUP -- existing instrument `module7_chat_response` (unchanged):
     m7c_persona, m7c_duration_seconds, m7c_transcript,
     m7c_rating_<cat> / m7c_comment_<cat>, m7c_overall_note,
     m7c_chat_started_ts, m7c_chat_completed_ts

   REDCAP SETUP -- NEW instrument `module_7_chatbot_log`, marked REPEATING
   (Project Setup > Repeating instruments and events) BEFORE deploying:
     m7a_attempt_id        Text
     m7a_stage             Text   ("timer_end" or "completed")
     m7a_persona           Text
     m7a_duration_seconds  Text, validation integer
     m7a_transcript        Notes  (JSON string of the full transcript)
     m7a_chat_started_ts   Text, datetime_seconds_ymd
     m7a_saved_ts          Text, datetime_seconds_ymd (time of last save)
     m7a_rating_<cat>      Text, validation integer 1-5
     m7a_comment_<cat>     Notes
       <cat> = opening, followup, disclosure, responsiveness, closing
     m7a_overall_note      Notes
   ========================================================================= */

const ALLOWED_ORIGINS = [
  "https://bthall3.github.io",
  "https://uaspeeddatingstudy.com",
  "https://www.uaspeeddatingstudy.com"
];

const RECORD_ID_FIELD = "record_id";
const TOKEN_FIELD = "access_token";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const ATTEMPT_INSTRUMENT = "module_7_chatbot_log";
const STAGES = ["timer_end", "completed"];

const CATEGORY_FIELD_MAP = {
  opening: "opening",
  followup: "followup",
  disclosure: "disclosure",
  responsiveness: "responsiveness",
  closing: "closing"
};

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(origin)
    }
  });
}

function nowAsRedcapDatetime() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function assertEnv(env) {
  if (!env.REDCAP_API_URL) throw new Error("missing_env_REDCAP_API_URL");
  if (!env.REDCAP_API_TOKEN) throw new Error("missing_env_REDCAP_API_TOKEN");
}

async function redcapExport(params, env) {
  const body = new URLSearchParams({
    token: env.REDCAP_API_TOKEN,
    content: "record",
    action: "export",
    format: "json",
    type: "flat",
    returnFormat: "json",
    ...params
  });
  const res = await fetch(env.REDCAP_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) {
    console.log("practice-log: redcap_export_error", res.status);
    throw new Error("redcap_export_error");
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function redcapImport(row, env, label) {
  const body = new URLSearchParams({
    token: env.REDCAP_API_TOKEN,
    content: "record",
    action: "import",
    format: "json",
    type: "flat",
    overwriteBehavior: "normal",
    data: JSON.stringify([row]),
    returnContent: "count",
    returnFormat: "json"
  });
  const res = await fetch(env.REDCAP_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.log(`practice-log: redcap_write_error_${label}`, res.status, errText.slice(0, 300));
    return false;
  }
  return true;
}

async function findRecord(token, env) {
  const rows = await redcapExport({
    filterLogic: `[${TOKEN_FIELD}]='${token}'`,
    fields: `${RECORD_ID_FIELD},${TOKEN_FIELD},module7_complete`
  }, env);
  // Base (non-repeating) row only.
  return rows.find(r => !r.redcap_repeat_instrument) || rows[0] || null;
}

// Returns the instance number to write for this attempt: the existing
// instance whose m7a_attempt_id matches, else (highest instance + 1).
async function resolveAttemptInstance(recordId, attemptId, env) {
  const rows = await redcapExport({
    records: recordId,
    forms: ATTEMPT_INSTRUMENT,
    fields: RECORD_ID_FIELD
  }, env);

  let highest = 0;
  for (const r of rows) {
    if (r.redcap_repeat_instrument !== ATTEMPT_INSTRUMENT) continue;
    const n = parseInt(r.redcap_repeat_instance, 10);
    if (isNaN(n)) continue;
    if (r.m7a_attempt_id === attemptId) return n;
    if (n > highest) highest = n;
  }
  return highest + 1;
}

function addSessionFields(row, prefix, data) {
  row[`${prefix}_persona`] = data.persona || "";
  row[`${prefix}_duration_seconds`] = String(data.duration_seconds || 0);
  row[`${prefix}_transcript`] = JSON.stringify(data.transcript || []);
  row[`${prefix}_chat_started_ts`] = data.chat_started_ts || "";

  if (Array.isArray(data.categories)) {
    data.categories.forEach(cat => {
      const suffix = CATEGORY_FIELD_MAP[cat.key];
      if (!suffix) return;
      row[`${prefix}_rating_${suffix}`] = String(cat.rating);
      row[`${prefix}_comment_${suffix}`] = cat.comment;
    });
  }
  if (typeof data.overall_note === "string") {
    row[`${prefix}_overall_note`] = data.overall_note;
  }
  return row;
}

function buildFirstAttemptRow(recordId, data) {
  const row = {
    [RECORD_ID_FIELD]: recordId,
    redcap_repeat_instrument: "",
    redcap_repeat_instance: "",
    module7_complete: "1",
    m7c_chat_completed_ts: nowAsRedcapDatetime()
  };
  return addSessionFields(row, "m7c", data);
}

function buildAttemptRow(recordId, instance, attemptId, stage, data) {
  const row = {
    [RECORD_ID_FIELD]: recordId,
    redcap_repeat_instrument: ATTEMPT_INSTRUMENT,
    redcap_repeat_instance: instance,
    m7a_attempt_id: attemptId,
    m7a_stage: stage,
    m7a_saved_ts: nowAsRedcapDatetime()
  };
  return addSessionFields(row, "m7a", data);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return jsonResponse({ success: false }, 405, origin);
    }

    try {
      assertEnv(env);
    } catch (err) {
      console.log("practice-log: config_error", err.message);
      return jsonResponse({ success: false, error: "config_error" }, 500, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch (err) {
      return jsonResponse({ success: false, error: "bad_json" }, 400, origin);
    }

    const { token } = body;
    if (!token || !TOKEN_PATTERN.test(token)) {
      return jsonResponse({ success: false, error: "bad_token" }, 400, origin);
    }
    if (!Array.isArray(body.transcript)) {
      return jsonResponse({ success: false, error: "bad_transcript" }, 400, origin);
    }

    // Older cached pages send neither field: treat as a completed attempt
    // with a fresh id (always a new instance).
    const stage = body.stage === undefined ? "completed" : body.stage;
    if (!STAGES.includes(stage)) {
      return jsonResponse({ success: false, error: "bad_stage" }, 400, origin);
    }
    let attemptId = body.attempt_id;
    if (attemptId === undefined || attemptId === null || attemptId === "") {
      attemptId = crypto.randomUUID();
    } else if (typeof attemptId !== "string" || !ATTEMPT_ID_PATTERN.test(attemptId)) {
      return jsonResponse({ success: false, error: "bad_attempt_id" }, 400, origin);
    }

    let record;
    try {
      record = await findRecord(token, env);
    } catch (err) {
      console.log("practice-log: lookup_failed", err.message);
      return jsonResponse({ success: false, error: "lookup_failed" }, 500, origin);
    }
    if (!record) {
      return jsonResponse({ success: false, error: "not_found" }, 404, origin);
    }
    const recordId = record[RECORD_ID_FIELD];

    // 1. First completed attempt -> flat m7c_* fields + module7_complete.
    let firstAttempt = false;
    if (stage === "completed" && record.module7_complete !== "1") {
      let ok;
      try {
        ok = await redcapImport(buildFirstAttemptRow(recordId, body), env, "flat");
      } catch (err) {
        console.log("practice-log: flat_write_threw", err.message);
        ok = false;
      }
      if (!ok) {
        return jsonResponse({ success: false, error: "write_failed" }, 500, origin);
      }
      firstAttempt = true;
    }

    // 2. Every attempt -> its own module_7_chatbot_log instance.
    let logged = false;
    try {
      const instance = await resolveAttemptInstance(recordId, attemptId, env);
      logged = await redcapImport(
        buildAttemptRow(recordId, instance, attemptId, stage, body), env, "attempt");
      if (logged) console.log("practice-log: attempt_logged", stage, "instance", instance);
    } catch (err) {
      console.log("practice-log: attempt_log_threw", err.message);
    }

    // The flat write already succeeded, so a failed attempt-log write must
    // not block the participant from completing the module.
    if (!logged && !firstAttempt) {
      return jsonResponse({ success: false, error: "write_failed" }, 500, origin);
    }
    return jsonResponse({ success: true, firstAttempt, attemptLogged: logged }, 200, origin);
  }
};
