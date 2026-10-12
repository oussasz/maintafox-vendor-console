/**
 * Commercial edition presets → module-level capabilities.
 * Desktop enforces capabilities only; edition names are commercial metadata.
 *
 * Runtime SSOT is the `edition_catalog` Postgres table (see edition-catalog-store.ts).
 * Functions here are **factory defaults** for seed + offline Desktop fallback alignment.
 *
 * When adding a new MODULE_CAPABILITY_KEYS entry:
 * 1. Add the key here and in Desktop `module-capability.ts` / `edition-capability-catalog.ts`
 * 2. Boot repair adds the key as `false` to every stored capabilities_json row
 * 3. Operators enable it per edition in Vendor Console → Editions
 * 4. Cover with a repair + Zod rejection test
 */

import { z } from "zod";

export const SYSTEM_EDITION_IDS = ["core", "professional", "enterprise", "development"] as const;
/** @deprecated Prefer SYSTEM_EDITION_IDS; kept for seed / round-trip scripts. */
export const EDITION_IDS = SYSTEM_EDITION_IDS;
export type SystemEditionId = (typeof SYSTEM_EDITION_IDS)[number];
/** Any catalog id (system or custom slug). */
export type EditionId = string;

export const MODULE_CAPABILITY_KEYS = [
  "equipment",
  "requests",
  "work_orders",
  "inventory",
  "personnel",
  "organization",
  "reference",
  "planning",
  "pm",
  "permits",
  "inspections",
  "training",
  "reports",
  "rams",
  "finance",
  "sync",
  "erp",
  // Email channel of desktop notifications (POST /api/v1/notifications/email). Off in every factory
  // edition: the desktop offers email only when an operator turns this on explicitly.
  "notifications.email",
] as const;

export type ModuleCapabilityKey = (typeof MODULE_CAPABILITY_KEYS)[number];

export type CapabilitiesMap = Record<ModuleCapabilityKey, boolean>;

const CORE_MODULES: ModuleCapabilityKey[] = [
  "equipment",
  "requests",
  "work_orders",
  "inventory",
  "personnel",
  "organization",
  "reference",
];

const PROFESSIONAL_EXTRA: ModuleCapabilityKey[] = ["planning", "pm", "permits", "inspections"];

const ENTERPRISE_EXTRA: ModuleCapabilityKey[] = [
  "training",
  "reports",
  "rams",
  "finance",
  "sync",
  "erp",
];

const GRACE_ALLOWED_MODULES: ModuleCapabilityKey[] = [
  "equipment",
  "work_orders",
  "requests",
  "inventory",
  "organization",
  "reference",
];

export const EDITION_LABELS: Record<SystemEditionId, string> = {
  core: "Core",
  professional: "Professional",
  enterprise: "Enterprise",
  development: "Development",
};

/** Slug for custom editions: lowercase letters, digits, dashes; 2–64 chars. */
export const EditionSlugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "edition_id_invalid");

export const CapabilitiesMapSchema = z
  .object(
    Object.fromEntries(MODULE_CAPABILITY_KEYS.map((k) => [k, z.boolean()])) as {
      [K in ModuleCapabilityKey]: z.ZodBoolean;
    },
  )
  .strict();

function modulesForSystemEdition(edition: SystemEditionId): Set<ModuleCapabilityKey> {
  const set = new Set<ModuleCapabilityKey>(CORE_MODULES);
  if (edition === "professional" || edition === "enterprise" || edition === "development") {
    for (const m of PROFESSIONAL_EXTRA) set.add(m);
  }
  if (edition === "enterprise" || edition === "development") {
    for (const m of ENTERPRISE_EXTRA) set.add(m);
  }
  return set;
}

export function isSystemEditionId(value: unknown): value is SystemEditionId {
  return typeof value === "string" && (SYSTEM_EDITION_IDS as readonly string[]).includes(value);
}

/** @deprecated Use isSystemEditionId for system presets; custom ids are DB-resolved. */
export function isEditionId(value: unknown): value is SystemEditionId {
  return isSystemEditionId(value);
}

/**
 * Resolve a known system edition id, else return fallback.
 * Custom editions must be validated against the DB (editionExists).
 */
export function parseEditionId(value: unknown, fallback: SystemEditionId = "core"): SystemEditionId {
  return isSystemEditionId(value) ? value : fallback;
}

/** Full boolean map for every known module key (factory default). */
export function capabilitiesMapForEdition(edition: SystemEditionId): CapabilitiesMap {
  const enabled = modulesForSystemEdition(edition);
  const out = {} as CapabilitiesMap;
  for (const key of MODULE_CAPABILITY_KEYS) {
    out[key] = enabled.has(key);
  }
  return out;
}

export function capabilitiesJsonForEdition(edition: SystemEditionId): string {
  return JSON.stringify(capabilitiesMapForEdition(edition));
}

export function featureFlagsJsonForEdition(): string {
  return "{}";
}

export function policyJsonForEdition(): string {
  return JSON.stringify({ grace_allowed_modules: GRACE_ALLOWED_MODULES });
}

export type EditionCatalogEntry = {
  id: string;
  label: string;
  capabilities: CapabilitiesMap;
  is_system: boolean;
  row_version: number;
  updated_at?: string | null;
  updated_by?: string | null;
};

/** Factory catalog (seed source). Not the runtime SSOT. */
export function listFactoryEditionCatalog(): EditionCatalogEntry[] {
  return SYSTEM_EDITION_IDS.map((id) => ({
    id,
    label: EDITION_LABELS[id],
    capabilities: capabilitiesMapForEdition(id),
    is_system: true,
    row_version: 1,
  }));
}

/** @deprecated Prefer listFactoryEditionCatalog or DB listEditions. */
export function listEditionCatalog(): EditionCatalogEntry[] {
  return listFactoryEditionCatalog();
}

/**
 * Normalize stored capabilities_json to the current MODULE_CAPABILITY_KEYS.
 * Missing keys → false (fail-closed). Unknown keys stripped.
 * Returns null if JSON is corrupt / not an object.
 */
export function repairCapabilitiesJson(raw: string): {
  json: string;
  map: CapabilitiesMap;
  changed: boolean;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const map = {} as CapabilitiesMap;
  let changed = false;
  for (const key of MODULE_CAPABILITY_KEYS) {
    if (key in obj && typeof obj[key] === "boolean") {
      map[key] = obj[key] as boolean;
    } else {
      map[key] = false;
      changed = true;
    }
  }
  for (const key of Object.keys(obj)) {
    if (!(MODULE_CAPABILITY_KEYS as readonly string[]).includes(key)) {
      changed = true;
    }
  }
  const json = JSON.stringify(map);
  if (json !== raw) changed = true;
  return { json, map, changed };
}

export function serializeCapabilitiesMap(map: CapabilitiesMap): string {
  const ordered = {} as CapabilitiesMap;
  for (const key of MODULE_CAPABILITY_KEYS) {
    ordered[key] = map[key];
  }
  return JSON.stringify(ordered);
}
