# WadsTube

## Project overview

Self-hosted YouTube subscription manager and video feed viewer. The backend is
Node.js/Express, the frontend is Svelte, and the portable deployment runs in
Docker. The maintainer's Shrimp production instance is a native NixOS package.
Folder memberships live in `tube.json`; videos and operational state live in
SQLite (`wadstube.db`). Refresh uses free YouTube RSS by default. The YouTube
Data API is used for URL/handle resolution and optional user-initiated API
refreshes.

## Architecture

- **Backend:** Node.js + Express (`server/`)
- **Frontend:** Svelte built with Vite (`client/`), served by Express
- **Data:** The `data/` volume contains `tube.json`, `wadstube.db`, and verified
  `backups/YYYY-MM-DD/` pairs.
- **Refresh:** User-initiated only. RSS requests use conditional headers.
  Preview and execution share `server/lib/refresh-plan.js`; preview is
  read-only, while POST takes the single refresh lock and recomputes. API mode
  preflights the complete due set and falls back to RSS if local daily quota
  cannot cover it. Structured mid-run quota/rate-limit errors trip a shared
  breaker and move remaining channels to an independent five-request RSS pool.
- **Backup:** Nightly backup takes the same lock, copies `tube.json`, creates a
  SQLite snapshot with `VACUUM INTO`, verifies both staged files, and only then
  publishes the pair.
- **Docker:** Multi-stage Alpine image, health check, 512 MB memory limit, and
  `TZ=America/Los_Angeles` so backups and quota-day math align.

## Key files

- `server/index.js` — Express entry point; wires data, DB, backup, routes, and
  static frontend serving
- `server/lib/data.js` — normalized `tube.json`, atomic writes, and CRUD
- `server/lib/db.js` — additive migrations, application state, FTS, quota,
  health, retention, and `VACUUM INTO`
- `server/lib/rss.js` — conditional Atom feed fetch and XML parsing
- `server/lib/refresh.js` — RSS/API orchestration, quota-aware fallback, Shorts
  classification, upsert, and prune
- `server/lib/refresh-plan.js` — shared preview/execution eligibility, reason
  grouping, mode preflight, and full-pass arithmetic
- `server/lib/refresh-policy.js` — validated post-upload, retry, and inactivity
  rules
- `server/lib/settings.js` — persisted smart policy with environment fallback
  and source reporting
- `server/lib/frontend.js` — SPA cache and stale-asset policy
- `server/lib/youtube.js` — URL resolution, API channel fetch, and Shorts HEAD
  helper
- `server/lib/migrate.js` — one-time PocketTube to `tube.json` migration
- `server/lib/migrate-cache.js` — one-time `cache.json` to SQLite migration
- `server/lib/backup.js` — staged/verified nightly pairs, dated listing and
  verification, controller state, and 4/4/4 GFS retention
- `server/routes/folders.js` — folder/channel CRUD plus atomic in-place legacy
  resolution and quota-aware URL resolution
- `server/routes/channels.js` — health, favorites, single retry/delete, and
  explicit bounded bulk operations
- `server/routes/videos.js` — video reads, exact scoped Returns IDs/count,
  acknowledgement, and reader state
- `server/routes/refresh.js` — read-only preview and manual NDJSON refresh
- `server/routes/settings.js` — persisted smart-policy GET/PUT/DELETE
- `server/routes/status.js` — quota history/snapshot, system health, explicit DB
  check, and backup list/verify
- `client/src/stores/feed.js` — main Svelte stores and API coordination
- `client/src/stores/operations.js` — operations API clients, policy validation,
  scoped Returns batching, and 500-channel client bounds
- `client/src/lib/Sidebar.svelte` — folder tree, channel filter, and actions
- `client/src/lib/RefreshPreview.svelte` — captured folder scope, preview, and
  confirmation of a freshly recomputed locked plan
- `client/src/lib/ChannelHealth.svelte` — filtered health and bounded bulk UI
- `client/src/lib/OperationsPanel.svelte` — rules, quota, system, and backups
- `client/src/lib/ModalShell.svelte` — shared accessible modal behavior
- `client/src/app.css` — minimal orange theme and responsive styling

## Commands

```bash
# Docker
docker compose up --build -d

# Local dev
cd server && node index.js &
cd client && npm run dev

# Maintainer deployment to Shrimp
# Follow DEPLOYMENT.md; the old ~/wadstube-redeploy.sh path is obsolete.
```

## Environment

- `YOUTUBE_API_KEY` — optional for RSS/canonical IDs; required for URL/handle
  resolution and API refresh
- `MAX_VIDEOS` — per-channel retention cap (default 50)
- `REFRESH_MODE` — default `rss` or `api` mode (default `rss`)
- `REFRESH_MODE_MANUAL` — web-button mode; falls back to `REFRESH_MODE`
- `SMART_REFRESH_POLICY_JSON` — environment default policy. A validated SQLite
  `app_settings` override takes precedence until reset.
- `rss` refresh is quota-free but subject to YouTube per-IP rate limits.
- `api` refresh is one general unit per channel under the June 2026 model.
- Refresh summaries distinguish requested/effective mode, fallback channel
  count, and RSS network-attempt count.
- `DATA_DIR`, `PORT`, and `TZ` retain their existing meanings.

## Constraints

- RSS refreshes use one small GET per channel and no Data API quota.
- RSS exposes about 15 recent videos; retention fills over successive manual
  refreshes.
- Shorts detection is a free HEAD request. Classification is cached and
  transient `unknown` results use paced later retries.
- Handle/video URL additions use one quota unit; canonical channel IDs are
  free.
- RSS fallback is restricted to exact structured quota/rate-limit codes.
  Authentication, permission, not-found, and availability errors remain errors.
- Do not add paid API fields such as view count or duration unless requested.
- Only user actions make channel network requests. Concurrent refreshes are
  rejected.
- Preview never reserves quota or fetches YouTube. POST must recompute under the
  lock rather than trust preview output.
- Return acknowledgement uses 1–5,000 explicit unique video IDs per request.
  UI-wide acknowledgement captures folder/channel/search/favorite/sort scope
  and drains its live results in bounded batches; matching returns that arrive
  during the action may be included. Do not add a scope-only destructive POST.
- Bulk channel mutations accept 1–500 explicit unique canonical IDs. Move only
  changes direct source-folder memberships; nested and other-folder memberships
  remain. Destination collisions merge deterministically.
- Legacy resolution replaces one unresolved membership in place. Canonical IDs
  are free; other URL forms reserve quota normally. Save/DB failure must leave
  or restore the original membership.
- Quota history uses contiguous Pacific dates and is limited to 1–90 days. The
  seven-day average excludes today and includes zero-use complete days.
- Forecast output is current snapshot arithmetic only. Do not add a time
  projection.
- `GET /api/status/system` must remain cheap and must not run `quick_check`.
  `POST /api/status/system/database-check` is the explicit rate-limited path.
- Nightly backup must validate normalization-compatible version 1 JSON and run
  read-only SQLite `quick_check` before publication. Failure must preserve the
  previous same-day pair. Verification accepts only strict valid dates.

## Theming

- Light accent: `#ea580c`; dark accent: `#f97316`
- Respect `prefers-color-scheme`.
- Use Comic Sans MS / Comic Neue with the existing iOS fallback.
- Use CSS `var(--accent)` for accent colors.

## Data format

`tube.json` stores an ordered folder tree. Channels have `id`, `name`, and
`addedAt`; user-renamed entries have `userRenamed: true`.

```json
{
  "version": 1,
  "folders": [
    { "id": "...", "name": "...", "channels": [], "children": [] }
  ]
}
```

Load and restore normalize missing arrays, cap folder depth at four, require
resolved IDs matching `^UC[A-Za-z0-9_-]{22}$`, and strip prototype keys.

`wadstube.db` uses WAL mode and additive migrations through `user_version` 11.
Core tables are:

- `channels` — title, RSS hints, favorite, attempts/successes, latest upload,
  previous-upload flag, and failure state
- `videos` — metadata, Shorts retry state, and pending/final return reason
- `video_state` — watched, starred, hidden, and
  `highlight_acknowledged_at`; acknowledgement hides the active badge without
  clearing `videos.highlight_reason` history
- `api_usage` — Pacific-day quota by bucket and endpoint
- `refresh_runs` — bounded reports with requested/effective mode and fallback
- `app_settings` — validated persisted settings; currently
  `smart_refresh_policy`
- `videos_fts` — FTS5 when supported, with `LIKE` fallback

The newest migrations add `app_settings`, return acknowledgement, its index,
and orphan reader-state cleanup. Do not rewrite or renumber prior migrations.
Shorts remain stored for deduplication but are filtered from normal reads.
