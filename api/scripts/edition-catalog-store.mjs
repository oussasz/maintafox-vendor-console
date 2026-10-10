/**
 * Edition catalog store + Zod + repair (no HTTP server), against a real Postgres database
 * migrated with the API's own migrations.
 */
import assert from "node:assert/strict";

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
  ensureSystemEditionsPresent,
  listEditions,
  loadCapabilitiesJsonForSign,
  repairAllEditionCapabilities,
  seedEditionCatalogIfEmpty,
  updateEdition,
} from "../dist/edition-catalog-store.js";
import { openDatabase } from "../dist/db/database.js";
import { runMigrations } from "../dist/db/migrate.js";
import { buildSignedEntitlementEnvelope } from "../dist/entitlement-signer.js";
import { startTestPostgres } from "./lib/test-postgres.mjs";
import { TEST_ENTITLEMENT_SIGNING_ENV } from "./lib/test-signing-key.mjs";

// The signer has no built-in key; tests configure the TEST-ONLY key explicitly.
Object.assign(process.env, TEST_ENTITLEMENT_SIGNING_ENV);

const testPg = await startTestPostgres();
const db = await openDatabase(await testPg.createDatabase(), "edition-catalog-store-test");
try {
await runMigrations(db, () => {});

await seedEditionCatalogIfEmpty(db);
await ensureSystemEditionsPresent(db);

const seeded = await listEditions(db);
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
await db.run(`UPDATE edition_catalog SET capabilities_json = ? WHERE id = 'core'`, legacy);
const n = await repairAllEditionCapabilities(db);
assert.ok(n >= 1);
const coreAfter = await loadCapabilitiesJsonForSign(db, "core");
assert.ok(coreAfter.capabilities_json.includes('"planning":false'));

// Stale PATCH → version conflict
const pro = (await listEditions(db)).find((e) => e.id === "professional");
assert.ok(pro);
const nextCaps = { ...pro.capabilities, permits: false, inspections: false };
await updateEdition(db, "professional", {
  capabilities: nextCaps,
  expected_row_version: pro.row_version,
  actorId: "test",
});
try {
  await updateEdition(db, "professional", {
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
const snap = await loadCapabilitiesJsonForSign(db, "professional");
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
const created = await createEdition(db, {
  id: "professional-ops",
  label: "Professional Ops",
  capabilities: customMap,
  actorId: "test",
});
assert.equal(created.is_system, false);

await db.run(
  `INSERT INTO tenants (id, slug, display_name, edition, is_active) VALUES (?, ?, ?, ?, 0)`,
  "t1",
  "inactive-tenant",
  "Inactive",
  "professional-ops",
);

try {
  await deleteEdition(db, "professional-ops");
  assert.fail("expected edition_in_use for inactive tenant");
} catch (err) {
  assert.ok(err instanceof EditionCatalogError);
  assert.equal(err.code, "edition_in_use");
}

await db.run(`DELETE FROM tenants WHERE id = ?`, "t1");
await deleteEdition(db, "professional-ops");
assert.equal((await listEditions(db)).some((e) => e.id === "professional-ops"), false);

// System editions cannot be deleted
try {
  await deleteEdition(db, "core");
  assert.fail("expected system immutable");
} catch (err) {
  assert.ok(err instanceof EditionCatalogError);
  assert.equal(err.code, "edition_system_immutable");
}

console.log("edition-catalog store checks ok");
} finally {
  await db.close();
  await testPg.stop();
}
