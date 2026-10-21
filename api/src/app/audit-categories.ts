/**
 * Audit ledger categories. Source of truth: `shared/audit-action-categories.v1.json` at the
 * repository root (copied into the API image at /app/shared, read by the console too). Loaded and
 * checked at startup; a record with another category is refused (a programming error, not data).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

export const AUDIT_CATEGORIES_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../shared/audit-action-categories.v1.json");

const CatalogFile = z
  .object({
    version: z.literal(1),
    description: z.string(),
    categories: z
      .array(
        z
          .object({
            category: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
            in_desktop_contract: z.boolean(),
            description: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

function loadCatalog(path: string): readonly string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read audit category catalog at ${path}: ${(err as Error).message}`);
  }
  const parsed = CatalogFile.safeParse(raw);
  if (!parsed.success) throw new Error(`audit category catalog ${path} is invalid: ${parsed.error.message}`);
  const seen = new Set<string>();
  for (const entry of parsed.data.categories) {
    if (seen.has(entry.category)) throw new Error(`audit category catalog lists '${entry.category}' twice`);
    seen.add(entry.category);
  }
  return [...seen];
}

/** Every category a ledger record may have. */
export const AUDIT_ACTION_CATEGORIES: readonly string[] = loadCatalog(AUDIT_CATEGORIES_PATH);
const KNOWN = new Set(AUDIT_ACTION_CATEGORIES);

export function isAuditActionCategory(value: string): boolean {
  return KNOWN.has(value);
}
