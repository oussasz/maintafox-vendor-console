/**
 * Comparison shared by the sync registry drift check (sync-registry-drift.mjs, needs a desktop
 * checkout) and its offline test (sync-registry-snapshot.test.mjs, runs in `pnpm test` against the
 * committed snapshot desktop-sync-registry.snapshot.json).
 *
 * The desktop side is reduced to one list: every type the desktop stages for sync v2 (its
 * server-entity-allowlist.v2.json) with its scope and whether its conflict_policy is append_only
 * (its entity-registry.json, generated from registry.rs). A type the desktop registry does not list
 * (a local-only table) counts as not append-only.
 */

/** Desktop allowlist + entity registry → { protocol_version, entity_types: [{ entity_type, scope, append_only }] }, sorted. */
export function desktopRegistryView(allowlistDoc, entityRegistryDoc) {
  const appendOnly = new Set(
    entityRegistryDoc.entities.filter((e) => e.conflict_policy === "append_only").map((e) => e.entity_type),
  );
  const seen = new Set();
  const entityTypes = [];
  for (const e of allowlistDoc.entity_types) {
    if (seen.has(e.entity_type)) throw new Error(`desktop allowlist: ${e.entity_type} is listed twice`);
    seen.add(e.entity_type);
    entityTypes.push({ entity_type: e.entity_type, scope: e.scope, append_only: appendOnly.has(e.entity_type) });
  }
  entityTypes.sort((a, b) => (a.entity_type < b.entity_type ? -1 : a.entity_type > b.entity_type ? 1 : 0));
  return { protocol_version: allowlistDoc.protocol_version, entity_types: entityTypes };
}

/**
 * Problems between the server registry (shared/sync-entity-registry.v2.json) and a desktop view;
 * empty when aligned. A type only the desktop has would be refused by the server
 * (unknown_entity_type); a type only the server has is dead; append_only must match the desktop's
 * conflict policy (the server refuses deletes of append-only types).
 */
export function compareServerToDesktop(serverDoc, desktopView) {
  const problems = [];
  if (serverDoc.protocol_version !== desktopView.protocol_version) {
    problems.push(`protocol_version: server ${serverDoc.protocol_version}, desktop ${desktopView.protocol_version}`);
  }
  const server = new Map();
  for (const e of serverDoc.entity_types) {
    if (server.has(e.entity_type)) problems.push(`${e.entity_type}: listed twice in the server registry`);
    server.set(e.entity_type, e);
  }
  const desk = new Map(desktopView.entity_types.map((e) => [e.entity_type, e]));
  for (const [type, d] of desk) {
    const s = server.get(type);
    if (!s) {
      problems.push(`${type}: staged by the desktop, missing from the server registry (refused as unknown_entity_type)`);
      continue;
    }
    if (s.scope !== d.scope) problems.push(`${type}: scope ${s.scope} on the server, ${d.scope} on the desktop`);
  }
  for (const [type, s] of server) {
    if (!desk.has(type)) problems.push(`${type}: in the server registry, not in the desktop allowlist`);
    const expected = desk.get(type)?.append_only ?? false;
    if (typeof s.append_only !== "boolean") {
      problems.push(`${type}: append_only missing in the server registry (must be ${expected})`);
    } else if (s.append_only !== expected) {
      problems.push(
        `${type}: append_only ${s.append_only} on the server, conflict_policy ${expected ? "append_only" : "not append_only"} on the desktop`,
      );
    }
  }
  return problems;
}
