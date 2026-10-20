/**
 * Drift check: the server's sync entity registry (shared/sync-entity-registry.v2.json, read by the
 * API's validator) against the desktop's allowlist (maintafox-desktop
 * shared/sync/server-entity-allowlist.v2.json, what the desktop stages for sync v2).
 *
 *   node packages/contracts/scripts/sync-registry-drift.mjs --desktop <maintafox-desktop checkout>
 *
 * Fails when an entity type is on one side only or has another scope: a type only the desktop has
 * would be refused by the server (unknown_entity_type); a type only the server has is dead.
 * Also fails when a server entry's `append_only` flag differs from the desktop entity registry
 * (shared/sync/entity-registry.json, generated from registry.rs): append_only must be true exactly
 * for conflict_policy "append_only" (the server refuses deletes of those types). A type the desktop
 * registry does not list (a local-only table) must be append_only false.
 * CI runs it against the desktop repository (.github/workflows/ci.yml, contracts-drift).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_REGISTRY = join(here, "../../../shared/sync-entity-registry.v2.json");
const DESKTOP_REL = "shared/sync/server-entity-allowlist.v2.json";
const DESKTOP_REGISTRY_REL = "shared/sync/entity-registry.json";

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

// append_only flag of every server entry against the desktop's conflict policy.
const serverDoc = JSON.parse(readFileSync(SERVER_REGISTRY, "utf8"));
const deskRegistry = JSON.parse(readFileSync(join(desktop, DESKTOP_REGISTRY_REL), "utf8"));
const deskAppendOnly = new Set(deskRegistry.entities.filter((e) => e.conflict_policy === "append_only").map((e) => e.entity_type));
let appendOnlyCount = 0;
for (const e of serverDoc.entity_types) {
  if (typeof e.append_only !== "boolean") {
    problems.push(`${e.entity_type}: append_only missing in the server registry (must be ${deskAppendOnly.has(e.entity_type)})`);
    continue;
  }
  if (e.append_only) appendOnlyCount += 1;
  if (e.append_only !== deskAppendOnly.has(e.entity_type)) {
    problems.push(`${e.entity_type}: append_only ${e.append_only} on the server, conflict_policy ${deskAppendOnly.has(e.entity_type) ? "append_only" : "not append_only"} on the desktop`);
  }
}

if (problems.length > 0) {
  console.error(`sync registry drift (${problems.length}):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `sync registry aligned with the desktop: ${server.types.size} entity types, same scopes, same append_only flags (${appendOnlyCount} append-only)`,
);
