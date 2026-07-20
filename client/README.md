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
```

The client tests cover store race handling, refresh/report reload behavior,
subscription-import cleanup, retry error handling, scoped Returns behavior,
operations APIs, modal focus, and safe channel-cache keys. The production build
is emitted to `dist/` and copied into the final Docker image.

See the repository-level [README](../README.md) for API, refresh-policy, quota,
backup, and data-model documentation, and [DEPLOYMENT.md](../DEPLOYMENT.md) for
release paths.
