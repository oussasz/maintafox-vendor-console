# @maintafox/contracts

Contracts the vendor console shares with the Maintafox desktop. `src/desktop-ipc.generated.ts` is
generated from the desktop's `shared/ipc-types.ts` (never edit it by hand); the console imports
from `@maintafox/contracts`.

- Regenerate: `node packages/contracts/scripts/extract-desktop-types.mjs --desktop <desktop checkout>`
- Drift checks run in CI (`contracts-drift`): see `deploy/CI.md`, "Contracts shared with the desktop".
