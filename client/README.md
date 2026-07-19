# WadsTube client

The WadsTube web interface is a Svelte single-page application built with Vite. Express serves the production build, while Vite proxies `/api` requests to the backend during local development.

## Development

Start the backend first from `../server`, then run:

```bash
npm install
npm run dev
```

Vite prints the local development URL. Application navigation state—folder, channel, search, reader view, favorite filter, sort, and card density—is stored in the URL so reload and browser history work normally.

## Validation

```bash
npm test
npm run build
```

The client tests cover store race handling, refresh/report reload behavior, subscription-import cleanup, retry error handling, and safe channel-cache keys. The production build is emitted to `dist/` and copied into the final Docker image.

See the repository-level `README.md` for deployment, API, refresh-policy, quota, backup, and data-model documentation.
