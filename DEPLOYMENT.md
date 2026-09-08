# WadsTube Deployment

WadsTube has two supported release paths: portable Docker Compose and the
maintainer's native NixOS service on `shrimp`. Both preserve application state
outside the immutable application build.

## Migration 12: first-upgrade and rollback warning

This version expires live cached video metadata after 30 days without an actual
RSS/API observation. Startup can delete many legacy rows, using their original
storage dates conservatively. Reader state is retained; cards disappear until
re-observed. Obtain a verified matching pre-upgrade `tube.json`/SQLite backup
before activation. Do not run this checkout against production data merely to
evaluate it. Migration 12 is already active on Shrimp (September 7, 2026);
these warnings still apply to older standalone installations. The subsequent
browser/Shorts maintenance release does not introduce another schema migration.

An older schema-11 binary cannot open the upgraded schema-12 database. Rolling
back code alone is not sufficient: use a controlled, approved offline restore
of the matching pre-upgrade pair, preserving the newer pair first. Such a
restore loses post-backup changes unless reconciled separately. Existing
backups/archives are not deleted by the expiry worker.

After activation, check the logged expiry count, retained reader-state count,
and schema version; do not require the cached-video count to remain unchanged.
For Shrimp, disclose affected services and obtain downtime approval separately.

## Docker Compose

1. Back up the bind-mounted `data/` directory.
2. Pull the desired source revision.
3. Build and start the service:

   ```bash
   docker compose up --build -d
   ```

4. Verify the container and local endpoint:

   ```bash
   docker compose ps
   curl -fsS http://127.0.0.1:3000/api/status/system
   ```

Database schema migrations are additive and run automatically at startup.
Keep `tube.json`, `wadstube.db`, and `backups/` in the mounted `data/`
directory.

## Native NixOS on Shrimp

Shrimp packages WadsTube from `vendor/wadstube` in the sibling `nixstuff`
repository. The old `~/wadstube-redeploy.sh` Docker workflow is obsolete.

1. Validate, commit, and push this repository on `main`; record the seven-digit
   source commit.
2. Copy only the changed source, documentation, and tests into
   `nixstuff/vendor/wadstube`.
3. Update every source-version reference in
   `nixos/hosts/shrimp/wadstube.nix`: server, client, combined package, and
   `WADSTUBE_VERSION`.
4. In `nixstuff`, run `nix flake check --no-build`, commit the scoped deployment
   files, and push `main`.
5. Before touching live state, confirm the host is `shrimp`, the checkout is
   clean, `wadstube.service` is active, and `/api/status/refresh` reports that no
   refresh is running. Capture `/api/status/system` database counts.
6. Shrimp has used its regular checkout since September 8, 2026. The historical
   dependency-pinned rollout is no longer the deployment target. Inspect and
   fast-forward the regular checkout, then evaluate without switching:

   ```bash
   cd /home/phobus/nixstuff
   git status --short # stop if there are unexpected changes
   git pull --ff-only
   nix flake check --no-build
   ```

   Follow `nixstuff/AGENTS.md` for platform evaluation requirements. A separate
   dry build is not part of the default workflow unless explicitly requested.

7. Determine all affected units, disclose expected downtime, and obtain explicit
   approval. Check `hostname` is `shrimp` immediately before activation:

   ```bash
   hostname
   sudo nixos-rebuild switch --flake .#shrimp
   ```

8. Verify `wadstube.service`, the new store path and reported source version,
   local and public HTTP responses, expected database counts after expiry, idle refresh and
   backup state, and the intended frontend asset or API behavior.

The switch restarts only `wadstube.service` when WadsTube is the sole changed
unit. It does not require a host reboot.

## Personal Chrome companion

Set `ALLOWED_ORIGINS` to include the exact origin
`chrome-extension://mhjagbgfpcefdmidgmbmfkfoabephnbm`; preserve any other explicitly
allowed origins. The Nix module owns this non-secret setting on Shrimp. Do not
weaken the LAN/Tailscale ingress policy. The companion introduces no schema or
state-format changes. Follow the same verified full-backup and restart-approval
workflow as other releases, then test its OPTIONS preflight and read-only folder
membership flags before the operator tests a real save.

Chrome installation is separate: load this repository's `extension/` folder
unpacked on the computer running Chrome. See `extension/README.md`.
