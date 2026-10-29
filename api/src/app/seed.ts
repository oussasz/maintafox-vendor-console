/**
 * First-boot seeds (SEED_BEHAVIOR): the first vendor admin and, in "full" mode, a default tenant.
 * Support data (tickets, bundles, runbooks) is never seeded: it comes from operators and devices
 * (standard runbooks: app/runbooks.ts).
 */
import bcrypt from "bcryptjs";

import type { Database } from "../db/database.js";
import { SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_BEHAVIOR } from "./config.js";
import { newId } from "./runtime.js";

export function createSeeder(db: Database) {
  async function seedAdminIfEmpty(): Promise<void> {
    if (SEED_BEHAVIOR === "disabled") return;
    const row = await db.get("SELECT id FROM users LIMIT 1");
    if (row) return;
    if (!SEED_ADMIN_EMAIL || !SEED_ADMIN_PASSWORD || SEED_ADMIN_PASSWORD.length < 8) {
      console.warn(
        "No users and SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD missing (or password < 8 chars) — " +
          "set both to seed the first vendor admin, or create the user via SQL.",
      );
      return;
    }
    const hash = bcrypt.hashSync(SEED_ADMIN_PASSWORD, 12);
    // The first operator is the owner: the one who manages every other operator (Phase 4.3).
    await db.run("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'owner')", SEED_ADMIN_EMAIL, hash);
    console.info(`Seeded admin user: ${SEED_ADMIN_EMAIL}`);
  }

  function shouldSeedDomainData(): boolean {
    return SEED_BEHAVIOR === "full";
  }

  async function seedTenantIfEmpty(): Promise<void> {
    const row = await db.get("SELECT id FROM tenants LIMIT 1");
    if (row) return;
    await db.run("INSERT INTO tenants (id, slug, display_name) VALUES (?, ?, ?)", newId("tenant"), "default", "Default tenant");
    console.info("Seeded default tenant");
  }

  return { seedAdminIfEmpty, shouldSeedDomainData, seedTenantIfEmpty };
}
