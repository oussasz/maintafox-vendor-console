/** Everything a route family needs that is bound to the running API (database, sync settings). */
import type { Database } from "../db/database.js";
import type { PayloadCipher, SyncConfig, SyncEntityRegistry } from "../sync/index.js";
import type { AuditAppender } from "./audit.js";
import type { Guards } from "./guards.js";
import type { VendorAuth } from "../vendor-auth/service.js";
import type { TenantStore } from "./tenant-store.js";

export type ApiContext = {
  db: Database;
  syncConfig: SyncConfig;
  syncEntityRegistry: SyncEntityRegistry;
  /** Encryption at rest of sensitive sync payloads and stored exchange responses. */
  payloadCipher: PayloadCipher;
  /** Operator sessions, second factor and recovery codes (Phase 4.1). */
  vendorAuth: VendorAuth;
} & AuditAppender &
  Guards &
  TenantStore;
