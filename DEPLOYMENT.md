# WadsTube Deployment

WadsTube has two supported release paths: portable Docker Compose and the
maintainer's native NixOS service on `shrimp`. Both preserve application state
outside the immutable application build.

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
6. Fast-forward `/home/phobus/nixstuff` and build without switching:

   ```bash
   cd /home/phobus/nixstuff
   git fetch origin main
   git merge --ff-only origin/main
   nixos-rebuild build --flake .#shrimp
   ```

7. Disclose the brief WadsTube restart and obtain explicit approval. Activate:

   ```bash
   sudo nixos-rebuild switch --flake .#shrimp
   ```

8. Verify `wadstube.service`, the new store path and reported source version,
   local and public HTTP responses, unchanged database counts, idle refresh and
   backup state, and the intended frontend asset or API behavior.

The switch restarts only `wadstube.service` when WadsTube is the sole changed
unit. It does not require a host reboot.
