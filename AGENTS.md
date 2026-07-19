# WadsTube

## Project overview

Self-hosted YouTube subscription manager and video feed viewer. Node.js/Express backend + Svelte frontend, runs in Docker. Manages folders/channels in `tube.json`, stores videos and refresh state in SQLite (`wadstube.db`), and refreshes via YouTube RSS feeds by default (no API quota cost). The YouTube Data API is used for URL/handle resolution when adding channels and optionally for user-initiated refreshes.

## Architecture

- **Backend:** Node.js + Express (`server/`)
- **Frontend:** Svelte built with Vite (`client/`), served as static files by Express
- **Data:** In the `data/` volume — `tube.json` (folders/channels) and `wadstube.db` (SQLite: channels + videos)
- **Refresh:** User-initiated only. RSS feeds (`/feeds/videos.xml?channel_id=UC...`) use `If-None-Match`/`If-Modified-Since`; manual refreshes serialize via a single synchronous `tryAcquireLock`/`releaseLock` pair in `server/lib/refresh.js`. API mode preflights the complete due set and switches the whole run to RSS when the local daily budget cannot cover it. Mid-run structured quota/rate-limit errors trip a shared breaker and route remaining channels through an independent five-request RSS pool. Nightly backup waits for any in-flight refresh (`waitForRefreshIdle`) before `VACUUM INTO` so snapshots never race writes.
- **Docker:** Multi-stage build (Alpine), health check, 512MB mem limit, `TZ=America/Los_Angeles` baked in so nightly backups and local-day math line up

## Key files

- `server/index.js` — Express entry point, wires db + backups and backup/restore/resolve-url routes
- `server/lib/data.js` — Load/save tube.json, folder/channel CRUD, atomic writes
- `server/lib/db.js` — SQLite wrapper: additive schema migrations, video/reader/refresh/quota state, retention, FTS search, and VACUUM INTO backup
- `server/lib/rss.js` — Atom feed fetch with conditional headers, XML parsing (`fast-xml-parser`)
- `server/lib/refresh.js` — Orchestration: RSS/API with quota-aware RSS fallback → classify new videos as shorts → upsert → prune
- `server/lib/refresh-policy.js` — Smart manual selection: 2h after a refresh finds an upload, 6h after 90 days inactive, 24h after one year inactive
- `server/lib/frontend.js` — SPA serving policy: no-store HTML, immutable hashed assets, and 404s for stale asset URLs
- `server/lib/youtube.js` — YT Data API client for URL resolution + `checkIsShort` HEAD helper
- `server/lib/migrate.js` — One-time PocketTube → tube.json migration
- `server/lib/migrate-cache.js` — One-time cache.json → SQLite migration (fires if DB is empty and cache.json exists)
- `server/lib/backup.js` — Nightly backups of tube.json + `VACUUM INTO` snapshot of wadstube.db, GFS retention (4 daily + 4 weekly + 4 monthly); fires at 1am container-local time
- `server/routes/folders.js` — Folder/channel CRUD (create, rename, delete folders; add, remove, rename, move channels), input validation
- `server/routes/channels.js` — Channel health, favorites, single-channel retry, and global channel deletion
- `server/routes/videos.js` — Video listing from DB (no network)
- `server/routes/refresh.js` — user-initiated RSS/API refresh (all or per-folder); applies smart inactivity intervals
- `client/src/stores/feed.js` — Svelte stores (including `activeChannelId` for per-channel filter) + API client functions
- `client/src/lib/Sidebar.svelte` — Folder tree with expandable inline channels, channel filter on click, context menu for folders and channels (rename/delete/move)
- `client/src/app.css` — Theme (modern minimal, orange accent, system light/dark mode)

## Commands

```bash
# Docker (production)
docker compose up --build -d

# Local dev
cd server && node index.js &
cd client && npm run dev

# Deploy to production server
ssh shrimp 'bash ~/wadstube-redeploy.sh'
```

## Environment

- `YOUTUBE_API_KEY` — optional for RSS-only use and canonical channel IDs; required for handle/video URL resolution and `REFRESH_MODE=api`
- `MAX_VIDEOS` — retention cap per channel in the DB (default 50)
- `REFRESH_MODE` — global default (`rss` or `api`; default `rss`)
- `REFRESH_MODE_MANUAL` — refresh mode for web-button clicks; falls back to `REFRESH_MODE`
- `SMART_REFRESH_POLICY_JSON` — extensible post-upload cooldown and inactivity thresholds
- `rss` is free but subject to YouTube's per-IP rate limiter; `api` is 1 quota unit per channel per refresh (1,300 channels permits at most 7 full passes/day on the 10k/day free quota; 6 leaves a useful safety margin)
- Refresh summaries persist `requested_mode`, `effective_mode`, `rss_fallbacks`, and the first structured `fallback_reason`; `rss_fallbacks` counts redirected channels while `rss_requests` counts all RSS network attempts, including retries
- `DATA_DIR`, `PORT`, `TZ` — as before

## Constraints

- RSS refreshes are free (no YouTube API quota) — each channel is one small HTTP GET, often a 304
- RSS returns ~15 newest videos per channel; the 50-video retention fills in over successive user-initiated refreshes
- Shorts detection is a free HEAD to `youtube.com/shorts/{id}`. Classification is cached; transient `unknown` results use paced retries on later manual refreshes.
- YouTube Data API is still used at channel-add time for `/@handle` and `/watch?v=...` URLs; each call is 1 unit
- RSS fallback is restricted to exact structured quota/rate-limit codes. Authentication, forbidden, not-found, and availability failures remain errors.
- Do NOT add features requiring extra paid API endpoints (view counts, duration) unless explicitly asked
- Only user-initiated refreshes make channel network requests; concurrent manual refreshes are rejected

## Theming

- Modern minimal theme with orange accent (`#ea580c` light, `#f97316` dark)
- Respects system `prefers-color-scheme` for automatic light/dark switching
- Uses Comic Sans MS / Comic Neue (Google Fonts fallback for iOS)
- All accent colors use CSS `var(--accent)` — change in `app.css` to re-theme

## Data format

`tube.json` — folders as ordered array, each with id, name, channels (id/name/addedAt; optional `userRenamed: true` set when the user renames via the sidebar so later refresh name-sync doesn't revert it), children:
```json
{ "version": 1, "folders": [{ "id": "...", "name": "...", "channels": [...], "children": [...] }] }
```

`tube.json` is normalized on every load and on `/api/restore` upload: missing `channels`/`children` arrays default to `[]`, folder nesting is capped at depth 4, channel IDs must match `^UC[A-Za-z0-9_-]{22}$`, and prototype keys are stripped.

`wadstube.db` — SQLite (WAL mode), with additive `user_version` migrations. Core tables:
- `channels(...)` — title, conditional RSS hints, favorite flag, separate refresh attempt/success timestamps, latest upload, previous-refresh upload flag, and failure state
- `videos(...)` — cached metadata, Shorts classification/retry state, and pending/final return-highlight reason; indexed by channel/published and published
- `video_state(...)` — watched, starred, and hidden state
- `api_usage(...)` — Pacific-day quota ledger by bucket and endpoint
- `refresh_runs(...)` — bounded persistent per-refresh reports, including requested/effective mode and RSS-fallback count/reason
- `videos_fts` — FTS5 content index when supported; reads fall back to `LIKE`

Shorts remain stored for deduplication and classification caching but are filtered out of normal video reads.
