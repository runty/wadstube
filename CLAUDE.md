# WadsTube

## Project overview

Self-hosted YouTube subscription manager and video feed viewer. Node.js/Express backend + Svelte frontend, runs in Docker. Manages folders/channels in `tube.json`, caches video data in `cache.json`, fetches from YouTube Data API v3 on demand only.

## Architecture

- **Backend:** Node.js + Express (`server/`)
- **Frontend:** Svelte built with Vite (`client/`), served as static files by Express
- **Data:** Two JSON files in `data/` volume — `tube.json` (folders/channels) and `cache.json` (cached videos)
- **Docker:** Multi-stage build (Alpine), health check, 512MB mem limit, `TZ=America/Los_Angeles` baked in via Dockerfile so the nightly backup scheduler fires at 1am Pacific

## Key files

- `server/index.js` — Express entry point, backup/restore/resolve-url routes
- `server/lib/data.js` — Load/save tube.json, folder/channel CRUD, atomic writes
- `server/lib/cache.js` — Video cache, per-channel granularity, atomic writes
- `server/lib/youtube.js` — YouTube API client, shorts detection (free HEAD requests), URL resolution, 10s fetch timeouts
- `server/lib/migrate.js` — One-time PocketTube → tube.json migration
- `server/lib/backup.js` — Nightly backups of tube.json + cache.json with GFS retention (4 daily + 4 weekly + 4 monthly); scheduler fires at 1am container-local time
- `server/routes/folders.js` — Folder/channel CRUD (create, rename, delete folders; add, remove, rename, move channels), input validation
- `server/routes/videos.js` — Video listing from cache (no API calls)
- `server/routes/refresh.js` — YouTube API refresh (all or per-folder)
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

## Constraints

- YouTube Data API free quota: 10,000 units/day
- Each channel refresh = 1 unit. ~2,400 channels = ~2,400 units per full refresh
- Shorts detection uses free HEAD requests to youtube.com/shorts/{id}, no API cost
- Do NOT add features requiring extra API endpoints (view counts, duration) unless explicitly asked
- Per-folder refresh only fetches that folder's channels, not all
- No automatic refresh — only when user clicks Refresh button
- Quota resets at midnight Pacific time

## Theming

- Modern minimal theme with orange accent (`#ea580c` light, `#f97316` dark)
- Respects system `prefers-color-scheme` for automatic light/dark switching
- Uses Comic Sans MS / Comic Neue (Google Fonts fallback for iOS)
- All accent colors use CSS `var(--accent)` — change in `app.css` to re-theme

## Data format

`tube.json` — folders as ordered array, each with id, name, channels (id/name/addedAt), children:
```json
{ "version": 1, "folders": [{ "id": "...", "name": "...", "channels": [...], "children": [...] }] }
```

`cache.json` — keyed by channel ID, each with fetched_at and videos array.
