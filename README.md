# WadsTube

A self-hosted YouTube subscription manager and video feed viewer. Organizes your YouTube subscriptions into folders, fetches recent videos on demand, and presents them in a clean, dark-themed web interface. Runs in Docker.

## Why

YouTube's native subscription feed is a single unsorted stream. PocketTube (browser extension) adds folder organization but only works in the browser. WadsTube gives you a standalone app with full control: folder management, per-folder refresh, search, drag-and-drop channel adding, and no shorts.

## Features

- **Folder-organized feed** — sidebar with expandable folder/subfolder hierarchy
- **Expandable channels in sidebar** — click the chevron next to a folder to see channels inline; click a channel to filter videos to just that channel
- **Channel management** — right-click/long-press a channel in the sidebar to rename, move to another folder, or delete it
- **On-demand refresh** — no automatic API calls; click Refresh to fetch new videos for the current folder only
- **No YouTube Shorts** — shorts are automatically detected and filtered out during refresh (via free HEAD request, no API quota cost)
- **Search** — filter videos by title, channel name, or description
- **Drag-and-drop** — drag any YouTube URL (video, channel, @handle, shorts, live) onto a folder to add that channel
- **Paste to add** — paste URLs in the channel list panel (works on mobile)
- **URL resolution** — video URLs are auto-resolved to the channel via YouTube API (1 unit)
- **Backup/restore** — download your folder/channel data as JSON, restore from a backup
- **Right-click to copy** — right-click any video card to copy its link
- **Mobile-friendly** — long-press for context menus, iOS home screen icon, responsive layout
- **System light/dark mode** — auto-switches with OS theme
- **Local timezone** — video publish times displayed in your browser's timezone
- **PocketTube migration** — auto-imports from PocketTube JSON export on first run

## Architecture

```
┌─────────────────────────────────────────────┐
│                  Docker                      │
│                                              │
│  ┌──────────┐     ┌──────────────────────┐  │
│  │  Svelte  │────▶│    Express Server     │  │
│  │   SPA    │     │                       │  │
│  │ (static) │◀────│  /api/folders         │  │
│  └──────────┘     │  /api/videos          │  │
│                   │  /api/refresh          │  │
│                   │  /api/backup           │  │
│                   │  /api/restore          │  │
│                   │  /api/resolve-url      │  │
│                   └──────────┬────────────┘  │
│                              │               │
│                   ┌──────────▼────────────┐  │
│                   │    /app/data/          │  │
│                   │  tube.json (folders)   │  │
│                   │  cache.json (videos)   │  │
│                   └───────────────────────┘  │
│                              │               │
└──────────────────────────────│───────────────┘
                               │
                    ┌──────────▼────────────┐
                    │  YouTube Data API v3   │
                    │  (on refresh only)     │
                    └───────────────────────┘
```

### Stack

- **Backend:** Node.js + Express
- **Frontend:** Svelte (built with Vite)
- **Deployment:** Docker (multi-stage build, Alpine Linux)
- **Data:** JSON files on a mounted volume (no database)

### Data Flow

1. **Page load** — frontend fetches `/api/folders` (folder tree) and shows the sidebar. No videos are loaded until you click a folder.
2. **Select folder** — frontend fetches `/api/videos?folder=X`, which reads from `cache.json` (no YouTube API call).
3. **Refresh** — frontend POSTs to `/api/refresh/:folder`. Server fetches `playlistItems.list` for each channel in that folder (1 API unit each), runs shorts detection via HEAD requests, filters out shorts, updates `cache.json`, and returns the video list.
4. **Add channel** — frontend POSTs a URL to `/api/folders/:name/channels`. Server resolves the URL to a channel ID (via YouTube API if needed), adds it to `tube.json`.

### Data Storage

Two JSON files in `data/`, both using atomic writes (write to `.tmp`, then rename):

**`tube.json`** — your subscription data (folders + channels):
```json
{
  "version": 1,
  "folders": [
    {
      "id": "cooking",
      "name": "Cooking",
      "channels": [
        { "id": "UCxAS...", "name": "America's Test Kitchen", "addedAt": "2026-04-15T..." }
      ],
      "children": [
        { "id": "baking", "name": "Baking", "channels": [...], "children": [] }
      ]
    }
  ]
}
```

**`cache.json`** — cached video data, keyed by channel ID:
```json
{
  "channels": {
    "UCxAS...": {
      "fetched_at": "2026-04-15T...",
      "videos": [
        { "video_id": "abc123", "title": "...", "channel": "...", "published": "..." }
      ]
    }
  }
}
```

Per-channel granularity means refreshing one folder only updates those channels' cache entries, not the entire cache.

## How the Code Works

### Server

#### `server/index.js` — Entry Point
Loads `tube.json` (or auto-migrates from PocketTube format), initializes the cache, creates shared `appState` object passed to all route handlers. Mounts API routes and serves the built Svelte SPA as static files. Also handles the `/api/backup`, `/api/restore`, and `/api/resolve-url` endpoints directly.

#### `server/lib/data.js` — Data Layer
Manages `tube.json`. Key functions:
- `loadData(dataDir)` — reads `tube.json` or triggers migration if only PocketTube JSON exists. If `tube.json` is corrupt, renames it and re-migrates.
- `saveData(dataDir, data)` — atomic write (`.tmp` + rename)
- `findFolder(folders, name)` — searches the folder tree by name or id
- `getChannelsForFolder(data, name)` — returns all channel IDs for a folder (including subfolder channels recursively)
- `createFolder/renameFolder/deleteFolder` — CRUD operations that modify the in-memory data and sort alphabetically
- `addChannel/removeChannel` — add/remove channels from a folder
- `getChannelList(data, name)` — returns channels sorted alphabetically by name

#### `server/lib/cache.js` — Video Cache
Manages `cache.json`. Stores video data keyed by channel ID. Provides:
- `updateChannels(channelVideos)` — merges new video data and saves atomically
- `getVideosForChannels(channelIds)` — collects videos for a set of channels, deduplicates, sorts newest-first
- `getAllVideos()` — same but for all cached channels

#### `server/lib/youtube.js` — YouTube API Client
Handles all YouTube API communication:
- `fetchPlaylistItems(apiKey, channelId, maxVideos)` — fetches recent uploads via `playlistItems.list`. Derives the uploads playlist ID by replacing `UC` prefix with `UU`. After fetching, runs shorts detection on each video via `checkIsShort()` (HEAD request to `youtube.com/shorts/{id}` — returns 200 for shorts, redirect for regular videos). Filters out shorts before returning.
- `fetchChannels(apiKey, channelIds, maxVideos)` — orchestrates parallel fetching with `p-limit` (20 concurrent requests). Returns a map of channelId → video data.
- `resolveUrl(apiKey, url)` — parses YouTube URLs of all formats (video, channel, @handle, shorts, live, youtu.be) and resolves to `{ channelId, channelTitle }`. Channel URLs are parsed directly (0 API units). Video URLs use `videos.list` (1 unit). @handle URLs use `search.list` (100 units).
- `fetchWithTimeout(url, opts)` — wrapper around `fetch()` with 10-second AbortController timeout.

#### `server/lib/migrate.js` — PocketTube Migration
One-time migration from PocketTube's format (`folder_name → [channel_id_strings]`) to the native `tube.json` format. Reads `cache.json` to enrich channel IDs with display names. Builds the folder tree from PocketTube's `ysc_settings.sub_groups` hierarchy.

#### `server/routes/folders.js` — Folder & Channel API
- `GET /api/folders` — returns folder tree summary (names + channel counts)
- `POST /api/folders` — create folder (validates name: no `../`, `/`, `\`, null bytes, max 100 chars)
- `PATCH /api/folders/:name` — rename folder
- `DELETE /api/folders/:name` — delete folder (and its children if parent)
- `GET /api/folders/:name/channels` — list channels alphabetically
- `POST /api/folders/:name/channels` — add channel by ID or URL (auto-resolves)
- `DELETE /api/folders/:name/channels/:channelId` — remove channel
- `PATCH /api/folders/:name/channels/:channelId` — rename channel
- `POST /api/folders/:name/channels/:channelId/move` — move channel to another folder

#### `server/routes/videos.js` — Video API
- `GET /api/videos?folder=X` — returns cached videos for a folder (or all). Reads from cache only, no API call.

#### `server/routes/refresh.js` — Refresh API
- `POST /api/refresh` — refresh all channels
- `POST /api/refresh/:folder` — refresh only channels in that folder. Collects channel IDs via `getChannelsForFolder()`, deduplicates, fetches from YouTube API, updates cache.

### Client

#### `client/src/stores/feed.js` — State Management
Svelte writable stores for app state: `folders`, `videos`, `activeFolder`, `activeChannelId`, `refreshing`, `error`, `sidebarOpen`, `showChannelsFor`, `toast`, `searchQuery`. Also exports async functions that call the API and update stores: `loadFolders()`, `loadVideos()`, `refreshFolder()`, `createFolderApi()`, `renameFolderApi()`, `deleteFolderApi()`, `addChannelToFolder()`, `removeChannelFromFolder()`, `loadChannels()`, `renameChannelApi()`, `moveChannelApi()`.

#### `client/src/App.svelte` — Root Component
Mounts Header, Sidebar, VideoGrid, FolderChannels (modal), and Toast. On mount, loads folders and opens sidebar on wide screens. No videos loaded until user clicks a folder.

#### `client/src/lib/Header.svelte` — Top Bar
Contains: hamburger menu toggle, "WadsTube" title, search input with clear button, gear menu (backup/restore), refresh button with spinner. On mobile, title hides and search expands.

#### `client/src/lib/Sidebar.svelte` — Folder & Channel Navigation
Renders folder tree from `folders` store. Features:
- **Left chevron** on each folder → expands to show its channels inline (lazily loaded and cached client-side)
- **Click folder** → loads videos, highlights active, clears channel filter
- **Click channel** → filters videos to just that channel (toggle to deselect)
- **Subfolder arrow** on parent folders → expands children
- **Right-click/long-press folder** → context menu (View Channels, Rename, Delete)
- **Right-click/long-press channel** → context menu (Rename, Move to folder, Delete)
- **Move submenu** — centered responsive picker listing all folders
- Inline rename for folders and channels
- "+ New Folder" button at bottom
- Drag-and-drop zone on each folder (highlights, resolves URL, shows toast)
- Overlay backdrop on mobile, auto-closes after selection

#### `client/src/lib/VideoGrid.svelte` — Video Display
Renders a responsive CSS grid of VideoCards. Filters by `activeChannelId` first (if set), then by `searchQuery` (matches title, channel, description). Shows "Select a folder" or "No videos match" empty states.

#### `client/src/lib/VideoCard.svelte` — Single Video
Displays thumbnail (16:9), title (2-line clamp), description (2-line clamp), channel name (clickable, opens channel page), and publish date (converted to local timezone in browser). Click opens video in new tab. Right-click copies video URL to clipboard with toast confirmation.

#### `client/src/lib/FolderChannels.svelte` — Channel Management Modal
Shows all channels in a folder, sorted alphabetically. Features:
- Paste bar at top (input + "Add" button) for adding channels via URL
- Drag-and-drop zone (entire panel highlights)
- Each channel row: clickable name (opens YouTube), channel ID, remove button
- Toast on successful add

#### `client/src/lib/Toast.svelte` — Notifications
Fixed-position toast at bottom center. Auto-dismisses after 3 seconds. Green for success, red for error.

### Docker

**Dockerfile** — multi-stage build:
1. Stage 1 (`client-build`): installs Svelte deps, runs `vite build`, produces `client/dist/`
2. Stage 2 (runtime): Alpine Node 22, installs server deps (`--omit=dev`), copies server code + built client. Includes `wget` for health check.

**docker-compose.yml**: mounts `./data` to `/app/data`, passes env vars, 512MB memory limit, health check every 30s, restart unless-stopped.

## Setup

### 1. Get a YouTube Data API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project
3. Go to **APIs & Services > Library**, search for **YouTube Data API v3**, click **Enable**
4. Go to **APIs & Services > Credentials**, click **Create Credentials > API key**
5. Copy the key

### 2. Configure

Create a `.env` file in the project root:

```
YOUTUBE_API_KEY=your_api_key_here
```

### 3. Add Your Subscriptions

**Option A: Import from PocketTube**

Export your PocketTube subscriptions (the browser extension provides a JSON export). Place the file in the `data/` directory:

```
data/youtube_subscription_manager_*.json
```

On first startup, WadsTube auto-migrates this into its native `tube.json` format, enriching channel IDs with names from any cached data.

**Option B: Start fresh**

Create `data/tube.json` manually:

```json
{
  "version": 1,
  "folders": []
}
```

Then add folders and channels through the web UI.

### 4. Deploy with Docker

```bash
docker compose up --build -d
```

The app runs at `http://localhost:3000`.

## Usage

### Viewing Videos

1. Open the app — you'll see the folder sidebar (hamburger menu on mobile)
2. Click a folder to load its cached videos
3. Click "All" to see videos from every folder
4. Use the search bar to filter by title, channel, or description

### Refreshing

- Click **Refresh** to fetch new videos from YouTube for the currently selected folder
- If viewing "All", it refreshes all channels
- If viewing a specific folder, it only refreshes that folder's channels
- YouTube Shorts are automatically filtered out

### Managing Folders

- **Create:** click "+ New Folder" at the bottom of the sidebar
- **Rename/Delete:** right-click (or long-press on mobile) a folder for the context menu
- **View Channels:** right-click a folder > "View Channels" for the full modal

### Viewing & Filtering by Channel

- **Expand channels inline:** click the chevron next to a folder to see its channels in the sidebar
- **Filter by channel:** click a channel to show only that channel's videos (click again to deselect)
- **Manage channels in sidebar:** right-click (or long-press) a channel for:
  - **Rename** — edit the channel's display name
  - **Move to folder...** — pick a destination folder from a list
  - **Delete** — remove the channel from the folder

### Adding Channels

Three ways to add a channel to a folder:

1. **Drag-and-drop** — drag a YouTube URL from your browser onto a folder in the sidebar
2. **Paste** — right-click a folder > "View Channels", paste a URL in the text box
3. **Drag onto channel panel** — drag a URL onto the open channel list panel

Supported URL formats:
- `youtube.com/watch?v=...` (video — resolves to channel)
- `youtube.com/channel/UC...` (channel — direct)
- `youtube.com/@handle` (handle — resolved via search)
- `youtu.be/...` (short video URL)
- `youtube.com/shorts/...` (shorts URL)
- `youtube.com/live/...` (live URL)

### Backup & Restore

**Manual (from the UI):** Click the ⋮ menu in the header:
- **Backup** — downloads `tube-backup-{timestamp}.json`
- **Restore** — upload a backup file to replace current data (auto-saves a pre-restore backup on the server)

**Automatic nightly backups:** The server writes a snapshot of `tube.json` + `cache.json` into `data/backups/YYYY-MM-DD/` every night at 1am local time (container `TZ`, default `America/Los_Angeles`). If the container was down and a backup would have been missed, one runs on next startup.

Retention follows a Grandfather-Father-Son schedule — up to 12 backups are kept:
- 4 most recent daily backups
- 1 backup from each of the 4 most recent ISO weeks (not already in the daily set)
- 1 backup from each of the 4 most recent months (not already in the daily or weekly sets)
- Everything older is deleted

To restore from a nightly backup, stop the container, copy the desired dated folder's `tube.json` (and optionally `cache.json`) over the live files, and start the container back up:

```bash
cd data
cp backups/2026-04-10/tube.json .
cp backups/2026-04-10/cache.json .
docker compose restart
```

## API Quota

YouTube Data API provides 10,000 free units per day:

| Action | Cost | Notes |
|--------|------|-------|
| Refresh a folder | 1 unit per channel | 60 channels = 60 units |
| Refresh all | 1 unit per channel | ~2,400 channels = ~2,400 units |
| Add channel via video URL | 1 unit | Resolves video to channel |
| Add channel via @handle | 100 units | Uses search API |
| Add channel via channel URL | 0 units | ID extracted from URL |
| Shorts detection | 0 units | Free HEAD request |

Quota resets at midnight Pacific time.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `YOUTUBE_API_KEY` | YouTube Data API key (required) | — |
| `PORT` | Server port | `3000` |
| `DATA_DIR` | Path to data directory | `./data` |
| `MAX_VIDEOS` | Max videos fetched per channel | `15` |

## Project Structure

```
wadstube/
├── server/
│   ├── index.js              # Express entry point, backup/restore/resolve-url routes
│   ├── lib/
│   │   ├── data.js           # Load/save tube.json, folder/channel CRUD, atomic writes
│   │   ├── cache.js          # Video cache (per-channel, atomic writes)
│   │   ├── youtube.js        # YouTube API client, shorts detection, URL resolution
│   │   └── migrate.js        # One-time PocketTube → tube.json migration
│   └── routes/
│       ├── folders.js        # Folder CRUD + channel management endpoints
│       ├── videos.js         # Video listing from cache
│       └── refresh.js        # YouTube API refresh (all or per-folder)
├── client/
│   ├── index.html            # SPA entry point (title, favicon)
│   ├── src/
│   │   ├── App.svelte        # Root component
│   │   ├── app.css           # Global styles (dark theme, Comic Sans)
│   │   ├── stores/feed.js    # Svelte stores + API client functions
│   │   └── lib/
│   │       ├── Header.svelte       # Search, refresh, gear menu
│   │       ├── Sidebar.svelte      # Folder tree, drag-drop, context menu
│   │       ├── VideoGrid.svelte    # Responsive video card grid
│   │       ├── VideoCard.svelte    # Single video card (click, right-click copy)
│   │       ├── FolderChannels.svelte  # Channel list modal (paste, drag-drop, remove)
│   │       └── Toast.svelte        # Notification toasts
│   └── vite.config.js        # Vite config with dev proxy
├── data/                     # Mounted volume in Docker
│   ├── tube.json             # Folder/channel data (your subscriptions)
│   └── cache.json            # Cached video data from YouTube API
├── Dockerfile                # Multi-stage build (Svelte + Node Alpine)
├── docker-compose.yml        # Docker config with health check
└── .env                      # API key (not committed)
```
