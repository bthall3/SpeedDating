/**
 * compute-matches Worker (v4 — only checked-in attendees)
 *
 * Source pulled from the deployed Worker (Nov 2026) and versioned here.
 *
 * v4 FIX: step 1 used to select everyone with [event_num]='<event>', which is
 * the event a participant was *scheduled* for (written by qualtrics-intake),
 * not who actually attended. No-shows therefore got a match_summary row with
 * match_count = 0, which fires the REDCap "no matches" Alert. Attendance is
 * now [event_num]='<event>' AND [pid] != '' — the checkin Worker writes pid
 * only when someone checks in at the event, and reschedule-participant refuses
 * to move anyone who already has a pid, so pid + event_num identifies people
 * who checked in to this event.
 *
 * KEY FINDING from live testing: `rater_record_id`/`partner_record_id` on
 * the scorecard instrument are NOT real REDCap record_id values — they're
 * just the PID text duplicated. The real record_id has to be resolved via
 * the `pid` field on each participant's own (participant_info) record.
 *
 * ALSO: combining `forms` + `filterLogic` in a REDCap export was silently
 * dropping `record_id` and `redcap_repeat_instrument`/`redcap_repeat_instance`
 * from the response. Fetching full records (no `forms` restriction) avoids
 * this entirely.
 *
 * Architecture:
 *   1. Pull everyone checked in for this event ([event_num]='<event>' and a
 *      non-empty pid) — gives record_id, pid, first_name, email for every
 *      attendee.
 *   2. Fetch full records (no forms restriction) for those record_ids.
 *   3. For each scorecard repeat row: the rater's real id is that row's
 *      own record_id; the partner's real id comes from resolving
 *      partner_id (a PID) against the map from step 1.
 *   4. Compute mutual "Yes" pairs, write one match_summary row per
 *      attendee (whether matched or not) plus structured match_notification
 *      rows per pair for research/analysis.
 *
 * Required Cloudflare secrets:
 *   - REDCAP_API_TOKEN
 *   - ADMIN_SECRET
 */

const REDCAP_URL = "https://redcap.as.ua.edu/api/";
const YES_VALUE = "1"; // confirmed from live REDCap export
const ALLOWED_ORIGIN = "https://uaspeeddatingstudy.com";

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (request.method !== "POST") return jsonError(corsHeaders, 405, "Method not allowed");

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError(corsHeaders, 400, "Invalid JSON body");
    }

    const { event, adminSecret, format } = body || {};
    if (adminSecret !== env.ADMIN_SECRET) return jsonError(corsHeaders, 401, "Unauthorized");
    if (!event) return jsonError(corsHeaders, 400, "Missing event number");

    const token = env.REDCAP_API_TOKEN;

    try {
      // 1. Everyone CHECKED IN for this event. event_num alone is only the
      //    scheduled event; pid is written by the checkin Worker on arrival.
      const attendeeRows = await redcapExport(token, {
        content: "record",
        format: "json",
        filterLogic: `[event_num]='${event}' and [pid] != ''`,
        "fields[0]": "record_id",
        "fields[1]": "pid",
        "fields[2]": "first_name",
        "fields[3]": "email",
      });

      // pidMap: PID -> {record_id, first_name, email}
      // recordInfoMap: record_id -> {first_name, email}
      const pidMap = {};
      const recordInfoMap = {};
      for (const r of attendeeRows) {
        // Belt and braces: never treat a record without a pid as an attendee,
        // even if the filterLogic above were ever changed or ignored.
        if (!r.record_id || !String(r.pid || "").trim()) continue;
        const info = { record_id: r.record_id, first_name: r.first_name, email: r.email };
        pidMap[r.pid] = info;
        recordInfoMap[r.record_id] = info;
      }

      const attendeeRecordIds = Object.keys(recordInfoMap);

      if (attendeeRecordIds.length === 0) {
        return jsonOk(corsHeaders, {
          event,
          attendeesFound: 0,
          mutualMatchesFound: 0,
          peopleProcessed: 0,
          note: "No checked-in records (event_num + pid) found for that event. Nothing else was queried.",
        });
      }

      // 2. Full records for those attendees — no `forms` restriction, since
      //    combining forms+filterLogic was the thing dropping record_id and
      //    repeat-instance metadata in testing.
      const fullRows = await redcapExport(token, {
        content: "record",
        format: "json",
        records: attendeeRecordIds.join(","),
      });

      const scorecardRows = fullRows.filter(
        (r) => r.redcap_repeat_instrument === "scorecard" && String(r.event) === String(event)
      );

      const diagnostics = {
        attendeesCheckedIn: attendeeRecordIds.length,
        fullRowsReturned: fullRows.length,
        scorecardRowsFound: scorecardRows.length,
        unresolvedPartnerPids: [],
      };

      // 3. Decision map, resolving partner PID -> real record_id.
      const decisions = {};
      for (const r of scorecardRows) {
        const raterRecordId = r.record_id; // this row's own record IS the rater
        const partnerInfo = pidMap[r.partner_id];
        if (!partnerInfo) {
          diagnostics.unresolvedPartnerPids.push(r.partner_id);
          continue; // typo'd or unknown PID — skip rather than guess
        }
        decisions[`${raterRecordId}_${partnerInfo.record_id}`] = r.choice;
      }

      // 4. Mutual "Yes" pairs, each counted once.
      const matchPairs = [];
      const seenPairs = new Set();
      for (const key of Object.keys(decisions)) {
        if (decisions[key] !== YES_VALUE) continue;
        const [a, b] = key.split("_");
        if (decisions[`${b}_${a}`] !== YES_VALUE) continue;
        const pairKey = [a, b].sort().join("|");
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        matchPairs.push([a, b]);
      }

      // 5. record_id -> [partner_record_id, ...]
      const matchesByRecord = {};
      for (const [a, b] of matchPairs) {
        (matchesByRecord[a] = matchesByRecord[a] || []).push(b);
        (matchesByRecord[b] = matchesByRecord[b] || []).push(a);
      }

      // 6. Idempotency: match_count is duplicated onto every row for a
      //    record in flat export, so grab it from any row belonging to
      //    that record_id.
      const matchCountByRecord = {};
      for (const r of fullRows) {
        if (r.record_id && r.match_count !== undefined) {
          matchCountByRecord[r.record_id] = r.match_count;
        }
      }
      const alreadyProcessed = new Set(
        attendeeRecordIds.filter(
          (id) => matchCountByRecord[id] !== "" && matchCountByRecord[id] != null
        )
      );

      // 7. Build import payload.
      const now = new Date().toISOString();
      const toImport = [];
      let peopleProcessed = 0;

      for (const recordId of attendeeRecordIds) {
        if (alreadyProcessed.has(recordId)) continue;
        peopleProcessed++;

        const partners = matchesByRecord[recordId] || [];
        const validPartners = partners
          .map((pid) => ({ pid, info: recordInfoMap[pid] }))
          .filter((p) => p.info && p.info.email);

        const summaryLines = validPartners.map((p) => `${p.info.first_name} — ${p.info.email}`);

        toImport.push({
          record_id: recordId,
          match_count: summaryLines.length,
          all_matches_summary: summaryLines.join("<br>"), // switch to "\n" if your Alert template is plain text
        });

        validPartners.forEach((p, i) => {
          toImport.push({
            record_id: recordId,
            redcap_repeat_instrument: "match_notification",
            redcap_repeat_instance: i + 1,
            match_event: event,
            match_partner_record_id: p.pid,
            match_partner_first_name: p.info.first_name,
            match_partner_email: p.info.email,
            match_timestamp: now,
          });
        });
      }

      const preview = attendeeRecordIds
        .filter((id) => !alreadyProcessed.has(id))
        .map((recordId) => {
          const self = recordInfoMap[recordId] || {};
          const partners = matchesByRecord[recordId] || [];
          const validPartners = partners
            .map((pid) => recordInfoMap[pid])
            .filter((info) => info && info.email);
          return {
            record_id: recordId,
            first_name: self.first_name || "",
            email: self.email || "",
            match_count: validPartners.length,
            matched_with: validPartners.map((info) => `${info.first_name} <${info.email}>`),
          };
        });

      if (format !== "csv" && toImport.length > 0) {
        await redcapImport(token, toImport);
      }

      if (format === "csv") {
        const csv = buildCsv(event, preview);
        return new Response(csv, {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/csv",
            "Content-Disposition": `attachment; filename="matches-event-${event}.csv"`,
          },
        });
      }

      return jsonOk(corsHeaders, {
        event,
        attendeesFound: attendeeRecordIds.length,
        mutualMatchesFound: matchPairs.length,
        peopleProcessed,
        alreadyProcessedSkipped: attendeeRecordIds.length - peopleProcessed,
        diagnostics,
        preview,
      });
    } catch (err) {
      return jsonError(corsHeaders, 500, err.message);
    }
  },
};

async function redcapExport(token, params) {
  const body = new URLSearchParams({ token, ...params });
  const res = await fetch(REDCAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`REDCap export failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function redcapImport(token, records) {
  const body = new URLSearchParams({
    token,
    content: "record",
    format: "json",
    type: "flat",
    overwriteBehavior: "normal",
    data: JSON.stringify(records),
  });
  const res = await fetch(REDCAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`REDCap import failed (${res.status}) ${text}`);
  }
  return res.json();
}

function buildCsv(event, preview) {
  const header = ["event", "record_id", "first_name", "email", "match_count", "matched_with"];
  const lines = [header.join(",")];
  for (const p of preview) {
    lines.push(
      [event, p.record_id, p.first_name, p.email, p.match_count, p.matched_with.join("; ")]
        .map(csvEscape)
        .join(",")
    );
  }
  return lines.join("\n");
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function jsonOk(corsHeaders, data) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function jsonError(corsHeaders, status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
