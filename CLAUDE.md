# WadsTube

## Project overview

Self-hosted YouTube subscription manager and video feed viewer. Node.js/Express backend + Svelte frontend, runs in Docker. Manages folders/channels in `tube.json`, stores videos in a SQLite DB (`wadstube.db`), and refreshes via YouTube RSS feeds (no API quota cost on refresh). The YouTube Data API is used only for URL/handle resolution when adding channels.

## Architecture

- **Backend:** Node.js + Express (`server/`)
- **Frontend:** Svelte built with Vite (`client/`), served as static files by Express
- **Data:** In the `data/` volume — `tube.json` (folders/channels) and `wadstube.db` (SQLite: channels + videos)
- **Refresh:** RSS feeds (`/feeds/videos.xml?channel_id=UC...`) with `If-None-Match`/`If-Modified-Since`; background poller + manual refresh button both go through the same path
- **Docker:** Multi-stage build (Alpine), health check, 512MB mem limit, `TZ=America/Los_Angeles` baked in so nightly backups and local-day math line up

## Key files

- `server/index.js` — Express entry point, wires db + poller + backups, backup/restore/resolve-url routes
- `server/lib/data.js` — Load/save tube.json, folder/channel CRUD, atomic writes
- `server/lib/db.js` — SQLite wrapper: schema, upserts, per-channel prune, VACUUM INTO backup
- `server/lib/rss.js` — Atom feed fetch with conditional headers, XML parsing (`fast-xml-parser`)
- `server/lib/refresh.js` — Orchestration: RSS → classify new videos as shorts → upsert → prune
- `server/lib/poller.js` — Background RSS poller, opt-out via `REFRESH_INTERVAL_MINUTES=0`
- `server/lib/youtube.js` — YT Data API client for URL resolution + `checkIsShort` HEAD helper
- `server/lib/migrate.js` — One-time PocketTube → tube.json migration
- `server/lib/migrate-cache.js` — One-time cache.json → SQLite migration (fires if DB is empty and cache.json exists)
- `server/lib/backup.js` — Nightly backups of tube.json + `VACUUM INTO` snapshot of wadstube.db, GFS retention (4 daily + 4 weekly + 4 monthly); fires at 1am container-local time
- `server/routes/folders.js` — Folder/channel CRUD (create, rename, delete folders; add, remove, rename, move channels), input validation
- `server/routes/videos.js` — Video listing from DB (no network)
- `server/routes/refresh.js` — RSS refresh (all or per-folder); shares a refresh lock with the poller
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

- `YOUTUBE_API_KEY` — required, used for URL/handle resolution at channel-add time, and for refresh when `REFRESH_MODE=api`
- `MAX_VIDEOS` — retention cap per channel in the DB (default 50)
- `REFRESH_INTERVAL_MINUTES` — background poller cadence; `0` disables (default 30)
- `REFRESH_MODE` — `rss` (default, free, subject to YouTube's per-IP rate limiter) or `api` (1 quota unit per channel per refresh; ~4 full passes/day at 2.4k channels on the 10k/day free quota)
- `DATA_DIR`, `PORT`, `TZ` — as before

## Constraints

- RSS refreshes are free (no YouTube API quota) — each channel is one small HTTP GET, often a 304
- RSS returns ~15 newest videos per channel; the 50-video retention fills in over time via successive polls
- Shorts detection is a free HEAD to `youtube.com/shorts/{id}` and runs only for videos we haven't seen before (classification is cached per video in the DB)
- YouTube Data API is still used at channel-add time for `/@handle` and `/watch?v=...` URLs; each call is 1 unit
- Do NOT add features requiring extra paid API endpoints (view counts, duration) unless explicitly asked
- Manual and background refresh share a lock so they never run concurrently

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

`wadstube.db` — SQLite (WAL mode), two tables:
- `channels(id PK, title, last_checked_at, last_etag, last_modified)`
- `videos(video_id PK, channel_id, title, description, thumbnail, published, is_short, created_at)` — indexed on `(channel_id, published DESC)` and `(published DESC)`. Shorts are stored but filtered out on read.
