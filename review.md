# WadsTube review

Date: September 7, 2026. Audience: maintainer of the trusted, single-user Shrimp deployment.

Implementation update (September 7): **Fix first items 1–7 are implemented locally,
not deployed. Item 7 uses the approved 30-day live-video-cache expiry policy.**
The findings below describe the reviewed revision, not the repaired checkout.
See [README repair notes](README.md#review-repairs-unreleased) and
[Unreleased changelog](CHANGELOG.md#unreleased) for changed behavior. Existing
metadata can expire on activation; watch/star state survives. Backups/archives
and non-video data are not scrubbed, and blanket policy compliance is not claimed.
Publication dates are corrected only when items are re-observed in an explicit
refresh; no historical mass backfill was performed. Physical-phone/Safari
verification remains outstanding.

Local repair validation before expiry: 65 server tests and 34 client tests passed, plus the
production client build. Chromium/axe checked 24 combinations (1440×900,
390×844, 844×390, 320×568; light/dark; grid/list/compact), including a watched
card: no reported axe violations or page overflow; phone actions were 44 px
high and search text 16 px. Tests used synthetic local data with external
browser requests blocked, not real accounts. Long-running non-streaming
mutations remain exempt from the ordinary 30-second **read** deadline.

Expiry follow-up validation: 73 server tests and 34 client tests passed, plus
the production client build. Added coverage includes exact expiry boundaries,
legacy migration/import age, transactional deletion failure, reader-state
survival across restart/pruning/re-observation, RSS fallback provenance,
304 validator handling, and real service startup against a synthetic old DB.
No production data was deleted or migrated. Migration 12's activation and
rollback requirements are documented in [DEPLOYMENT.md](DEPLOYMENT.md).
The new retention notice also passed Chromium/axe smoke checks at 390 px and
1440 px in both themes, with no reported violations or page overflow.

## Verdict

Keep this architecture. Svelte, Express, SQLite, and a small native NixOS service are a good fit. The highest-value work is failure handling and mobile accessibility, not a framework rewrite, hosted database, or AI feature.

The application is substantially more mature than a simple feed viewer: refresh preview and execution share a planner; quota accounting and fallback are explicit; reader state is shared across devices; backups are verified; feeds use cursor pagination. Preserve those properties.

Before adding features, fix the restore failure path and end-to-end request deadlines. Then improve light-theme contrast, touch targets, phone recovery from suspended requests, and URL handling. Add repeatable browser checks to keep those improvements intact.

## Scope and evidence

- Reviewed checkout: `e7df511e46620c47f62a7fee3983f478a35d46af`, initially clean.
- Read-only inspection of Shrimp showed the active service using `wadstube-291d005`, reporting version `291d005`. The difference from this checkout is documentation only, not application code.
- Reviewed the API, refresh/quota/Shorts handling, restore/export paths, feed stores, main UI components, styles, deployment packaging, and documentation.
- In an isolated copy, `npm ci`, **55/55 server tests**, **28/28 client tests**, and the frontend production build passed under Node 22.23.2. Output was approximately 142.45 kB JavaScript / 45.68 kB gzip and 33.69 kB CSS / 6.70 kB gzip.
- Used a local synthetic 220-video library, Chromium 152, Playwright, and axe-core. Checked 1440×900, 390×844, 844×390, and 320×568 layouts; inspected desktop, phone, and phone-settings screenshots. External browser requests were blocked for the main fixture run.
- Ran isolated fault probes for failed restore writes, a stalled API body, Unicode handles, and differing playlist/video publication dates. No YouTube key or real account data was used.
- No production refresh, restore, backup job, restart, or deployment was performed. Physical iOS/Android devices, Safari, Firefox, software keyboards, and real assistive technologies were not tested. This is not a claim of full mobile compatibility or a penetration test.

## Fix first

### 1. Failed subscription restore can leave the running state changed — P1, reproduced

**Evidence:** [`restoreData`](server/lib/restore.js#L50) assigns `appState.data` before `saveData()` and before orphan cleanup. Its catch path reports the snapshot but does not restore the previous in-memory value. An isolated failing rename produced `EISDIR` while `appState.data !== original` remained true.

**Impact:** the request can report failure while subsequent reads use the imported subscriptions. Disk and memory can disagree; a later successful write could persist that unexpected state. A database-cleanup failure is a second boundary requiring explicit recovery. The pre-restore snapshot is useful but is not automatic rollback.

**Smallest repair:** retain the old object, save the candidate without first publishing it in memory, and restore the old in-memory state on a failed file save. Define and test the file/SQLite failure boundary separately: either restore the previous file after database failure or stop mutations with an explicit recovery-required state. Do not describe two different storage systems as one atomic transaction.

**Acceptance:** injected file-write, rename, and orphan-cleanup failures leave a documented recoverable state; unsuccessful requests never silently publish new in-memory subscriptions. Preserve and verify the recovery snapshot.

### 2. Fetch timeouts end at headers, not at completion — P1, reproduced

**Evidence:** [`youtube.js`](server/lib/youtube.js#L5) and [`rss.js`](server/lib/rss.js#L22) clear their abort timers when `fetch()` resolves. Subsequent `resp.json()` / `resp.text()` reads are outside that deadline. A synthetic response with immediate headers and a never-ending body remained un-aborted after an accelerated deadline. RSS also reads the complete body without a size cap.

**Impact:** a broken upstream can occupy a refresh slot and hold the shared refresh/data-operation lock indefinitely. This can block backup or restore work even though the app advertises ten-second fetch timeouts. Oversized response bodies can consume memory before XML parsing.

**Repair:** use one abort signal through headers and complete body consumption, and cap RSS/API bytes. Explicitly cancel/discard unused error bodies before retries. Keep concurrency limits and exact quota-fallback classifications. `AbortSignal.timeout()` is a suitable primitive, but the signal must remain associated with the body read. [MDN: timeout signals](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static).

**Acceptance:** tests with headers followed by a stalled body, slow chunks, oversized XML/JSON, and retry responses finish within a bounded time and release the lock.

### 3. Light-theme channel links fail contrast; phone actions are too small — P1 for contrast, P2 for ergonomics

**Evidence:** axe reported `color-contrast` on every synthetic channel link at all four sampled sizes. [`app.css`](client/src/app.css#L17) defines a yellow light accent (`#e8a415`), and [`VideoCard.svelte`](client/src/lib/VideoCard.svelte#L83) uses it as small text on an almost-white card. The screenshot confirms this is visibly faint, not merely a theoretical selector issue.

Measured video-action heights at 390 px: **27.27 px** in Grid/List and **23.84 px** in Compact; Compact text is **10.56 px**. The main search field computes to **13.6 px**. Do not infer a WCAG target-size failure from height alone: the minimum criterion has spacing exceptions. Nevertheless, these controls are poor everyday phone targets. [W3C target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

**Repair:** retain the visual theme but use a darker text accent; choose roughly 44 px touch controls for primary actions, allow compact density to affect content rather than hit areas, and use 16 px phone input text. Check watched-card opacity as well as ordinary cards. Test actual iOS focus/zoom behavior rather than disabling user zoom.

**Acceptance:** no serious contrast failures in light/dark, watched/unwatched, and active states; comfortable tap targets; visible focus; real-phone input and landscape checks.

### 4. API refresh stores playlist-add time as video publication time — P2, reproduced

**Evidence:** [`fetchChannelViaApi`](server/lib/youtube.js#L199) requests `snippet` and assigns `snippet.publishedAt` to `published`. A synthetic item with different playlist-add and video-publish dates retained the playlist-add date. Google defines those as different fields: `snippet.publishedAt` is when the item entered the playlist; `contentDetails.videoPublishedAt` is when the video was published. [Playlist item reference](https://developers.google.com/youtube/v3/docs/playlistItems).

**Impact:** ordering and return/inactivity rules can use the wrong timestamp. This is a semantic mismatch; the review did not measure how often real upload playlists differ. Existing upserts also do not overwrite `published`, so fixing ingestion alone will not correct old records.

**Repair:** request `snippet,contentDetails`, select `videoPublishedAt`, and define an explicit fallback for missing values rather than silently using the current time. This remains one `playlistItems.list` request; its documented cost is one unit. Plan a bounded, operator-initiated correction of affected records rather than a hidden mass refresh. [List method and cost](https://developers.google.com/youtube/v3/docs/playlistItems/list).

### 5. Valid international handles are rejected before the API is called — P2, reproduced

**Evidence:** [`resolveUrl`](server/lib/youtube.js#L144) allows only ASCII letters, numbers, underscore, period, and hyphen after `@`. `https://www.youtube.com/@日本語` fails locally with `invalidInput`. URL path encoding makes a simple ASCII regex even less appropriate.

**Repair:** safely decode the handle segment, validate its structure without inventing a narrower alphabet than YouTube, and pass it to the existing exact `channels.list(forHandle=...)` lookup. Preserve host validation and canonical-ID additions that need no API key. Also test percent-encoded handles, pasted channel-tab URLs, malformed escapes, and `/user/...` compatibility if desired. [YouTube handle guidelines](https://support.google.com/youtube/answer/11585688), [exact handle lookup](https://developers.google.com/youtube/v3/docs/channels/list).

### 6. Refresh UI needs reconnection and stale-request handling — P2, source-supported risk

**Evidence:** [`refreshFolder`](client/src/stores/feed.js#L561) waits on a streaming POST with no client deadline/reconciliation; regular requests generally have no timeout either. A missing final summary is correctly treated as failure, which should remain. A server refresh can continue after the browser disconnects. On completion, the store reloads the originally refreshed folder, potentially overriding the feed if navigation changed while the request ran.

**Repair:** on reconnect or foreground return, query existing refresh status/history and show the server's actual outcome. Keep this read-only: do not automatically trigger another refresh. Distinguish idle-stream timeout from a valid long run, cancel obsolete reads, and reload the current navigation scope rather than an old one. Check the use of request `close` versus response-disconnect events in [`routes/refresh.js`](server/routes/refresh.js#L69) with an actual streaming integration test.

**Acceptance:** suspend a phone tab, disconnect Wi-Fi, return after server completion, change folders mid-refresh, and truncate NDJSON. The UI neither claims false success nor remains permanently busy nor displays a mismatched folder.

### 7. API-derived data freshness needs an explicit policy — P2, policy/design gap

Metadata retention is count-based, not age-based. Old stored videos can remain outside the recent RSS/API window indefinitely, without rechecking deletion or metadata changes. Google documents refresh/deletion obligations for stored API data, including a 30-day limit for relevant non-authorized data. Applicability differs by data category; do not assume user-created watch/star state is the same as YouTube-sourced metadata. [YouTube developer policies, storage section](https://developers.google.com/youtube/terms/developer-policies).

Document provenance and last verification, separate local reader state from upstream metadata, and decide how overdue metadata is hidden, refreshed on explicit request, or expired. Preserve the manual-only network rule. A periodic background crawler would change that product contract and needs approval. This is an engineering compliance concern, not a legal conclusion about the deployment.

## Dependency and technology assessment

The lockfiles, not just semver ranges in `package.json`, were inspected. Registry versions were queried September 7 using `npm view <package> version`.

| Component | Locked version | Latest registry version observed | Recommendation |
| --- | --- | --- | --- |
| Svelte | 5.56.6 | 5.57.0 | Routine update; no rewrite |
| Vite | 8.1.5 | 8.2.2 | Update with lockfile/build verification |
| Express | 5.2.1 | 5.2.1 | Keep; update affected transitive packages |
| better-sqlite3 | 12.9.0 | 13.0.3 | Review major-version changes and native rebuild before adopting |
| fast-xml-parser | 5.7.1 | 5.11.1 | Update and retain malformed-feed/size-limit tests |
| p-limit | 7.3.0 | 7.3.2 | Routine patch update |

Primary version sources: npm registry metadata for [Svelte](https://registry.npmjs.org/svelte/latest), [Vite](https://registry.npmjs.org/vite/latest), [Express](https://registry.npmjs.org/express/latest), [better-sqlite3](https://registry.npmjs.org/better-sqlite3/latest), [fast-xml-parser](https://registry.npmjs.org/fast-xml-parser/latest), and [p-limit](https://registry.npmjs.org/p-limit/latest). “Latest” is a dated observation, not an instruction to install every major release.

`npm audit` reported two affected server packages (one low, one moderate) and two frontend-toolchain packages (one moderate, one high). Specifically:

- Server: `body-parser` 2.2.2 and `qs` 6.15.3. The body-parser advisory concerns an invalid size-limit configuration; this app supplies the valid literal `5mb`, so that specific condition is not demonstrated here. Inspect actual parser use before claiming exploitability. [body-parser advisory](https://github.com/advisories/GHSA-v422-hmwv-36x6), [qs advisory](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g).
- Build toolchain: `postcss` 8.5.20 and `nanoid` 3.3.16. These are not proof of a remotely exploitable production frontend. Update compatible transitive versions and rebuild; do not blindly use `npm audit fix --force`. [PostCSS advisory](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp), [nanoid advisory](https://github.com/advisories/GHSA-2v37-7h3g-55p8).

Node 22 is still LTS; Node 24 is a sensible planned LTS migration, while Node 26 is currently “Current,” not the conservative production default. Native SQLite compatibility and Nix package hashes need testing. [Node release status](https://nodejs.org/en/about/previous-releases).

Svelte 5 supports legacy components. Incremental runes adoption may help touched modules, but converting all stores/components provides little immediate user value. [Svelte migration guide](https://svelte.dev/docs/svelte/v5-migration-guide).

## Latest APIs: useful options, not mandatory features

- **Keep exact handle lookup and the granular quota ledger.** Google's June 2026 quota transition is real; do not “correct” this repository back to the older universal search-cost model. The new `videos.batchGetStats` method has its own bucket, but statistics are explicitly outside the present product scope. No reason to add it merely because it exists. [YouTube revision history](https://developers.google.com/youtube/v3/revision_history).
- **Treat Shorts HEAD classification as a heuristic.** [`checkIsShort`](server/lib/youtube.js#L103) treats every redirect as long-form. Validate the redirect target and treat consent/interstitial/unexpected destinations as unknown. Its 200-request classification pool deserves measurement against the otherwise cautious five-request RSS pool. Do not substitute a simplistic duration rule or silently add extra API calls.
- **Add a minimal web manifest before an offline engine.** Icons already exist, but the HTML has no manifest. Add stable identity, name, icons, scope, start URL, and standalone display. A service worker is not required merely for install promotion, and indiscriminate caching would conflict with the existing stale-asset safeguards. [MDN installability](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).
- **Consider Web Share as progressive enhancement** for sending a video link from a phone; retain copy/open links. A share-target entry for pasted subscriptions is a later convenience, not a reason for a native app.
- **WebSub is an alternative product path, not this release's fix.** YouTube supports notifications for uploads and title/description changes, but a reachable callback and subscription lifecycle would change manual-only refresh and the current ingress boundary. Reconsider only if automatic discovery becomes an explicit goal. [Official push-notification guide](https://developers.google.com/youtube/v3/guides/push_notifications).
- **Do not embed an alternate YouTube downloader/player or add AI summaries by default.** Native YouTube links preserve a small, dependable reader. Summaries introduce content-access, cost, provenance, and accuracy questions absent from the current requirement.

## Desktop and phone acceptance bar

The sampled layouts are usable and free of horizontal overflow. That is a good starting point, not complete parity.

1. Automate Chromium, Firefox, and WebKit smoke checks for selecting folders, searching, changing density, watch/star/hide, opening dialogs, and backing out with keyboard/navigation controls.
2. On physical iPhone Safari and Android Chrome, test portrait, landscape, keyboard open, background/foreground return, clipboard failure, and installed launch. Include tablet split-view and desktop 200% zoom.
3. Check hidden-sidebar focus, dialog background interaction, focus return, and settings-popover keyboard behavior. The custom modal has a focus trap but does not make background content inert; a native dialog is an optional smaller accessibility implementation, not a framework migration.
4. Keep cursor pagination, but measure long sessions: the client keeps appending cards, so DOM and memory still grow. Add windowing only when measured scroll or memory problems justify it; a smaller page size or bounded list may suffice.
5. Preserve fonts/theme preferences while adding safe-area handling and reduced-motion support where appropriate. Do not rely on synthetic mobile emulation to establish Safari behavior.

## Documentation to organize and update

- `AGENTS.md` still specifies orange accent values, whereas `app.css` uses yellow/gold. README claims “long-press context menus,” but current folder actions use explicit `details/summary` menus. Reconcile the intended design and actual behavior.
- `DEPLOYMENT.md` prescribes an unconditional dry build, conflicting with the current `nixstuff` policy of evaluation then switch unless a dry build was explicitly requested. Point to one authoritative production runbook. A switch may restart other changed units, so determine impact rather than promising only WadsTube restarts.
- The architecture diagram says URL resolution always uses the API, despite canonical IDs being free. Narrow that label.
- Document `review.md` as a dated assessment, not a replacement for operational instructions. Add a small supported-browser/test matrix, network-disconnect behavior, the metadata freshness decision, and exact full-export restore instructions.
- Keep `README` user-facing, `client/README` development-focused, `AGENTS` constraint-focused, and `DEPLOYMENT` a concise pointer plus release-specific checks. Do not create another large operations manual.

## Recommended sequence and alternatives

1. Repair restore publication and complete-response deadlines; add fault tests.
2. Correct contrast/touch behavior, Unicode handles, and API timestamps.
3. Add browser regression checks and visible refresh reconciliation; update vulnerable compatible dependencies.
4. Decide API-data freshness and add a minimal install manifest; update the conflicting documentation.
5. Measure real phone behavior before considering windowing, WebSub, or a larger player experience.

Preferred path: incremental hardening of the existing app. An installable web app is a reasonable second step. A native app or framework rewrite is not justified by this review.

Research used current Google API/reference/policy pages, Node/Svelte documentation, MDN/W3C guidance, npm registry metadata, and published dependency advisories. Searches focused on quota changes, playlist timestamps, handles, push notifications, storage rules, browser installability, and dependency status. Research stopped after the consequential findings had source evidence or an explicit limitation. Smart-explore tools were unavailable, so source inspection used focused searches; the deep-research workflow informed source verification and the distinction between reproduced defects and proposals.
