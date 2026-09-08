# WadsTube channel saver

A personal, unpacked Chrome extension for `https://wadstube.runty.org`.
No Chrome Web Store account, publication, build step or extension dependencies
are needed. This is a desktop Chrome extension, not an iPhone/Safari extension.

## Install

1. Keep this `extension/` folder somewhere permanent on the computer running
   Chrome. If using another computer, copy the entire folder including `icons/`.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**,
   and select this folder (the one containing `manifest.json`).
3. Pin **WadsTube — Save channel** using Chrome's puzzle-piece menu.
4. Connect to Tailscale and open a YouTube video. Click the extension, search your
   groups, select one, and choose **Add to …**. Nested groups show their parent
   path; groups with direct membership show **Added**.

Reload the extension from `chrome://extensions` after updating its files.
YouTube's live DOM varies: if details are unavailable, a save can resolve the
current video URL through the app's existing YouTube API integration. This needs
the server API key and consumes one lookup; a canonical channel ID does not.
Adding a channel does **not** trigger a video refresh. Use the app's normal
refresh action when you want new videos.

## Server prerequisite

The companion server changes must be deployed: exact Chrome-extension CORS
allowlisting, `GET /api/folders?channelId=…` direct-membership flags, and a bounded
channel-name hint on the existing add endpoint. Set this additional allowed origin:

```dotenv
ALLOWED_ORIGINS=chrome-extension://mhjagbgfpcefdmidgmbmfkfoabephnbm
```

Preserve existing comma-separated allowed origins, if any. Do not allow all
extension IDs or disable the origin policy. The committed manifest public `key`
keeps this extension ID stable across computers and directory paths; it is not a
secret or an authentication credential. Keep the application's Tailscale/LAN
ingress boundary. This remains a trusted single-user app, not a public service.

On Shrimp, prepare the app's native package and environment in `nixstuff`, then
follow `DEPLOYMENT.md` for backup and approved activation. Never restart Shrimp
services merely to install the extension. This feature has no database migration.

## Privacy and behavior

- `activeTab` and `scripting`: inspect only the current YouTube video tab when
  you invoke the extension. No always-running content script or browsing history
  permission. It supports `/watch` and `/shorts/` contexts, not arbitrary pages.
- Host permission: only `https://wadstube.runty.org/*`. Network requests use the
  extension worker, not YouTube's origin. No arbitrary fetch/message bridge.
- `storage`: remember only the last destination folder on this computer. No
  saved video history, telemetry, analytics, synced settings or API keys.
- The optional channel avatar loads directly from YouTube's two approved avatar
  hosts. All scripts, styles, brand assets and fonts are local/system resources.
- You review the channel before saving. The tab URL is checked again on save.
  Old YouTube player data with a different video ID is not accepted.
- Saves run in the worker so closing the popup does not cancel an in-flight
  request. Network loss can leave confirmation uncertain; reopening reloads
  memberships, and repeated additions to the same group are idempotent.
- Themes follow the system. Native radio controls support keyboard navigation;
  `/` focuses group search, and reduced motion is respected.

## Code and tests

`popup.*` owns the compact UI; `detect.mjs` is the self-contained, click-time
YouTube reader; `background.mjs` exposes only list/save messages to our popup;
`library.mjs` holds URL validation, folder paths and bounded network requests.

From the repository root:

```bash
npm test --prefix server
npm test --prefix client
npm run build --prefix client
npm run test:browser --prefix client
```

Set `BROWSER_EXECUTABLE` to a Playwright-compatible Chromium binary if needed.
`client/browser/extension.test.mjs` loads a disposable copy of the real extension
with a temporary synthetic-YouTube host grant because automation opens the popup
in an inactive tab rather than clicking Chrome's toolbar. It tests real script
execution, service-worker messaging and the actual server routes with temporary
data. DNS is pinned to loopback and every network request is intercepted: no
production mutation, YouTube request or video refresh occurs. Manual toolbar
invocation and real YouTube layout variants still need operator acceptance.

References: Chrome's [unpacked installation guide](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world),
[activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab),
[network request model](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests),
and [stable extension key](https://developer.chrome.com/docs/extensions/reference/manifest/key).
