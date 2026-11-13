/**
 * Typed sync entity registry (protocol v2): the allowlist of entity types and their delivery scope.
 * Source of truth: `shared/sync-entity-registry.v2.json` at the repository root (copied into the
 * API image at /app/shared). Loaded and validated once at startup; a malformed file stops the API.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

export type SyncEntityScope = "tenant" | "user";

export type AuthorField = { readonly field: string; readonly guards: readonly string[] };
/**
 * Rights the server judges as a plant-wide holder (authority.ts `holdsTenantRight`). The takeover
 * rules of authority.ts apply to the user and role administration types only.
 */
export const AUTHORITY_RIGHTS = ["adm.users", "adm.roles", "adm.settings", "org.admin"] as const;
export type AuthorityRight = (typeof AUTHORITY_RIGHTS)[number];

export const SYNC_ENTITY_REGISTRY_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../shared/sync-entity-registry.v2.json",
);

const RegistryFile = z
  .object({
    registry_version: z.number().int().min(1),
    protocol_version: z.literal("v2"),
    description: z.string(),
    entity_types: z
      .array(
        z
          .object({
            entity_type: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
            scope: z.enum(["tenant", "user"]),
            /** History rows: the server refuses their delete/archive (validate.ts). Required on every entry. */
            append_only: z.boolean(),
            /**
             * Per-user signing (sync-signing-design.md §5): the wire fields naming the user who made
             * part of the change, each with the columns that user vouches for.
             */
            author_fields: z
              .array(
                z
                  .object({
                    field: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
                    guards: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,127}$/)),
                  })
                  .strict(),
              )
              .optional(),
            /** Authority data (accounts, grants, roles): the right the maker must hold plant-wide. */
            authority: z.enum(AUTHORITY_RIGHTS).optional(),
            /** Published by the server only; a device push of this type is refused. */
            server_only: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type SyncEntityRegistry = {
  readonly version: number;
  scopeOf(entityType: string): SyncEntityScope | undefined;
  /** True for append-only (history) types; false for other and unknown types. */
  isAppendOnly(entityType: string): boolean;
  /** Entity types delivered to every device of a tenant. */
  tenantScopedTypes(): string[];
  /** Author fields of a type (empty when it names no maker). */
  authorFieldsOf(entityType: string): readonly AuthorField[];
  /** The right a maker needs for an authority type, else undefined. */
  authorityOf(entityType: string): AuthorityRight | undefined;
  /** True for types only the server publishes. */
  isServerOnly(entityType: string): boolean;
  readonly size: number;
};

export function loadSyncEntityRegistry(path: string = SYNC_ENTITY_REGISTRY_PATH): SyncEntityRegistry {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read sync entity registry at ${path}: ${(err as Error).message}`);
  }
  const parsed = RegistryFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`sync entity registry ${path} is invalid: ${parsed.error.message}`);
  }
  const scopes = new Map<string, SyncEntityScope>();
  const appendOnly = new Set<string>();
  const authorFields = new Map<string, readonly AuthorField[]>();
  const authority = new Map<string, AuthorityRight>();
  const serverOnly = new Set<string>();
  for (const entry of parsed.data.entity_types) {
    if (scopes.has(entry.entity_type)) {
      throw new Error(`sync entity registry lists '${entry.entity_type}' twice`);
    }
    scopes.set(entry.entity_type, entry.scope);
    if (entry.append_only) appendOnly.add(entry.entity_type);
    if (entry.author_fields && entry.author_fields.length > 0) authorFields.set(entry.entity_type, entry.author_fields);
    if (entry.authority) authority.set(entry.entity_type, entry.authority);
    if (entry.server_only) serverOnly.add(entry.entity_type);
  }
  return {
    version: parsed.data.registry_version,
    scopeOf: (entityType) => scopes.get(entityType),
    isAppendOnly: (entityType) => appendOnly.has(entityType),
    tenantScopedTypes: () => [...scopes].filter(([, scope]) => scope === "tenant").map(([type]) => type),
    authorFieldsOf: (entityType) => authorFields.get(entityType) ?? [],
    authorityOf: (entityType) => authority.get(entityType),
    isServerOnly: (entityType) => serverOnly.has(entityType),
    size: scopes.size,
  };
}
