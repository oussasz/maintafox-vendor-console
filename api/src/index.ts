/**
 * Maintafox control-plane API: email/password JWT, tenants, license lifecycle,
 * and machine activation claims for desktop clients.
 *
 * Startup and middleware live here; the routes are in ./routes, one module per family, registered
 * below in the order they were declared before the split (Phase 3.1).
 */
// First: loads .env before any module reads process.env.
import "dotenv/config";

import cors from "cors";
import express from "express";
import helmet from "helmet";

import { createAuditAppender } from "./app/audit.js";
import {
  DATABASE_URL,
  DEFAULT_JSON_BODY_LIMIT,
  SEED_BEHAVIOR,
  SYNC_EXCHANGE_BODY_LIMIT,
} from "./app/config.js";
import type { ApiContext } from "./app/context.js";
import { createGuards } from "./app/guards.js";
import { corsOptionsDelegate, type AuthRequest } from "./app/http.js";
import { getMediaStore } from "./app/media.js";
import { observabilityWindow } from "./app/observability.js";
import { fatal, forwardAsyncErrors, newId, structuredLog } from "./app/runtime.js";
import { createSeeder } from "./app/seed.js";
import { createTenantStore } from "./app/tenant-store.js";
import { openDatabase, type Database } from "./db/database.js";
import { runMigrations } from "./db/migrate.js";
import { ensureSystemEditionsPresent, repairAllEditionCapabilities, seedEditionCatalogIfEmpty } from "./edition-catalog-store.js";
import { registerActivationRoutes } from "./routes/activation.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerEditionsRoutes } from "./routes/editions.js";
import { registerLicencesRoutes } from "./routes/licences.js";
import { registerOpsRoutes } from "./routes/ops.js";
import { registerReleasesRoutes } from "./routes/releases.js";
import { registerSupportRoutes } from "./routes/support.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { registerTenantsRoutes } from "./routes/tenants.js";
import {
  loadSyncConfig,
  loadSyncEntityRegistry,
  removeStateOutsideTenantScope,
  runSyncRetention,
  type SyncConfig,
  type SyncEntityRegistry,
} from "./sync/index.js";

let syncConfig: SyncConfig;
let syncEntityRegistry: SyncEntityRegistry;
try {
  syncConfig = loadSyncConfig();
  syncEntityRegistry = loadSyncEntityRegistry();
} catch (err) {
  fatal((err as Error).message);
}

let db: Database;
try {
  db = await openDatabase(DATABASE_URL, "maintafox-control-api");
  const migrations = await runMigrations(db, structuredLog);
  structuredLog("schema_migrations_ready", {
    applied_now: migrations.applied,
    previously_applied: migrations.alreadyApplied,
  });
} catch (err) {
  fatal(`database startup failed: ${(err as Error).message}`);
}

{
  const removed = await removeStateOutsideTenantScope(db, syncEntityRegistry.tenantScopedTypes());
  if (removed > 0) {
    structuredLog("sync_state_outside_tenant_scope_removed", { rows: removed });
  }
}

await seedEditionCatalogIfEmpty(db);
await ensureSystemEditionsPresent(db);
await repairAllEditionCapabilities(db);

const audit = createAuditAppender(db);
const { seedAdminIfEmpty, shouldSeedDomainData, seedTenantIfEmpty, seedAuditSupportIfEmpty } = createSeeder(db, audit);
await seedAdminIfEmpty();
if (shouldSeedDomainData()) {
  await seedTenantIfEmpty();
  await seedAuditSupportIfEmpty();
} else {
  console.info(`Seed behavior '${SEED_BEHAVIOR}' active: domain bootstrap seeds are skipped.`);
}

const app = express();
forwardAsyncErrors(app);
// Deployment topology: internet → nginx edge (deploy/nginx-edge.conf) → this API, which is only
// `expose`d inside the compose network. Trusting exactly one hop makes req.ip the real client
// address (last X-Forwarded-For entry appended by nginx) without trusting client-supplied entries.
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
// Sync batches carry up to SYNC_MAX_OUTBOX_BATCH rows; every other route keeps the small default.
// body-parser skips already-parsed bodies, so the route-specific parser must be registered first.
app.use("/api/v1/sync/exchange", express.json({ limit: SYNC_EXCHANGE_BODY_LIMIT }));
app.use(express.json({ limit: DEFAULT_JSON_BODY_LIMIT }));

app.use(cors(corsOptionsDelegate));
app.use((req, res, next) => {
  const requestId = req.header("X-Request-Id")?.trim() || newId("req");
  const startedAt = Date.now();
  res.setHeader("X-Request-Id", requestId);
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    observabilityWindow.request_total += 1;
    if (res.statusCode >= 500) {
      observabilityWindow.request_5xx_total += 1;
    }
    structuredLog("api_request_complete", {
      request_id: requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: durationMs,
      actor_id: (req as AuthRequest).userId ?? null,
      remote_ip: req.ip,
    });
  });
  next();
});

const ctx: ApiContext = {
  db,
  syncConfig,
  syncEntityRegistry,
  ...audit,
  ...createGuards(db, audit),
  ...createTenantStore(db),
};
registerOpsRoutes(app, ctx);
registerAuthRoutes(app, ctx);
registerEditionsRoutes(app, ctx);
registerTenantsRoutes(app, ctx);
registerReleasesRoutes(app, ctx);
registerLicencesRoutes(app, ctx);
registerBillingRoutes(app, ctx);
registerAuditRoutes(app, ctx);
registerSupportRoutes(app, ctx);
registerSyncRoutes(app, ctx);
registerActivationRoutes(app, ctx);

const port = Number(process.env.PORT ?? 3000);

// Last handler: an error thrown or rejected by any route (forwarded by forwardAsyncErrors).
app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  structuredLog("route_unhandled_error", {
    method: req.method,
    path: req.path,
    error: err instanceof Error ? err.message : String(err),
  });
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ error: "internal_error" });
});

/** Sync retention (log compaction + idempotency pruning) every SYNC_RETENTION_INTERVAL_MINUTES. */
const syncRetentionTimer = setInterval(() => {
  runSyncRetention(db, syncConfig)
    .then((report) => structuredLog("sync_retention_run", report))
    .catch((err) => structuredLog("sync_retention_failed", { error: err instanceof Error ? err.message : String(err) }));
}, syncConfig.retentionIntervalMinutes * 60_000);
syncRetentionTimer.unref();

getMediaStore();
app.listen(port, "0.0.0.0", () => {
  structuredLog("control_api_listening", {
    port,
    sync_entity_registry_version: syncEntityRegistry.version,
    sync_entity_types: syncEntityRegistry.size,
  });
  console.log(`control-api listening on ${port}`);
});
