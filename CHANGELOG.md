# Changelog

## Unreleased

- Preserve live subscription state on failed restore; compensate failed orphan
  cleanup and block mutations if file recovery also fails.
- Bound complete YouTube API/RSS responses to ten seconds and 2 MiB; cancel
  unused RSS retry bodies while preserving quota/fallback behavior.
- Fix gold text contrast and watched-card readability; retain 44 px phone tap
  targets and 16 px inputs across card densities and landscape layouts.
- Resolve Unicode/encoded YouTube handles and supported channel-tab URLs.
- Store actual video publication dates, correcting re-observed rows without
  losing reader state; omit API entries without valid publication dates.
- Add refresh heartbeats, a 45-second browser idle deadline, read-only
  foreground reconciliation against server run IDs, and 30-second ordinary
  API read deadlines. Refresh completion keeps the user's current feed selection.
- Added migration 12 and 30-day live-video metadata expiry, with per-item RSS/API
  provenance and observation dates. Expiry/count pruning preserve reader state;
  explicit channel deletion still removes it. Legacy rows retain conservative
  original age, and 304/Shorts probes never renew unseen metadata. Backups and
  archives are unchanged; no blanket policy-compliance claim is made.

## 2.2 - 2026-07-19

- Added a shared refresh preview/execution planner, persisted refresh-rule
  editor, quota history and snapshot arithmetic, system health, explicit
  database checks, and backup verification.
- Added scoped Returns acknowledgement and bounded bulk channel refresh,
  favorite, delete, and direct-membership move actions.
- Added whole-run and mid-run RSS fallback for structured API quota/rate-limit
  failures while preserving non-quota errors.
- Hardened frontend deployment caching so stale hashed assets return 404 instead
  of blank-page SPA responses.
- Improved phone and tablet usability: landscape search, dynamic viewport
  sizing, fixed channel-manager controls, and touch-friendly scrolling for
  sidebars, channel lists, health results, modal content, and operations data.

## 2.1 - 2026-07-19

- Added automatic RSS fallback after YouTube API quota exhaustion.
- Documented smart manual refresh behavior and quota-aware reporting.

## 2.0 - 2026-07-19

- Added smart refresh scheduling, return-upload highlighting and ordering,
  favorites, channel health deletion/retry actions, quota reporting, and the
  WadsTube logo.
