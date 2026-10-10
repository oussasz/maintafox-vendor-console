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
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type SyncEntityRegistry = {
  readonly version: number;
  scopeOf(entityType: string): SyncEntityScope | undefined;
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
  for (const entry of parsed.data.entity_types) {
    if (scopes.has(entry.entity_type)) {
      throw new Error(`sync entity registry lists '${entry.entity_type}' twice`);
    }
    scopes.set(entry.entity_type, entry.scope);
  }
  return {
    version: parsed.data.registry_version,
    scopeOf: (entityType) => scopes.get(entityType),
    size: scopes.size,
  };
}
