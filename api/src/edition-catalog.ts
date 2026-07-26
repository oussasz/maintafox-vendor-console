/**
 * Commercial edition presets → module-level capabilities.
 * Desktop enforces capabilities only; edition names are commercial metadata.
 */

export const EDITION_IDS = ["core", "professional", "enterprise", "development"] as const;
export type EditionId = (typeof EDITION_IDS)[number];

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
  "reports",
  "rams",
  "finance",
  "sync",
  "erp",
] as const;

export type ModuleCapabilityKey = (typeof MODULE_CAPABILITY_KEYS)[number];

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

const ENTERPRISE_EXTRA: ModuleCapabilityKey[] = ["reports", "rams", "finance", "sync", "erp"];

const GRACE_ALLOWED_MODULES: ModuleCapabilityKey[] = [
  "equipment",
  "work_orders",
  "requests",
  "inventory",
  "organization",
  "reference",
];

export const EDITION_LABELS: Record<EditionId, string> = {
  core: "Core",
  professional: "Professional",
  enterprise: "Enterprise",
  development: "Development",
};

function modulesForEdition(edition: EditionId): Set<ModuleCapabilityKey> {
  const set = new Set<ModuleCapabilityKey>(CORE_MODULES);
  if (edition === "professional" || edition === "enterprise" || edition === "development") {
    for (const m of PROFESSIONAL_EXTRA) set.add(m);
  }
  if (edition === "enterprise" || edition === "development") {
    for (const m of ENTERPRISE_EXTRA) set.add(m);
  }
  return set;
}

export function isEditionId(value: unknown): value is EditionId {
  return typeof value === "string" && (EDITION_IDS as readonly string[]).includes(value);
}

export function parseEditionId(value: unknown, fallback: EditionId = "core"): EditionId {
  return isEditionId(value) ? value : fallback;
}

/** Full boolean map for every known module key. */
export function capabilitiesMapForEdition(edition: EditionId): Record<ModuleCapabilityKey, boolean> {
  const enabled = modulesForEdition(edition);
  const out = {} as Record<ModuleCapabilityKey, boolean>;
  for (const key of MODULE_CAPABILITY_KEYS) {
    out[key] = enabled.has(key);
  }
  return out;
}

export function capabilitiesJsonForEdition(edition: EditionId): string {
  return JSON.stringify(capabilitiesMapForEdition(edition));
}

export function featureFlagsJsonForEdition(): string {
  return "{}";
}

export function policyJsonForEdition(): string {
  return JSON.stringify({ grace_allowed_modules: GRACE_ALLOWED_MODULES });
}

export type EditionCatalogEntry = {
  id: EditionId;
  label: string;
  capabilities: Record<ModuleCapabilityKey, boolean>;
};

export function listEditionCatalog(): EditionCatalogEntry[] {
  return EDITION_IDS.map((id) => ({
    id,
    label: EDITION_LABELS[id],
    capabilities: capabilitiesMapForEdition(id),
  }));
}
