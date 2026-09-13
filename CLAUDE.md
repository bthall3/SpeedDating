# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Static site for the University of Alabama Department of Psychology Speed Dating Study (uaspeeddatingstudy.com, per `CNAME`). No build step, no package manager, no framework — plain HTML/CSS/vanilla JS served directly (e.g. via GitHub Pages). There is no test suite, linter, or build command; "running" the site means opening the HTML files directly or serving the directory statically.

## Pages and their roles

- `index.html` — public landing page linking out to a Qualtrics recruitment/eligibility survey.
- `checkin/index.html` — participant event check-in form.
- `scorecard.html` — RA-facing (research assistant) iPad data-entry tool used *during* speed-dating events to record per-date ratings. Deliberately landscape-only, black-and-white, Georgia serif to mirror the physical paper scorecard it replaces (see the comment at the top of its `<style>` block).
- `match-admin.html` — internal admin tool (noindex) that triggers match computation/emailing for an event and can download a CSV summary. Not participant-facing.
- `training/index.html` — token-based dashboard entry point for a multi-module RA training curriculum (`?token=...` resolved server-side; has a `demoMode` fallback).
- `training/module-1.html` through `module-7.html` — individual training modules.
- `training/practice-chat.html` — simulated practice conversation exercise, part of training.

## Architecture: pages call Cloudflare Workers

Every page that needs a backend (submission, check-in, match computation, token resolution, training progress) talks to its own dedicated Cloudflare Worker over `fetch()` — there is no shared backend/API layer in this repo. Each Worker URL is a `bthall3.workers.dev` subdomain hardcoded near the top of the page's inline `<script>`, e.g.:

- `scorecard.html` → `SUBMIT_ENDPOINT` (`scorecard-submit.bthall3.workers.dev/submit`)
- `checkin/index.html` → `WORKER_URL` (`checkin.bthall3.workers.dev/check-in`)
- `match-admin.html` → `WORKER_URL` (`compute-matches.bthall3.workers.dev`) — expects `{ event, adminSecret }` in the POST body, supports `format: "csv"` for a CSV export
- `training/index.html` → `resolve-token.bthall3.workers.dev/resolve-token` (`GET ?t=<token>`)
- `training/module-*.html`, `practice-chat.html` → per-module `submitEndpoint`/`saveEndpoint`/`chatEndpoint`/`feedbackEndpoint`/`logEndpoint`

**None of these Workers live in this repo.** When a page's inline comment says `// TODO: confirm once deployed`, the Worker may not exist yet or its URL may be a placeholder — don't assume the endpoint is live. Changing request/response shapes here requires coordinating with whatever repo/dashboard hosts the actual Worker code.

## Styling conventions

- `styles.css` is the shared base: font import, CSS reset, color tokens (`--crimson`, `--bg`, `--ink`, etc.), and a handful of shared components (`.btn`, `.spinner`, `.error-text`). It's read at the top of the file itself — check it before adding new shared tokens/components.
- Page-specific layout stays in that page's own inline `<style>` block, not in `styles.css` — this is intentional (see the header comment in `styles.css`) to avoid class-name collisions across very different page layouts.
- `scorecard.html` and `match-admin.html` opt out of the shared crimson/cream design tokens entirely and define their own self-contained palettes, because they're internal RA/admin tools rather than participant-facing pages.

## Client-side state

Pages that need to remember state across visits use `localStorage` directly (no cookies, no server sessions for this purpose): `scorecard.html` persists the RA name/event number/session count (`scorecard_event`, `scorecard_ra_input`, `scorecard_count`); `training/index.html` tracks per-token welcome-modal dismissal (`welcomeSeen_<token>`).
