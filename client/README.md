# WadsTube Client

The WadsTube web interface is a Svelte single-page application built with Vite.
Express serves the production build, while Vite proxies `/api` requests to the
backend during local development.

## Responsive Behavior

- Phone layouts use a two-row header through 740 CSS pixels so landscape search
  remains usable.
- The page owns search/feed scrolling; sidebars, channel lists, health results,
  operations history, and long modal bodies have explicit bounded scroll areas.
- Shared dialogs use dynamic viewport height, and the channel manager keeps its
  add controls outside the scrolling channel list.
- Tablet layouts retain multi-column feeds when their available width permits.

## Development

Start the backend first from `../server`, then run:

```bash
npm install
npm run dev
```

Vite prints the local development URL. Application navigation state—folder,
channel, search, reader view, favorite filter, sort (including **Returns
first**), and card density—is stored in the URL so reload and browser history
work normally.

## Validation

```bash
npm test
npm run build
npm run test:browser
```

Browser tests require Playwright Chromium (`npx playwright install chromium`).
On NixOS, set `BROWSER_EXECUTABLE` to a compatible packaged Chromium executable.
Tests start a loopback preview of `dist/`, intercept every API with synthetic
data, and block external requests. No running backend/account is required.
Use `BROWSER=firefox` or `BROWSER=webkit` with that Playwright browser installed
to run another engine; those engines and physical devices have not yet been
verified in the September 8 follow-up. `SCREENSHOT_DIR` optionally saves fixtures.
The five sizes cover desktop, portrait/landscape phone, narrow phone and a small
split-window layout. CSS-pixel resizing is not a physical-device or 200% zoom test.

The client tests cover store race handling, refresh/report reload behavior,
subscription-import cleanup, retry error handling, scoped Returns behavior,
operations APIs, modal focus, and safe channel-cache keys. The production build
is emitted to `dist/` and copied into the final Docker image.

See the repository-level [README](../README.md) for API, refresh-policy, quota,
backup, and data-model documentation, and [DEPLOYMENT.md](../DEPLOYMENT.md) for
release paths.
