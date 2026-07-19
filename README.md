# WadsTube

A self-hosted YouTube subscription manager and video feed viewer. Organizes your YouTube subscriptions into folders, pulls new videos via channel RSS feeds (or the YouTube Data API — your choice), stores them in SQLite, and presents them in a clean, themed web interface. Runs in Docker.

## Why

YouTube's native subscription feed is a single unsorted stream. PocketTube (browser extension) adds folder organization but only works in the browser. WadsTube gives you a standalone app with full control: folder management, user-initiated per-folder refresh, search, drag-and-drop channel adding, and no shorts.

## Features

- **Folder-organized feed** — sidebar with expandable folder/subfolder hierarchy
- **Expandable channels in sidebar** — click the chevron next to a folder to see channels inline; click a channel to filter videos to just that channel
- **Channel management** — manage channels from each folder, rename/remove them from the sidebar, and mark favorite channels with a star. A rename sticks across later refreshes.
- **Legacy subscription quarantine** — old URL-style subscription IDs remain in their original folders as visible “Needs resolution” entries; they can be renamed, moved, or removed but never enter refresh, quota, unread, or database-health paths.
- **Reader state** — mark videos watched/unread, star them, or hide/restore them. State is stored in SQLite and shared across devices.
- **Reader views** — all, unread, starred, and hidden views; favorite-channel filtering; newest/oldest/favorites-first/returns-first sorting; grid, compact, and list layouts.
- **Persistent navigation** — folder, channel, search, reader view, favorites, sort, and density are encoded in the URL for reloads and browser back/forward.
- **Refresh health** — inspect each channel's last attempt, latest error, stale status, and retry one channel directly.
- **Manual-only refresh** — WadsTube makes no automatic channel requests; every refresh starts from a user click
- **RSS or API refresh** — RSS is free; user-initiated refreshes can instead use the YouTube Data API when RSS is rate-limited
- **Smart refresh selection** — a user-initiated folder/all refresh waits 2 hours after a refresh that found a new upload, and skips inactive channels until their configured minimum has elapsed (6 h after 90 days, 24 h after 365 days by default)
- **Return highlights** — a new long-form upload from a channel returning after at least 3 months is highlighted with a bold red border, without marking an initial backfill
- **Quota ledger** — persistent Pacific-day API usage, remaining general/search budgets, per-endpoint counts, and per-refresh API/RSS/Shorts reports
- **Live progress UI** — a per-channel overlay shows each channel as it's fetched, with a `done/total` counter, running "new videos" tally, and error count
- **No YouTube Shorts** — shorts are automatically detected (via a free HEAD request) and filtered out; transient classification failures remain `unknown` and are retried on later refreshes
- **Search** — filter videos by title, channel name, or description
- **Drag-and-drop** — drag any YouTube URL (video, channel, @handle, shorts, live) onto a folder to add that channel
- **Paste to add** — paste URLs in the channel list panel (works on mobile)
- **URL resolution** — video URLs are auto-resolved to the channel via YouTube API (1 unit)
- **Exports and backups** — subscription JSON export/import is separate from a downloadable full export containing `tube.json`, an integrity-checked SQLite snapshot, checksums, and a manifest; nightly backups retain consistent on-disk snapshots
- **Accessible video actions** — native YouTube links plus explicit copy, watched, star, and hide controls
- **Mobile-friendly** — long-press for context menus, iOS home screen icon, responsive layout
- **System light/dark mode** — auto-switches with OS theme
- **Local timezone** — video publish times displayed in your browser's timezone
- **PocketTube migration** — auto-imports from PocketTube JSON export on first run

## Architecture

```
┌─────────────────────────────────────────────────┐
│                    Docker                        │
│                                                  │
│  ┌──────────┐     ┌──────────────────────────┐  │
│  │  Svelte  │────▶│    Express Server         │  │
│  │   SPA    │     │                           │  │
│  │ (static) │◀────│  /api/folders             │  │
│  └──────────┘     │  /api/videos              │  │
│                   │  /api/refresh  (NDJSON)   │  │
│                   │  /api/backup              │  │
│                   │  /api/restore             │  │
│                   │  /api/resolve-url         │  │
│                   └────────────┬──────────────┘  │
│                                │                 │
│                   ┌────────────▼──────────────┐  │
│                   │      /app/data/            │  │
│                   │   tube.json  (folders)     │  │
│                   │   wadstube.db (SQLite)     │  │
│                   │   backups/YYYY-MM-DD/      │  │
│                   └────────────┬──────────────┘  │
│                                │                 │
└────────────────────────────────┬─────────────────┘
                                 │
             ┌───────────────────┼──────────────────┐
             │                                      │
  ┌──────────▼──────────┐              ┌───────────▼─────────┐
  │  YouTube RSS feeds  │              │  YouTube Data API   │
  │  (free, rate-       │              │  (1 quota unit per  │
  │   limited per IP)   │              │   channel; used for │
  │                     │              │   URL resolution    │
  │                     │              │   always, plus      │
  │                     │              │   refresh when      │
  │                     │              │   REFRESH_MODE=api) │
  └─────────────────────┘              └─────────────────────┘
```

### Stack

- **Backend:** Node.js + Express
- **Frontend:** Svelte (built with Vite)
- **Deployment:** Docker (multi-stage build, Alpine Linux)
- **Data:** `tube.json` (folders/channels, atomic writes) + `wadstube.db` (SQLite, WAL mode) on a mounted volume

### Data Flow

1. **Page load** — frontend fetches `/api/folders` (folder tree) and shows the sidebar. No videos are loaded until you click a folder.
2. **Select folder** — frontend fetches `/api/videos?folder=X`, which reads from `wadstube.db` (no network call).
3. **Refresh** — frontend POSTs to `/api/refresh/:folder`; the server streams NDJSON events back (init, start/done per channel, final summary). Each channel is fetched via RSS or the YouTube Data API depending on `REFRESH_MODE_MANUAL`. New videos are inserted, existing ones have title/description/thumbnail refreshed, and each channel keeps the last `MAX_VIDEOS` visible entries plus a bounded Shorts cache.
4. **Smart selection** — the manual folder/all request checks stored refresh/upload timestamps and whether the previous successful refresh discovered a new upload. It applies the configured 2-hour post-upload, 6-hour inactive, or 24-hour long-inactive minimum. A direct per-channel retry is an explicit override.
5. **Add channel** — frontend POSTs a URL to `/api/folders/:id/channels`. Server resolves the URL to a channel ID (via YouTube Data API if needed), adds it to `tube.json`. Name-based identifiers remain accepted for older clients.

### Data Storage

Two files in `data/`:

**`tube.json`** — your subscription data (folders + channels, atomic write):
```json
{
  "version": 1,
  "folders": [
    {
      "id": "cooking",
      "name": "Cooking",
      "channels": [
        { "id": "UCxAS...", "name": "America's Test Kitchen", "addedAt": "2026-04-15T..." },
        { "id": "UCzZN...", "name": "My Favorite Chef", "addedAt": "...", "userRenamed": true },
        { "id": "https://www.youtube.com/c/legacy", "name": "Legacy reference", "addedAt": "2020-01-01T...", "unresolved": true }
      ],
      "children": [
        { "id": "baking", "name": "Baking", "channels": [...], "children": [] }
      ]
    }
  ]
}
```

`userRenamed: true` is set automatically when you rename a channel from the sidebar so later refreshes leave your chosen name alone. Folder IDs are stable identifiers and do not change on rename; older slug IDs remain valid. The tree is normalized on every load and on restore — missing `channels`/`children` arrays are coerced to `[]`, folder nesting is capped at five levels (depth 0–4), and prototype-pollution keys are stripped. Resolved channel IDs must match `^UC[A-Za-z0-9_-]{22}$`; a nonempty legacy reference that does not match is preserved with `unresolved: true` and excluded from all network and SQLite channel paths. Empty or structurally malformed channel entries remain validation losses. Startup repairs are persisted after saving the original as `tube.json.pre-normalize.*`; restores are rejected with detailed validation errors if normalization would drop folders or channels.

**`wadstube.db`** — SQLite, WAL mode. Core tables include:
- `channels(...)` — last-known title, RSS conditional-request hints, favorite flag, separate attempt/success timestamps, newest known upload, and failure state
- `videos(...)` — cached video metadata, retryable Shorts classification, and durable pending/final return-highlight reason
- `video_state(video_id PK, watched_at, starred_at, hidden_at, updated_at)` — durable reader state
- `api_usage(...)` and `refresh_runs(...)` — Pacific-day quota ledger and a bounded history of persistent run reports
- `videos_fts` — FTS5 search index, transactionally rebuilt on startup; search falls back to `LIKE` if FTS5 is unavailable

If `cache.json` exists on first boot (from a pre-RSS install), it's imported into the DB once and renamed `cache.json.migrated`.

## How the Code Works

### Server

#### `server/index.js` — Entry Point
Loads `tube.json` (or auto-migrates from PocketTube format), opens the SQLite DB, runs the one-time cache.json migration if needed, and creates the shared `appState` used by every route handler. Mounts API routes, schedules nightly backups, and serves the built Svelte SPA. Channel network requests only run from user-initiated routes.

#### `server/lib/data.js` — Data Layer
Manages `tube.json`. Load/save with atomic writes, folder/channel CRUD, recursive channel-id collection, name syncing (propagates channel titles from the DB into `tube.json`).

#### `server/lib/db.js` — SQLite Wrapper
`better-sqlite3` in WAL mode. Sequential `user_version` migrations upgrade existing databases without dropping data. The wrapper stores smart-refresh timestamps, reader state, quota usage and refresh runs; uses FTS5 for indexed video search with a safe `LIKE` fallback; and uses `VACUUM INTO` for consistent snapshots.

#### `server/lib/rss.js` — Atom Feed Client
Fetches `https://www.youtube.com/feeds/videos.xml?channel_id=UC...`, parses with `fast-xml-parser`. Sends `If-None-Match` / `If-Modified-Since` when the DB has them (YouTube doesn't currently emit these, but the code is ready if they turn it on). Retries once with 1s backoff and once more with 3s backoff on 404/5xx, which YouTube throws under per-IP rate pressure.

#### `server/lib/youtube.js` — YouTube Data API Client
- `resolveUrl(apiKey, url)` — parses YouTube URLs in every format (video, channel, @handle, shorts, live, youtu.be) and resolves to `{ channelId, channelTitle }`. Canonical channel URLs are free (0 units). Video URLs use `videos.list` (1 unit). `@handle` URLs use exact `channels.list(forHandle=...)` resolution (1 general quota unit, without consuming the separate search-call allowance).
- `fetchChannelViaApi(apiKey, channelId)` — `playlistItems.list` for the channel's uploads playlist (1 unit, up to 50 items). Returns the same shape as the RSS client so `refresh.js` can dispatch on mode.
- `checkIsShort(videoId)` — HEAD request to `/shorts/{id}`; returns `short`, `long`, or retryable `unknown`.

#### `server/lib/refresh.js` — Refresh Orchestrator
`refreshChannels(db, ids, opts, onEvent)` spins up per-channel workers in a `p-limit` pool (5 concurrent in RSS mode, 20 in API mode). Every attempt stores `last_refresh_attempt_at`; only a successful response (`ok` or RSS `304`) advances `last_refreshed_at`, and a feed response advances `latest_upload_at`. Worker failures are isolated and all workers settle before the run finishes or releases its lock. New long-form videos get the strongest matching inactivity-rule ID when the channel had been refreshed before. Unknown Shorts are selected from SQLite and retried with paced backoff even after they fall outside the current RSS window; a pending return badge survives until classification succeeds. Every run persists its API/RSS/Shorts report.

#### `server/lib/backup.js` — Nightly Backups
Owns the global refresh lock while staging `tube.json` and a `VACUUM INTO wadstube.db` snapshot for `data/backups/YYYY-MM-DD/` every night at 1 am local time (container `TZ`). The complete pair is published as one directory swap, so a failed snapshot or publication restores the prior pair; retention ignores incomplete staging/directories. Grandfather-Father-Son retention keeps 4 daily + 4 weekly + 4 monthly snapshots and catches up on boot when overdue.

#### `server/lib/migrate.js` — PocketTube Migration
One-time migration from PocketTube's JSON export to the native `tube.json` format.

#### `server/lib/migrate-cache.js` — cache.json → SQLite
One-time import of a legacy `cache.json` into SQLite on first boot with the new codebase. Renames the file afterwards so it doesn't re-run.

#### `server/routes/folders.js` — Folder & Channel API
- `GET /api/folders` — folder tree summary (names + counts)
- `POST /api/folders` — create folder (validates name: no `../`, `/`, `\`, null bytes, max 100 chars)
- `PATCH /api/folders/:id` — rename
- `DELETE /api/folders/:id` — delete
- `GET /api/folders/:id/channels` — favorites first, then alphabetical
- `POST /api/folders/:id/channels` — add channel by ID or URL (auto-resolves)
- `DELETE /api/folders/:id/channels/:channelId` — remove
- `PATCH /api/folders/:id/channels/:channelId` — rename
- `POST /api/folders/:id/channels/:channelId/move` — move to another folder

Routes resolve immutable IDs first. An exact, unique legacy folder name remains supported for older clients and returns `Deprecation: true` plus an HTTP `Warning` header; ambiguous names are rejected.

#### `server/routes/videos.js` — Video API
- `GET /api/videos?folder=ID&view=unread&favorites=1&sort=newest` — filtered DB-cached videos
- `GET /api/videos/counts` — unread counts by channel
- `PATCH /api/videos/:videoId/state` — update watched, starred, or hidden state

#### `server/routes/channels.js` — Channel Preference & Health API
- `GET /api/channels?status=error|stale` — refresh-health rows
- `PATCH /api/channels/:channelId` — update the favorite flag
- `POST /api/channels/:channelId/refresh` — retry one subscribed channel

#### `server/routes/refresh.js` — Refresh API (streaming NDJSON)
- `POST /api/refresh` — refresh every channel referenced by any folder
- `POST /api/refresh/:folder` — refresh only channels in that folder

Both stream NDJSON events (Content-Type `application/x-ndjson`) with one event per line:
```
{"type":"init","total":42}
{"type":"start","channelId":"UC...","channelTitle":"Tom Scott"}
{"type":"done","channelId":"UC...","channelTitle":"Tom Scott","status":"ok","newVideos":2}
...
{"type":"summary","refreshed":40,"new_videos":57,"errors":2,"total_channels":...,"total_videos":...}
```

If another manual refresh, restore, or backup already owns the lock, the route returns 409 immediately so the client can surface the conflict rather than stall.

### Client

#### `client/src/stores/feed.js` — State Management
Svelte writable stores cover folders/videos, the active folder/channel, reader view, favorites, sort, density, health, refresh progress, errors and toasts. A shared `channelLists` cache keeps favorite/unread metadata consistent across duplicate folder memberships and the channel modal. URL state is synchronized with browser navigation. `refreshFolder()` incrementally reads NDJSON into `refreshProgress` and returns the final summary.

#### `client/src/App.svelte` — Root Component
Mounts Header, Sidebar, VideoGrid, FolderChannels (modal), Toast, and RefreshProgress. Loads folders on mount.

#### `client/src/lib/Header.svelte` — Top Bar
Hamburger toggle, title, search with clear, gear menu (backup/restore), refresh button with spinner. The completion toast reports new videos, errors/skips, channels checked, API units used by that refresh, and API units used for the current Pacific quota day.

#### `client/src/lib/Sidebar.svelte` — Folder & Channel Navigation
Recursive folder tree keyed by immutable folder IDs, expandable channels, deduplicated unread counts, favorite toggles, keyboard/touch action menus for folder rename/delete and channel rename/move/remove, drag/drop URL targets, "+ New Folder", and mobile overlay.

#### `client/src/lib/VideoGrid.svelte` — Video Display
Server-filtered reader view with all/unread/starred/hidden and favorite-channel controls, newest/oldest/favorite/return ordering, infinite scroll, and grid/compact/list density. **Returns first** promotes red-bordered return uploads and keeps each group newest-first.

#### `client/src/lib/VideoCard.svelte` — Single Video
Native video and channel links, thumbnail/title/description/date, watched/starred/hidden/copy actions, favorite-channel marker, and a return badge when `highlight_reason` is present.

#### `client/src/lib/FolderChannels.svelte` — Channel Management Modal
Favorite-first channel list with paste bar, drag-drop, favorite toggle, and remove button. The modal traps focus, closes on Escape, and restores focus to its opener.

#### `client/src/lib/RefreshProgress.svelte` — Live Refresh Overlay
Bottom-right panel shown while a refresh is active. `done / total` counter, running `+N new` tally, `N errored` suffix when applicable, and one line per currently-fetching channel. Shows up to `CHANNEL_CONCURRENCY_*` lanes (5 for RSS, 20 for API).

#### `client/src/lib/Toast.svelte` — Notifications
Fixed-position toast at bottom-center, 3-second auto-dismiss. Success (green), error (red), info (neutral).

### Docker

**Dockerfile** — multi-stage build:
1. Stage 1 (`client-build`): installs Svelte deps, runs `vite build`, emits `client/dist/`.
2. Stage 2 (runtime): Alpine Node 22; temporarily installs `python3 make g++` so `better-sqlite3` can compile for musl, then removes them. Includes `wget` and `tzdata`; `TZ=America/Los_Angeles` is baked in so the nightly backup scheduler fires at 1 am Pacific regardless of host timezone.

**docker-compose.yml**: mounts `./data` to `/app/data`, passes env vars, 512 MB memory limit, health check every 30 s, `restart: unless-stopped`.

**.dockerignore**: excludes `node_modules`, `client/dist`, `.git`, `.env`, `data/` — necessary so host-built native modules (glibc) don't clobber the image's musl build of `better-sqlite3`.

## Setup

### 1. Get a YouTube Data API Key (optional for RSS-only use)

1. [Google Cloud Console](https://console.cloud.google.com) → new project
2. **APIs & Services > Library** → **YouTube Data API v3** → **Enable**
3. **APIs & Services > Credentials** → **Create Credentials > API key**
4. Copy the key

The key is used for `@handle` and video URL resolution. Canonical `/channel/UC...` URLs and RSS refresh work without one. Any refresh mode set to `api` requires the key.

### 2. Configure

Create a `.env` file in the project root:

```
YOUTUBE_API_KEY=your_api_key_here
```

See [Environment Variables](#environment-variables) for tunable knobs.

### 3. Add Your Subscriptions

**Option A: Import from PocketTube**

Export your PocketTube subscriptions (the browser extension provides a JSON export). Drop it in `data/`:

```
data/youtube_subscription_manager_*.json
```

On first startup, WadsTube auto-migrates this to `tube.json`.

**Option B: Start fresh**

Create `data/tube.json`:

```json
{ "version": 1, "folders": [] }
```

Then add folders and channels through the web UI.

### 4. Deploy with Docker

```bash
docker compose up --build -d
```

The app runs at `http://localhost:3000`.

## Usage

### Viewing Videos

1. Open the app — you'll see the folder sidebar (hamburger menu on mobile).
2. Click a folder to load its videos (no network call — read from SQLite).
3. Click "All" for every folder's videos.
4. Use search to filter by title, channel, or description.

### Refreshing

- Click **Refresh** to pull new videos for the current folder (or all if viewing All).
- A live panel in the bottom-right shows each channel being fetched, a done/total counter, and a running "+N new" tally.
- When it finishes, a toast summarizes the result (`Added 42 new videos`, or `No new videos (3 channels errored)`).
- No channel refresh runs in the background. Closing the app or leaving it idle makes no YouTube channel requests.

### Managing Folders

- **Create:** "+ New Folder" at the bottom of the sidebar.
- **Rename/Delete:** open the folder's `•••` action menu.
- **View Channels:** choose **Manage channels** from that action menu.

Deleting a folder or channel also purges the corresponding rows from `wadstube.db` so stale subscriptions don't keep appearing in the feed.

### Viewing & Filtering by Channel

- Click the chevron next to a folder to expand channels inline.
- Click a channel to filter videos to just that channel (click again to deselect).
- Open a channel's `⋮` action menu for rename, move, or remove; the native menu controls work with keyboard and touch.
- Use the star next to a channel to add or remove it from Favorites.

### Adding Channels

- **Drag-and-drop** a YouTube URL onto a folder.
- **Paste** a URL in the channel list modal.
- Accepted: `youtube.com/watch?v=...`, `youtube.com/channel/UC...`, `youtube.com/@handle`, `youtu.be/...`, `youtube.com/shorts/...`, `youtube.com/live/...`.

### Backup & Restore

**From the UI:** **Export subscriptions** downloads `tube.json` data and **Import subscriptions** validates and imports that JSON. Import waits for refresh to become idle and snapshots both live files before changing or purging data. **Full backup** streams a bounded-memory POSIX TAR containing `manifest.json`, `tube.json`, and a consistent SQLite snapshot. The manifest records byte counts, SHA-256 checksums, and SQLite `quick_check` proof. Full-bundle restore is intentionally a controlled offline operation; the web app never replaces the live database from an uploaded binary bundle.

Verify a downloaded full backup without extracting it:

```bash
cd server
npm run verify-backup -- /path/to/wadstube-full-....tar
```

For a controlled full restore, verify and extract to a new empty directory, stop WadsTube, preserve the current data directory, then copy the two verified files into place:

```bash
cd server
npm run verify-backup -- /path/to/backup.tar --extract /tmp/wadstube-verified
cd ..
docker compose stop
cp -a data "data.pre-full-restore-$(date +%Y%m%d-%H%M%S)"
cp /tmp/wadstube-verified/tube.json data/tube.json
cp /tmp/wadstube-verified/wadstube.db data/wadstube.db
docker compose up -d
```

**Nightly backups:** `data/backups/YYYY-MM-DD/` gets an atomically published pair of `tube.json` + a consistent `wadstube.db` snapshot (via `VACUUM INTO`) every night at 1 am local time. Catches up on startup if a backup is overdue. GFS retention considers only complete pairs (4 daily + 4 weekly + 4 monthly).

To restore a nightly backup:

```bash
cd data
cp backups/2026-04-10/tube.json .
cp backups/2026-04-10/wadstube.db .
docker compose restart
```

## Refresh Modes & Quota

User-initiated refreshes support two modes:

| Mode | Cost | Rate limit | Notes |
|------|------|------------|-------|
| `rss` | free | YouTube throttles per-IP; can 404/5xx under bursts | 15-entry feeds; no `publishedAfter`; refresh pulls full feed every time, dedup by `video_id` |
| `api` | 1 unit per channel per refresh | none that you'll hit organically | 50 items per call; 1 unit regardless of `maxResults` |

Some channel-add URL formats use the Data API:

| Action | Cost |
|--------|------|
| Add channel via channel URL (`/channel/UC...`) | 0 units |
| Add channel via video URL (`/watch?v=...`) | 1 unit |
| Add channel via @handle (`/@name`) | 1 general quota unit (`channels.list(forHandle=...)`) |
| Shorts classification | 0 units (free HEAD request; transient failures are retried) |

Under YouTube's June 2026 quota model, a project receives 10,000 general quota units per day, resetting at midnight Pacific. `search.list` also has a separate default limit of 100 calls/day; WadsTube does not use it. At 1,300 channels:
- **`rss`** everywhere: 0 quota used for refresh.
- **`api`** for refresh: ~1,300 units per full pass → at most 7 full passes/day; 6 passes (every 4 hours) use ~7,800 units and leave a practical safety margin.

The default is RSS so clicks consume no API quota. Set `REFRESH_MODE_MANUAL=api` for predictable API-backed manual refreshes.

WadsTube reserves quota immediately before every actual Data API request, including requests that return errors. General and `search.list` buckets are stored separately using the Pacific quota day. A full API refresh uses a conservative preflight snapshot and is rejected before starting when the then-remaining general budget cannot cover every selected channel. Per-call reservation is still authoritative: concurrent URL resolutions or other API work can consume that snapshot, so a later channel may stop with a quota error after a run has partially completed. The header and Channel Health panel show what remains, and every refresh report records endpoint calls/units, RSS requests, Shorts probes, the run status/error, and the remaining daily general budget.

### Smart refresh policy

The default policy waits 2 hours after a successful refresh that discovered a new upload. Separately, a channel whose newest known upload is at least 90 days old has a 6-hour minimum refresh interval; at 365 days the stronger 24-hour rule wins. Add or replace rules with validated JSON:

```env
SMART_REFRESH_POLICY_JSON={"noHistoryIntervalHours":24,"newUploadCooldownHours":2,"failureRetryMinutes":[5,15,30,60],"rules":[{"id":"return_after_3_months","label":"Returned after 3 months","minUploadAgeDays":90,"minRefreshIntervalHours":6},{"id":"return_after_1_year","label":"Returned after 1 year","minUploadAgeDays":365,"minRefreshIntervalHours":24},{"id":"return_after_2_years","label":"Returned after 2 years","minUploadAgeDays":730,"minRefreshIntervalHours":72}]}
```

Rules may be listed in any order; the matching rule with the longest refresh interval wins, then the oldest upload threshold breaks ties. Invalid or duplicate rule IDs fail startup rather than silently changing scheduling.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `YOUTUBE_API_KEY` | YouTube Data API key. Optional for RSS-only operation and canonical `/channel/UC...` additions; required for handle/video URL resolution and any `api` refresh mode. Sent in the `x-goog-api-key` header rather than the URL. | — |
| `PORT` | Server port | `3000` |
| `DATA_DIR` | Path to data directory | `./data` |
| `MAX_VIDEOS` | Per-channel retention cap in the DB | `50` |
| `REFRESH_MODE` | Default refresh mode (`rss` or `api`) — used when the per-path override isn't set | `rss` |
| `REFRESH_MODE_MANUAL` | Override for web-button refreshes | falls back to `REFRESH_MODE` |
| `SMART_REFRESH_POLICY_JSON` | Validated policy containing `newUploadCooldownHours`, `noHistoryIntervalHours`, bounded `failureRetryMinutes`, and extensible inactivity `rules` | new upload → 2 h; 90 d → 6 h; 365 d → 24 h; no history → 24 h; failures → 5/15/30/60 m |
| `YOUTUBE_QUOTA_GENERAL_LIMIT` | General daily-unit budget enforced and displayed by WadsTube | `10000` |
| `YOUTUBE_QUOTA_SEARCH_LIMIT` | Separate daily `search.list` call budget | `100` |
| `ALLOWED_ORIGINS` | Optional comma-separated origins for a separate frontend; enables selective CORS responses and preflight while unlisted cross-origin mutations remain blocked | — |
| `PUBLIC_ORIGIN` | Canonical external app origin (for example `https://tube.example.com`) when a reverse proxy rewrites the internal Host header | — |
| `TRUST_PROXY` | Express trust-proxy setting for deployments behind a known reverse proxy (for example `1`) | — |
| `TZ` | Container timezone (affects when nightly backups fire) | `America/Los_Angeles` |
| `TUBE_UID_GID` | Optional container runtime UID:GID. Before setting, make the bind-mounted `./data` writable by that identity. | `0:0` (existing compatible behavior) |

WadsTube applies same-origin checks to browser mutations, conservative in-memory
rate limits to quota-sensitive endpoints, and baseline response security headers.
It does not include user authentication. Put it behind an authenticated HTTPS
reverse proxy before exposing it to the public internet; configure
`ALLOWED_ORIGINS` only for intentionally separate frontends.

## Testing

```bash
cd server
npm test

cd ../client
npm test
npm run build
```

The server suite uses temporary data directories and covers sequential schema migration,
Shorts retention/counting, stable folder normalization, PocketTube IDs,
refresh-coordinated restore/delete behavior, paired recovery snapshots, CORS,
folder-ID compatibility headers, reader/favorite/health APIs, retry failures and
rate limits, smart-policy boundaries, return highlighting without initial
backfill, quota-day/bucket/failure accounting, FTS search, full-export integrity,
shutdown draining, and YouTube error handling. The client suite covers channel-cache
race invalidation, refresh-driven badge reloads, and active-filter cleanup.

## Project Structure

```
wadstube/
├── server/
│   ├── index.js              # Express entry point, backup/restore/resolve-url routes
│   ├── lib/
│   │   ├── data.js           # Load/save tube.json, folder/channel CRUD, atomic writes
│   │   ├── db.js             # SQLite wrapper (schema, upserts, prune, VACUUM INTO)
│   │   ├── rss.js            # Atom feed fetch + parse with retry/backoff
│   │   ├── youtube.js        # Data API client (resolveUrl, fetchChannelViaApi, checkIsShort)
│   │   ├── refresh.js        # Per-channel refresh orchestrator (RSS/API dispatch)
│   │   ├── refresh-policy.js # Validated declarative due/highlight rules
│   │   ├── quota.js          # Pacific daily ledger and per-run network metrics
│   │   ├── backup.js         # Nightly backups with GFS retention
│   │   ├── full-backup.js    # Checksummed subscription + SQLite export bundle
│   │   ├── shutdown.js       # Bounded refresh drain helpers
│   │   ├── restore.js        # Validated, refresh-coordinated restore + recovery snapshot
│   │   ├── security.js       # Headers, selective CORS/origin policy, rate limits
│   │   ├── migrate.js        # PocketTube → tube.json one-time migration
│   │   └── migrate-cache.js  # cache.json → SQLite one-time migration
│   └── routes/
│       ├── folders.js        # Folder CRUD + channel management endpoints
│       ├── videos.js         # Video listing from the DB
│       ├── channels.js       # Favorites, health, single-channel retry
│       ├── status.js         # Quota and refresh-run status
│       └── refresh.js        # Streaming NDJSON refresh endpoints
├── client/
│   ├── index.html            # SPA entry point (title, favicon)
│   ├── src/
│   │   ├── App.svelte        # Root component
│   │   ├── app.css           # Global styles (theme, fonts)
│   │   ├── stores/feed.js    # Svelte stores + NDJSON stream reader
│   │   └── lib/
│   │       ├── Header.svelte           # Search, refresh, gear menu
│   │       ├── Sidebar.svelte          # Sidebar shell and top-level views
│   │       ├── FolderNode.svelte       # Recursive folder/channel tree + actions
│   │       ├── VideoGrid.svelte        # Responsive video card grid
│   │       ├── VideoCard.svelte        # Single video card
│   │       ├── FolderChannels.svelte   # Channel list modal
│   │       ├── ChannelHealth.svelte    # Health, stale/error filters, retry
│   │       ├── RefreshProgress.svelte  # Live multi-lane refresh overlay
│   │       └── Toast.svelte            # Notification toasts
│   └── vite.config.js        # Vite config with dev proxy
├── data/                     # Mounted volume in Docker
│   ├── tube.json             # Folder/channel data
│   ├── wadstube.db           # SQLite DB (channels, videos)
│   └── backups/              # Nightly backups (GFS retention)
├── Dockerfile                # Multi-stage build (Svelte + Node Alpine)
├── .dockerignore             # Keep host node_modules out of the image
├── docker-compose.yml        # Docker config with health check
└── .env                      # Optional API key and settings (not committed)
```
