# practice-log Worker

Saves module 7 practice dates (the AI chatbot conversation) to REDCap. See the
header comment in `index.js` for the full data flow. In short:

- Every practice date ("attempt") becomes one instance of the **repeating**
  instrument `m7c_attempt_log` (`m7a_*` fields).
- The page saves each attempt twice under one `attempt_id`: automatically when
  the timer ends (`m7a_stage = timer_end`, no feedback yet), then again when
  the participant clicks Complete Module (`m7a_stage = completed`, with
  feedback). The second save updates the same instance.
- The flat `m7c_*` fields on `module7_chat_response` and `module7_complete`
  still hold the participant's **first completed** attempt only.

Attempts that ended before this was deployed are not recoverable: the old
Worker never wrote them anywhere.

---

## Deploy (do the steps in this order)

Steps 1-3 must be finished before step 5. If the new page goes live while the
old Worker is still deployed, the old Worker treats the timer-end save as the
completion: it marks the module complete with no feedback ratings, and then
drops the Complete Module save.

### 1. REDCap: create the `m7c_attempt_log` instrument

If the project is in **Production**, Online Designer changes go into Draft
Mode. Submit them afterwards; adding a new instrument is normally approved
automatically, but your REDCap admins may need to review it.

**Option A: Online Designer (safer).**

1. Project Setup → **Online Designer** → (Production: **Enter Draft Mode**).
2. **Create** a new instrument from scratch. Name it `m7c_attempt_log`.
   REDCap derives the form's *unique name* from what you type. It must end up
   exactly `m7c_attempt_log`, so confirm it in the **Codebook** afterwards.
3. Add these fields. "Text" = *Text Box*; "Notes" = *Notes Box (Paragraph Text)*.

   | Variable | Type | Validation |
   |---|---|---|
   | `m7a_attempt_id` | Text | none |
   | `m7a_stage` | Text | none |
   | `m7a_persona` | Text | none |
   | `m7a_duration_seconds` | Text | Integer |
   | `m7a_transcript` | Notes | none |
   | `m7a_chat_started_ts` | Text | Datetime w/ seconds (Y-M-D H:M:S) |
   | `m7a_saved_ts` | Text | Datetime w/ seconds (Y-M-D H:M:S) |
   | `m7a_rating_opening` | Text | Integer, min 1, max 5 |
   | `m7a_comment_opening` | Notes | none |
   | `m7a_rating_followup` | Text | Integer, min 1, max 5 |
   | `m7a_comment_followup` | Notes | none |
   | `m7a_rating_disclosure` | Text | Integer, min 1, max 5 |
   | `m7a_comment_disclosure` | Notes | none |
   | `m7a_rating_responsiveness` | Text | Integer, min 1, max 5 |
   | `m7a_comment_responsiveness` | Notes | none |
   | `m7a_rating_closing` | Text | Integer, min 1, max 5 |
   | `m7a_comment_closing` | Notes | none |
   | `m7a_overall_note` | Notes | none |

   Variable names must match exactly. The Worker writes to them by name, and
   REDCap rejects the whole import if any of them is missing.

**Option B: data dictionary upload.** `m7c_attempt_log_data_dictionary.csv`
in this folder contains the same fields as data-dictionary rows. Upload
*replaces* the whole dictionary, so: Project Setup → Data Dictionary →
download the **current** dictionary → paste these rows at the end → upload →
review REDCap's change summary (it should show only additions) → commit.

### 2. REDCap: make it repeating

1. Project Setup → *Enable optional modules and customizations* →
   **Repeating instruments and events** → Modify.
2. Tick `m7c_attempt_log`. Leave the custom label blank, or use
   `[m7a_saved_ts]`. Save.
3. If you were in Draft Mode: **Submit Changes for Review**, and wait until
   the changes are live.

Check: Codebook shows the form as `m7c_attempt_log`, marked repeating.

### 3. REDCap: check the API user can read and write the new form

The `practice-log` Worker uses the API token of a specific REDCap user. Under
**User Rights**, open that user (or their role) and check that its data-entry
rights for `m7c_attempt_log` are **View & Edit**, and its export rights are
**Full Data Set**.

This matters: if the user can write the form but not export it, the Worker
can't see existing instances. Every attempt then gets written to instance 1,
overwriting the previous one, which is the same data loss this change fixes.
Step 6 tests for this.

### 4. Cloudflare: deploy the Worker

1. dash.cloudflare.com → **Workers & Pages** → `practice-log`.
2. Check: **Settings → Variables and Secrets** still lists `REDCAP_API_TOKEN`
   (secret) and `REDCAP_API_URL`. Nothing new is needed.
3. Note the current version under **Deployments**, so you can roll back.
4. **Edit code** → select everything in `worker.js` → paste the full contents
   of `workers/practice-log/index.js` → **Deploy**.

(Or, with wrangler installed and logged in: `cd workers/practice-log && npx wrangler deploy`.
`keep_vars = true` keeps the dashboard-set `REDCAP_API_URL`.)

The old page keeps working against the new Worker: its saves are logged as
`completed` attempts with a generated ID.

### 5. Merge the pull request

The site is served by GitHub Pages, so the new `practice-chat.html` goes live
when the PR is merged into `main`, normally within a minute or two. Hard-refresh
(Ctrl/Cmd+Shift+R) before you test, so you don't get a cached copy.

### 6. Test with a test participant

Use a **test** record in the `practice` condition with `module7_complete`
empty or 0. Don't use a real participant's token.

1. Open `training/practice-chat.html?token=<test token>` on the live site.
2. **Attempt 1:** chat, let the timer run out, and on the feedback screen
   **don't** click Complete Module yet. In REDCap, the record should have
   instance #1 of `m7c_attempt_log` with `m7a_stage = timer_end` and a
   transcript. `module7_complete` should still be empty or 0.
3. Click **Complete Module**. Instance #1 should now be `completed` and have
   ratings; there should be **no** instance #2. The flat `m7c_*` fields
   should be filled, and `module7_complete = 1`.
4. **Attempt 2:** open the page again and do a second practice date through
   to Complete Module. There should be a **new** instance #2. Instance #1 and
   the flat `m7c_*` fields should be unchanged.
5. **Attempt 3:** start one, let the timer run out, then close the tab. There
   should be an instance #3 with `m7a_stage = timer_end`.

If step 4 overwrote instance #1 instead of adding #2, recheck step 3 (export
rights). The Worker log line `practice-log: attempt_logged <stage> instance <n>`
in Cloudflare (Worker → **Logs**, or `npx wrangler tail practice-log`) shows
which instance it wrote.

Afterwards, delete the test instances or the test record.

### Rollback

- Worker: **Deployments** → choose the previous version → **Rollback**.
- Page: revert the merge commit on `main`.
- Roll back the page before the Worker, for the same reason as the
  deploy-order warning above.

## Reading the data

Export `m7c_attempt_log` (Data Exports, or the API with `forms=m7c_attempt_log`).
Each row is one attempt: `record_id` + `redcap_repeat_instance`. Instance
numbers follow the order attempts were first saved. `m7a_transcript` is a
JSON array of `{role, content, timestamp}`, where `role` is `user` for the
participant and `assistant` for the chatbot; parse it rather than reading it
in REDCap's UI. Rows with `m7a_stage = timer_end` are attempts where the
participant never clicked Complete Module, so they have no feedback ratings.
