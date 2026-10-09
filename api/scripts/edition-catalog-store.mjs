/**
 * Edition catalog store + Zod + repair (no HTTP server).
 */
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  CapabilitiesMapSchema,
  MODULE_CAPABILITY_KEYS,
  capabilitiesMapForEdition,
  repairCapabilitiesJson,
  serializeCapabilitiesMap,
} from "../dist/edition-catalog.js";
import {
  EditionCatalogError,
  createEdition,
  deleteEdition,
  ensureEditionCatalogSchema,
  ensureSystemEditionsPresent,
  listEditions,
  loadCapabilitiesJsonForSign,
  repairAllEditionCapabilities,
  seedEditionCatalogIfEmpty,
  updateEdition,
} from "../dist/edition-catalog-store.js";
import { buildSignedEntitlementEnvelope } from "../dist/entitlement-signer.js";

const db = new Database(":memory:");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE tenants (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    edition TEXT NOT NULL DEFAULT 'core',
    is_active INTEGER NOT NULL DEFAULT 1
  );
`);

ensureEditionCatalogSchema(db);
seedEditionCatalogIfEmpty(db);
ensureSystemEditionsPresent(db);

const seeded = listEditions(db);
assert.equal(seeded.length, 4);
assert.ok(seeded.every((e) => e.is_system));

// Zod rejects partial maps
const partial = { equipment: true };
assert.equal(CapabilitiesMapSchema.safeParse(partial).success, false);

const full = capabilitiesMapForEdition("professional");
assert.equal(CapabilitiesMapSchema.safeParse(full).success, true);

// Repair adds missing keys as false
const legacy = JSON.stringify({ equipment: true, requests: true });
const repaired = repairCapabilitiesJson(legacy);
assert.ok(repaired);
assert.equal(repaired.changed, true);
assert.equal(repaired.map.equipment, true);
assert.equal(repaired.map.planning, false);
assert.equal(repaired.map.permits, false);
assert.equal(repaired.map.training, false);
assert.equal(MODULE_CAPABILITY_KEYS.every((k) => typeof repaired.map[k] === "boolean"), true);

// Persist a row with legacy JSON and run boot repair
db.prepare(
  `UPDATE edition_catalog SET capabilities_json = ? WHERE id = 'core'`,
).run(legacy);
const n = repairAllEditionCapabilities(db);
assert.ok(n >= 1);
const coreAfter = loadCapabilitiesJsonForSign(db, "core");
assert.ok(coreAfter.capabilities_json.includes('"planning":false'));

// Stale PATCH → version conflict
const pro = listEditions(db).find((e) => e.id === "professional");
assert.ok(pro);
const nextCaps = { ...pro.capabilities, permits: false, inspections: false };
updateEdition(db, "professional", {
  capabilities: nextCaps,
  expected_row_version: pro.row_version,
  actorId: "test",
});
try {
  updateEdition(db, "professional", {
    capabilities: nextCaps,
    expected_row_version: pro.row_version,
    actorId: "test",
  });
  assert.fail("expected version conflict");
} catch (err) {
  assert.ok(err instanceof EditionCatalogError);
  assert.equal(err.code, "edition_version_conflict");
}

// Sign snapshot uses DB map
const snap = loadCapabilitiesJsonForSign(db, "professional");
assert.ok(snap.capabilities_json.includes('"permits":false'));
const envelope = buildSignedEntitlementEnvelope({
  edition: "professional",
  capabilities_json: snap.capabilities_json,
  lineageVersion: 1,
  channel: "stable",
  machineSlots: 1,
  validUntil: "2099-01-01T00:00:00.000Z",
  offlineGraceUntil: "2099-01-04T00:00:00.000Z",
});
assert.equal(envelope.tier, "professional");
assert.ok(envelope.capabilities_json.includes('"permits":false'));
assert.ok(envelope.capabilities_json.includes('"planning":true'));
assert.ok(envelope.capabilities_json.includes('"training":false'));

// Custom edition create + delete
const customCaps = serializeCapabilitiesMap({
  ...capabilitiesMapForEdition("core"),
  planning: true,
  pm: true,
});
const customMap = JSON.parse(customCaps);
const created = createEdition(db, {
  id: "professional-ops",
  label: "Professional Ops",
  capabilities: customMap,
  actorId: "test",
});
assert.equal(created.is_system, false);

db.prepare(
  `INSERT INTO tenants (id, slug, display_name, edition, is_active) VALUES (?, ?, ?, ?, 0)`,
).run("t1", "inactive-tenant", "Inactive", "professional-ops");

try {
  deleteEdition(db, "professional-ops");
  assert.fail("expected edition_in_use for inactive tenant");
} catch (err) {
  assert.ok(err instanceof EditionCatalogError);
  assert.equal(err.code, "edition_in_use");
}

db.prepare(`DELETE FROM tenants WHERE id = ?`).run("t1");
deleteEdition(db, "professional-ops");
assert.equal(listEditions(db).some((e) => e.id === "professional-ops"), false);

// System editions cannot be deleted
try {
  deleteEdition(db, "core");
  assert.fail("expected system immutable");
} catch (err) {
  assert.ok(err instanceof EditionCatalogError);
  assert.equal(err.code, "edition_system_immutable");
}

console.log("edition-catalog store checks ok");
