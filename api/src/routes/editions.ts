/**
 * Edition catalog (capability sets that licences are issued against).
 */
import type express from "express";
import { z } from "zod";

import type { ApiContext } from "../app/context.js";
import { resolveActorId, sendValidationError } from "../app/http.js";
import { EditionIdSchema } from "../app/schemas.js";
import { EditionCatalogError, createEdition, deleteEdition, getEdition, listEditions, updateEdition } from "../edition-catalog-store.js";
import { CapabilitiesMapSchema, EditionSlugSchema, SYSTEM_EDITION_IDS } from "../edition-catalog.js";

const CreateEditionBody = z
  .object({
    id: EditionSlugSchema,
    label: z.string().trim().min(2).max(128),
    capabilities: CapabilitiesMapSchema,
    clone_from: EditionIdSchema.optional(),
  })
  .strict();

const UpdateEditionBody = z
  .object({
    label: z.string().trim().min(2).max(128).optional(),
    capabilities: CapabilitiesMapSchema,
    expected_row_version: z.number().int().min(1),
  })
  .strict();

function editionCatalogHttpError(err: unknown, res: express.Response): boolean {
  if (!(err instanceof EditionCatalogError)) return false;
  const status =
    err.code === "edition_not_found"
      ? 404
      : err.code === "edition_version_conflict" ||
          err.code === "edition_in_use" ||
          err.code === "edition_id_taken"
        ? 409
        : err.code === "edition_system_immutable" || err.code === "edition_id_invalid"
          ? 400
          : err.code === "catalog_schema_invalid"
            ? 500
            : 400;
  res.status(status).json({ error: err.code, message: err.message, ...(err.details ?? {}) });
  return true;
}

export function registerEditionsRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, authMiddleware, appendAuditRecord } = ctx;

  app.get("/api/v1/editions", authMiddleware, async (_req, res) => {
    res.json({ items: await listEditions(db) });
  });

  app.post("/api/v1/editions", authMiddleware, async (req, res) => {
    const parsed = CreateEditionBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    if (SYSTEM_EDITION_IDS.includes(parsed.data.id as (typeof SYSTEM_EDITION_IDS)[number])) {
      res.status(400).json({
        error: "edition_system_immutable",
        message: "Cannot create an edition that overwrites a system id; clone with a different id.",
      });
      return;
    }
    try {
      let capabilities = parsed.data.capabilities;
      if (parsed.data.clone_from) {
        const source = await getEdition(db, parsed.data.clone_from);
        if (!source) {
          res.status(400).json({ error: "edition_not_found", message: `clone_from '${parsed.data.clone_from}' not found` });
          return;
        }
        // Body capabilities still required (strict full map); clone_from is a UI convenience hint only when equal.
        void source;
        capabilities = parsed.data.capabilities;
      }
      const created = await createEdition(db, {
        id: parsed.data.id,
        label: parsed.data.label,
        capabilities,
        actorId: resolveActorId(req),
      });
      await appendAuditRecord({
        actor_id: resolveActorId(req),
        action_code: "edition_catalog_create",
        action_category: "entitlement",
        correlation_id: `edition-create-${created.id}`,
        payload: { edition_id: created.id, label: created.label },
      });
      res.status(201).json(created);
    } catch (err) {
      if (editionCatalogHttpError(err, res)) return;
      throw err;
    }
  });

  app.patch("/api/v1/editions/:editionId", authMiddleware, async (req, res) => {
    const editionId = req.params.editionId;
    const parsed = UpdateEditionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const ifMatch = req.header("if-match");
    let expected = parsed.data.expected_row_version;
    if (ifMatch) {
      const n = Number.parseInt(ifMatch.replace(/"/g, ""), 10);
      if (Number.isFinite(n)) expected = n;
    }
    try {
      const updated = await updateEdition(db, editionId, {
        label: parsed.data.label,
        capabilities: parsed.data.capabilities,
        expected_row_version: expected,
        actorId: resolveActorId(req),
      });
      await appendAuditRecord({
        actor_id: resolveActorId(req),
        action_code: "edition_catalog_update",
        action_category: "entitlement",
        correlation_id: `edition-update-${editionId}-${updated.row_version}`,
        payload: {
          edition_id: editionId,
          row_version: updated.row_version,
          label: updated.label,
        },
      });
      res.json(updated);
    } catch (err) {
      if (editionCatalogHttpError(err, res)) return;
      throw err;
    }
  });

  app.delete("/api/v1/editions/:editionId", authMiddleware, async (req, res) => {
    const editionId = req.params.editionId;
    try {
      await deleteEdition(db, editionId);
      await appendAuditRecord({
        actor_id: resolveActorId(req),
        action_code: "edition_catalog_delete",
        action_category: "entitlement",
        correlation_id: `edition-delete-${editionId}`,
        payload: { edition_id: editionId },
      });
      res.status(204).send();
    } catch (err) {
      if (editionCatalogHttpError(err, res)) return;
      throw err;
    }
  });
}
