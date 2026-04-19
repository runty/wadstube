# WadsTube

A self-hosted YouTube subscription manager and video feed viewer. Organizes your YouTube subscriptions into folders, pulls new videos via channel RSS feeds (or the YouTube Data API — your choice), stores them in SQLite, and presents them in a clean, themed web interface. Runs in Docker.

## Why

YouTube's native subscription feed is a single unsorted stream. PocketTube (browser extension) adds folder organization but only works in the browser. WadsTube gives you a standalone app with full control: folder management, per-folder refresh, a background poller, search, drag-and-drop channel adding, and no shorts.

## Features

- **Folder-organized feed** — sidebar with expandable folder/subfolder hierarchy
- **Expandable channels in sidebar** — click the chevron next to a folder to see channels inline; click a channel to filter videos to just that channel
- **Channel management** — right-click/long-press a channel in the sidebar to rename, move to another folder, or delete it. A rename sticks: the background poller won't revert your chosen name to YouTube's.
- **RSS-based refresh** — free, no API quota; also switchable to the YouTube Data API mode for refreshes when RSS is rate-limited. Manual clicks and the background poller never run at the same time.
- **Separate refresh modes for manual and background** — e.g. API for your manual clicks (fast, predictable) and RSS for the background poller (free, slower)
- **Background polling** — configurable cadence (default 30 min); set `0` to disable
- **Live progress UI** — a per-channel overlay shows each channel as it's fetched, with a `done/total` counter, running "new videos" tally, and error count
- **No YouTube Shorts** — shorts are automatically detected (via free HEAD request) and stored but filtered out of the feed; classification runs once per video, not on every refresh
- **Search** — filter videos by title, channel name, or description
- **Drag-and-drop** — drag any YouTube URL (video, channel, @handle, shorts, live) onto a folder to add that channel
- **Paste to add** — paste URLs in the channel list panel (works on mobile)
- **URL resolution** — video URLs are auto-resolved to the channel via YouTube API (1 unit)
- **Backup/restore** — download your folder/channel data as JSON, restore from a backup (up to 5 MB; tree is validated and depth-capped on upload); nightly backups include a consistent SQLite snapshot taken after any in-flight refresh finishes
- **Right-click to copy** — right-click any video card to copy its link
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
│                   ┌────────────▼──────────────┐  │
│                   │   Background poller        │  │
│                   │   (every N minutes)        │  │
│                   └────────────┬──────────────┘  │
└────────────────────────────────│─────────────────┘
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
3. **Refresh** — frontend POSTs to `/api/refresh/:folder`; the server streams NDJSON events back (init, start/done per channel, final summary). Each channel is fetched via RSS or the YouTube Data API depending on `REFRESH_MODE_MANUAL`. New videos are inserted, existing ones have title/description/thumbnail refreshed, and each channel is pruned to the last `MAX_VIDEOS` entries.
4. **Background poll** — every `REFRESH_INTERVAL_MINUTES` the server runs the same refresh pipeline across every channel in `tube.json`, using `REFRESH_MODE_POLLER`. Shares a lock with manual refresh so they never collide.
5. **Add channel** — frontend POSTs a URL to `/api/folders/:name/channels`. Server resolves the URL to a channel ID (via YouTube Data API if needed), adds it to `tube.json`.

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
        { "id": "UCzZN...", "name": "My Favorite Chef", "addedAt": "...", "userRenamed": true }
      ],
      "children": [
        { "id": "baking", "name": "Baking", "channels": [...], "children": [] }
      ]
    }
  ]
}
```

`userRenamed: true` is set automatically when you rename a channel from the sidebar; it tells the background poller to leave that name alone. The tree is normalized on every load and on restore — missing `channels`/`children` arrays are coerced to `[]`, folder nesting is capped at depth 4, channel IDs must match `^UC[A-Za-z0-9_-]{22}$`, and prototype-pollution keys are stripped.

**`wadstube.db`** — SQLite, WAL mode. Two tables:
- `channels(id PK, title, last_checked_at, last_etag, last_modified)` — RSS-conditional-request hints + the last-known title
- `videos(video_id PK, channel_id, title, description, thumbnail, published, is_short, created_at)` — indexed on `(channel_id, published DESC)` and `(published DESC)`. Shorts are stored but filtered out on read.

If `cache.json` exists on first boot (from a pre-RSS install), it's imported into the DB once and renamed `cache.json.migrated`.

## How the Code Works

### Server

#### `server/index.js` — Entry Point
Loads `tube.json` (or auto-migrates from PocketTube format), opens the SQLite DB, runs the one-time cache.json migration if needed, and creates the shared `appState` used by every route handler. Mounts API routes, starts the background poller, schedules nightly backups, and serves the built Svelte SPA.

#### `server/lib/data.js` — Data Layer
Manages `tube.json`. Load/save with atomic writes, folder/channel CRUD, recursive channel-id collection, name syncing (propagates channel titles from the DB into `tube.json`).

#### `server/lib/db.js` — SQLite Wrapper
`better-sqlite3` in WAL mode. Prepared statements for upserting channels, upserting videos (ON CONFLICT updates title/description/thumbnail only, preserving `is_short`), fetching videos by channel or globally (shorts filtered out), pruning per-channel to a retention limit, and `VACUUM INTO` for consistent backup snapshots.

#### `server/lib/rss.js` — Atom Feed Client
Fetches `https://www.youtube.com/feeds/videos.xml?channel_id=UC...`, parses with `fast-xml-parser`. Sends `If-None-Match` / `If-Modified-Since` when the DB has them (YouTube doesn't currently emit these, but the code is ready if they turn it on). Retries once with 1s backoff and once more with 3s backoff on 404/5xx, which YouTube throws under per-IP rate pressure.

#### `server/lib/youtube.js` — YouTube Data API Client
- `resolveUrl(apiKey, url)` — parses YouTube URLs in every format (video, channel, @handle, shorts, live, youtu.be) and resolves to `{ channelId, channelTitle }`. Channel URLs are free (0 units). Video URLs use `videos.list` (1 unit). `@handle` URLs use `search.list` (100 units).
- `fetchChannelViaApi(apiKey, channelId)` — `playlistItems.list` for the channel's uploads playlist (1 unit, up to 50 items). Returns the same shape as the RSS client so `refresh.js` can dispatch on mode.
- `checkIsShort(videoId)` — HEAD request to `/shorts/{id}`; 200 means it's a short.

#### `server/lib/refresh.js` — Refresh Orchestrator
`refreshChannels(db, ids, opts, onEvent)` spins up per-channel workers in a `p-limit` pool (5 concurrent in RSS mode, 20 in API mode). Each worker emits `{type:"start",...}`, fetches the feed, runs shorts HEAD checks *only for unseen video IDs*, upserts everything, prunes to `keep` per channel, updates channel meta (last-checked / ETag / Last-Modified), and emits `{type:"done", newVideos, status}`.

#### `server/lib/poller.js` — Background Poller
Runs `refreshChannels` every `REFRESH_INTERVAL_MINUTES`. Shares `appState.refreshLock` with manual refresh so they serialize. Waits 60s after boot to avoid colliding with startup work.

#### `server/lib/backup.js` — Nightly Backups
Writes `tube.json` and a `VACUUM INTO wadstube.db` snapshot into `data/backups/YYYY-MM-DD/` every night at 1 am local time (container `TZ`). Grandfather-Father-Son retention (4 daily + 4 weekly + 4 monthly). Catches up on boot if the last backup is >25 h old.

#### `server/lib/migrate.js` — PocketTube Migration
One-time migration from PocketTube's JSON export to the native `tube.json` format.

#### `server/lib/migrate-cache.js` — cache.json → SQLite
One-time import of a legacy `cache.json` into SQLite on first boot with the new codebase. Renames the file afterwards so it doesn't re-run.

#### `server/routes/folders.js` — Folder & Channel API
- `GET /api/folders` — folder tree summary (names + counts)
- `POST /api/folders` — create folder (validates name: no `../`, `/`, `\`, null bytes, max 100 chars)
- `PATCH /api/folders/:name` — rename
- `DELETE /api/folders/:name` — delete
- `GET /api/folders/:name/channels` — channels alphabetically
- `POST /api/folders/:name/channels` — add channel by ID or URL (auto-resolves)
- `DELETE /api/folders/:name/channels/:channelId` — remove
- `PATCH /api/folders/:name/channels/:channelId` — rename
- `POST /api/folders/:name/channels/:channelId/move` — move to another folder

#### `server/routes/videos.js` — Video API
- `GET /api/videos?folder=X` — returns DB-cached videos for a folder (or all). Reads only, no network.

#### `server/routes/refresh.js` — Refresh API (streaming NDJSON)
- `POST /api/refresh` — refresh every channel referenced by any folder
- `POST /api/refresh/:folder` — refresh only channels in that folder

Both stream NDJSON events (Content-Type `application/x-ndjson`) with one event per line:
```
{"type":"init","total":42}
{"type":"start","channelId":"UC...","channelTitle":"Tom Scott"}
{"type":"done","channelId":"UC...","channelTitle":"Tom Scott","status":"ok","newVideos":2}
...
{"type":"summary","refreshed":40,"new_videos":57,"errors":2,"total_channels":...,"videos":[...]}
```

If a refresh (manual or poller) is already in flight, the route returns 409 immediately so the client can surface the conflict rather than stall.

### Client

#### `client/src/stores/feed.js` — State Management
Svelte writable stores for app state: `folders`, `videos`, `activeFolder`, `activeChannelId`, `refreshing`, `refreshProgress`, `error`, `sidebarOpen`, `showChannelsFor`, `toast`, `searchQuery`. `refreshFolder()` opens a POST and incrementally reads NDJSON from `resp.body`, dispatching each event into `refreshProgress`, then returns the final summary.

#### `client/src/App.svelte` — Root Component
Mounts Header, Sidebar, VideoGrid, FolderChannels (modal), Toast, and RefreshProgress. Loads folders on mount.

#### `client/src/lib/Header.svelte` — Top Bar
Hamburger toggle, title, search with clear, gear menu (backup/restore), refresh button with spinner. Fires a toast on refresh completion (`Added N new videos` or `No new videos`, plus an `(N channels errored)` suffix when some feeds failed).

#### `client/src/lib/Sidebar.svelte` — Folder & Channel Navigation
Folder tree, expandable channels inline, click filters, context menus (rename/delete/move), inline rename, drag-and-drop zones, "+ New Folder", mobile overlay.

#### `client/src/lib/VideoGrid.svelte` — Video Display
Responsive CSS grid of VideoCards. Filters by `activeChannelId` first, then `searchQuery`.

#### `client/src/lib/VideoCard.svelte` — Single Video
16:9 thumbnail, 2-line title, 2-line description, channel name (click opens channel), publish date in local tz. Click opens video, right-click copies URL.

#### `client/src/lib/FolderChannels.svelte` — Channel Management Modal
Alphabetical channel list with paste bar, drag-drop, remove button.

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

### 1. Get a YouTube Data API Key

1. [Google Cloud Console](https://console.cloud.google.com) → new project
2. **APIs & Services > Library** → **YouTube Data API v3** → **Enable**
3. **APIs & Services > Credentials** → **Create Credentials > API key**
4. Copy the key

The key is used for URL resolution at channel-add time. If you set `REFRESH_MODE=api` (or `REFRESH_MODE_MANUAL=api`), it's also used on refresh.

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
- Background polling also runs every `REFRESH_INTERVAL_MINUTES` (default 30) without the UI overlay. Manual and background never run at once — a manual click during a background tick returns 409 with a clear message.

### Managing Folders

- **Create:** "+ New Folder" at the bottom of the sidebar.
- **Rename/Delete:** right-click (or long-press) a folder.
- **View Channels:** right-click → "View Channels" opens the modal.

Deleting a folder or channel also purges the corresponding rows from `wadstube.db` so stale subscriptions don't keep appearing in the feed.

### Viewing & Filtering by Channel

- Click the chevron next to a folder to expand channels inline.
- Click a channel to filter videos to just that channel (click again to deselect).
- Right-click a channel for rename / move / delete.

### Adding Channels

- **Drag-and-drop** a YouTube URL onto a folder.
- **Paste** a URL in the channel list modal.
- Accepted: `youtube.com/watch?v=...`, `youtube.com/channel/UC...`, `youtube.com/@handle`, `youtu.be/...`, `youtube.com/shorts/...`, `youtube.com/live/...`.

### Backup & Restore

**From the UI:** ⋮ menu in the header — **Backup** downloads `tube-backup-{timestamp}.json`; **Restore** uploads one (auto-saves a pre-restore backup on the server first).

**Nightly backups:** `data/backups/YYYY-MM-DD/` gets `tube.json` + a consistent `wadstube.db` snapshot (via `VACUUM INTO`) every night at 1 am local time. Catches up on startup if a backup is overdue. GFS retention (4 daily + 4 weekly + 4 monthly).

To restore a nightly backup:

```bash
cd data
cp backups/2026-04-10/tube.json .
cp backups/2026-04-10/wadstube.db .
docker compose restart
```

## Refresh Modes & Quota

Two refresh modes, selectable per-path (manual vs. background poller):

| Mode | Cost | Rate limit | Notes |
|------|------|------------|-------|
| `rss` | free | YouTube throttles per-IP; can 404/5xx under bursts | 15-entry feeds; no `publishedAfter`; refresh pulls full feed every time, dedup by `video_id` |
| `api` | 1 unit per channel per refresh | none that you'll hit organically | 50 items per call; 1 unit regardless of `maxResults` |

Channel-add URL resolution always uses the Data API:

| Action | Cost |
|--------|------|
| Add channel via channel URL (`/channel/UC...`) | 0 units |
| Add channel via video URL (`/watch?v=...`) | 1 unit |
| Add channel via @handle (`/@name`) | 100 units |
| Shorts classification | 0 units (free HEAD request; runs only for previously-unseen videos) |

YouTube Data API gives 10,000 free units per day, resetting at midnight Pacific. At ~2,400 channels:
- **`rss`** everywhere: 0 quota used for refresh.
- **`api`** for refresh: ~2,400 units per full pass → ~4 full passes/day.

A common pairing: `REFRESH_MODE_MANUAL=api` (predictable, fast — your clicks don't get rate-limited) + `REFRESH_MODE_POLLER=rss` (free — background work is the steady state).

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `YOUTUBE_API_KEY` | YouTube Data API key (required — URL resolution always needs it; refresh needs it when any mode is `api`) | — |
| `PORT` | Server port | `3000` |
| `DATA_DIR` | Path to data directory | `./data` |
| `MAX_VIDEOS` | Per-channel retention cap in the DB | `50` |
| `REFRESH_INTERVAL_MINUTES` | Background poller cadence (`0` disables) | `30` |
| `REFRESH_MODE` | Default refresh mode (`rss` or `api`) — used when the per-path override isn't set | `rss` |
| `REFRESH_MODE_MANUAL` | Override for web-button refreshes | falls back to `REFRESH_MODE` |
| `REFRESH_MODE_POLLER` | Override for background poller refreshes | falls back to `REFRESH_MODE` |
| `TZ` | Container timezone (affects when nightly backups fire) | `America/Los_Angeles` |

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
│   │   ├── poller.js         # Background refresh timer
│   │   ├── backup.js         # Nightly backups with GFS retention
│   │   ├── migrate.js        # PocketTube → tube.json one-time migration
│   │   └── migrate-cache.js  # cache.json → SQLite one-time migration
│   └── routes/
│       ├── folders.js        # Folder CRUD + channel management endpoints
│       ├── videos.js         # Video listing from the DB
│       └── refresh.js        # Streaming NDJSON refresh endpoints
├── client/
│   ├── index.html            # SPA entry point (title, favicon)
│   ├── src/
│   │   ├── App.svelte        # Root component
│   │   ├── app.css           # Global styles (theme, fonts)
│   │   ├── stores/feed.js    # Svelte stores + NDJSON stream reader
│   │   └── lib/
│   │       ├── Header.svelte           # Search, refresh, gear menu
│   │       ├── Sidebar.svelte          # Folder tree, drag-drop, context menu
│   │       ├── VideoGrid.svelte        # Responsive video card grid
│   │       ├── VideoCard.svelte        # Single video card
│   │       ├── FolderChannels.svelte   # Channel list modal
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
└── .env                      # API key (not committed)
```
