# @maintafox/contracts

Contracts the vendor console shares with the Maintafox desktop. `src/desktop-ipc.generated.ts` is
generated from the desktop's `shared/ipc-types.ts` (never edit it by hand); the console imports
from `@maintafox/contracts`.

- Regenerate: `node packages/contracts/scripts/extract-desktop-types.mjs --desktop <desktop checkout>`
- Drift checks run in CI (`contracts-drift`): see `deploy/CI.md`, "Contracts shared with the desktop".
- Sync registry: `desktop-sync-registry.snapshot.json` is the desktop's sync registry (types, scopes,
  append-only flags). `pnpm test` checks `shared/sync-entity-registry.v2.json` against it with no
  desktop checkout; `node packages/contracts/scripts/sync-registry-drift.mjs --desktop <checkout>`
  checks both against the desktop, and `--write-snapshot` refreshes the snapshot after a desktop change.
