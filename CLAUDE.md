# Tube - YouTube Subscription Feed Generator

## Project overview

Python script that reads a PocketTube browser extension JSON export and fetches recent videos from the YouTube Data API v3, outputting a self-contained HTML feed page.

## Architecture

- `fetch_videos.py` — single-file script containing all logic: API fetching, folder tree building, HTML template, caching
- PocketTube JSON has folder names as keys mapping to arrays of YouTube channel IDs. Subfolder hierarchy is in `ysc_settings.sub_groups`
- Uses `playlistItems.list` API (1 unit/call) to get recent uploads per channel. Channel upload playlist ID is derived by replacing `UC` prefix with `UU`
- HTML output is a single file with embedded CSS/JS: dark theme, left sidebar drawer for folders, video card grid, client-side filtering

## Key files

- `fetch_videos.py` — main script
- `.env` — YouTube Data API key (YOUTUBE_API_KEY)
- `cache.json` — cached API results to avoid re-fetching
- `feed.html` — generated output
- `requirements.txt` — Python deps: aiohttp, feedparser, jinja2, python-dotenv, google-api-python-client
- `com.tube.fetch-videos.plist` — macOS launchd plist (not yet installed)

## Commands

```bash
# Activate venv
source .venv/bin/activate

# Fetch fresh from API
python3 fetch_videos.py --refresh

# Regenerate HTML from cache (no API calls)
python3 fetch_videos.py

# Custom: 10 videos per channel, custom output
python3 fetch_videos.py --refresh -n 10 -o my_feed.html
```

## Constraints

- YouTube Data API free quota: 10,000 units/day. Each run uses ~2,400 units (~2,400 channels). Max ~4 fresh runs/day
- Do NOT add features requiring extra API endpoints (view counts via `videos.list`, duration via `contentDetails`) unless explicitly asked — these double quota usage
- Always use `--refresh` flag awareness: without it, the script uses cached data. When iterating on UI/HTML, never call `--refresh` unnecessarily
- Some PocketTube entries are full URLs instead of channel IDs — these fail silently (known issue, not yet fixed)
- Quota resets at midnight Pacific time

## Code style

- Single-file architecture — keep everything in `fetch_videos.py`
- HTML template is embedded in the Python file as a Jinja2 Template string
- Async fetching with aiohttp and semaphore-based concurrency (default 20)
