/**
 * Drift check: the server's sync entity registry (shared/sync-entity-registry.v2.json, read by the
 * API's validator) against the desktop's allowlist (maintafox-desktop
 * shared/sync/server-entity-allowlist.v2.json, what the desktop stages for sync v2).
 *
 *   node packages/contracts/scripts/sync-registry-drift.mjs --desktop <maintafox-desktop checkout>
 *
 * Fails when an entity type is on one side only or has another scope: a type only the desktop has
 * would be refused by the server (unknown_entity_type); a type only the server has is dead.
 * CI runs it against the desktop repository (.github/workflows/ci.yml, contracts-drift).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_REGISTRY = join(here, "../../../shared/sync-entity-registry.v2.json");
const DESKTOP_REL = "shared/sync/server-entity-allowlist.v2.json";

const i = process.argv.indexOf("--desktop");
const desktop = i >= 0 ? process.argv[i + 1] : undefined;
if (!desktop) {
  console.error("usage: node packages/contracts/scripts/sync-registry-drift.mjs --desktop <maintafox-desktop checkout>");
  process.exit(2);
}

/** entity_type → scope, refusing a duplicate entry. */
function scopes(path) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const out = new Map();
  for (const e of doc.entity_types) {
    if (out.has(e.entity_type)) throw new Error(`${path}: ${e.entity_type} is listed twice`);
    out.set(e.entity_type, e.scope);
  }
  return { protocol: doc.protocol_version, types: out };
}

const server = scopes(SERVER_REGISTRY);
const desk = scopes(join(desktop, DESKTOP_REL));
const problems = [];
if (server.protocol !== desk.protocol) problems.push(`protocol_version: server ${server.protocol}, desktop ${desk.protocol}`);
for (const [type, scope] of desk.types) {
  if (!server.types.has(type)) problems.push(`${type}: staged by the desktop, missing from the server registry (refused as unknown_entity_type)`);
  else if (server.types.get(type) !== scope) problems.push(`${type}: scope ${server.types.get(type)} on the server, ${scope} on the desktop`);
}
for (const type of server.types.keys()) {
  if (!desk.types.has(type)) problems.push(`${type}: in the server registry, not in the desktop allowlist`);
}
if (problems.length > 0) {
  console.error(`sync registry drift (${problems.length}):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`sync registry aligned with the desktop: ${server.types.size} entity types, same scopes`);
