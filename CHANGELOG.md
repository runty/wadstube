# Changelog

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
