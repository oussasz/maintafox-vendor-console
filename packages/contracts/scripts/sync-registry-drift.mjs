/**
 * Drift check: the server's sync entity registry (shared/sync-entity-registry.v2.json, read by the
 * API's validator) against the desktop's allowlist (maintafox-desktop
 * shared/sync/server-entity-allowlist.v2.json, what the desktop stages for sync v2) and its entity
 * registry (shared/sync/entity-registry.json, generated from registry.rs).
 *
 *   node packages/contracts/scripts/sync-registry-drift.mjs --desktop <maintafox-desktop checkout>
 *   node packages/contracts/scripts/sync-registry-drift.mjs --desktop <checkout> --write-snapshot
 *
 * Fails when an entity type is on one side only or has another scope: a type only the desktop has
 * would be refused by the server (unknown_entity_type); a type only the server has is dead.
 * Also fails when a server entry's `append_only` flag differs from the desktop's conflict_policy:
 * append_only must be true exactly for conflict_policy "append_only" (the server refuses deletes of
 * those types). A type the desktop registry does not list (a local-only table) must be false.
 *
 * It also fails when packages/contracts/desktop-sync-registry.snapshot.json no longer matches the
 * desktop: that snapshot is what `pnpm test` checks the server registry against without a desktop
 * checkout (sync-registry-snapshot.test.mjs). --write-snapshot rewrites it from the desktop.
 * CI runs it against the desktop repository (.github/workflows/ci.yml, contracts-drift).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareServerToDesktop, desktopRegistryView } from "./sync-registry-compare.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_REGISTRY = join(here, "../../../shared/sync-entity-registry.v2.json");
const SNAPSHOT = join(here, "../desktop-sync-registry.snapshot.json");
const DESKTOP_REL = "shared/sync/server-entity-allowlist.v2.json";
const DESKTOP_REGISTRY_REL = "shared/sync/entity-registry.json";

const i = process.argv.indexOf("--desktop");
const desktop = i >= 0 ? process.argv[i + 1] : undefined;
if (!desktop) {
  console.error("usage: node packages/contracts/scripts/sync-registry-drift.mjs --desktop <maintafox-desktop checkout> [--write-snapshot]");
  process.exit(2);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const view = desktopRegistryView(readJson(join(desktop, DESKTOP_REL)), readJson(join(desktop, DESKTOP_REGISTRY_REL)));

if (process.argv.includes("--write-snapshot")) {
  const doc = {
    description:
      "Desktop sync registry the server must mirror: maintafox-desktop shared/sync/server-entity-allowlist.v2.json (types, scopes) and shared/sync/entity-registry.json (append_only = conflict_policy append_only). Written by packages/contracts/scripts/sync-registry-drift.mjs --write-snapshot; never edit by hand.",
    ...view,
  };
  writeFileSync(SNAPSHOT, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`snapshot written: ${view.entity_types.length} entity types`);
}

const serverDoc = readJson(SERVER_REGISTRY);
const problems = compareServerToDesktop(serverDoc, view);
const snapshot = readJson(SNAPSHOT);
if (snapshot.protocol_version !== view.protocol_version || JSON.stringify(snapshot.entity_types) !== JSON.stringify(view.entity_types)) {
  problems.push("packages/contracts/desktop-sync-registry.snapshot.json: stale against the desktop; rerun with --write-snapshot and commit it");
}

if (problems.length > 0) {
  console.error(`sync registry drift (${problems.length}):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
const appendOnlyCount = serverDoc.entity_types.filter((e) => e.append_only).length;
console.log(
  `sync registry aligned with the desktop: ${view.entity_types.length} entity types, same scopes, same append_only flags (${appendOnlyCount} append-only); snapshot up to date`,
);
