// The server's sync entity registry against the committed desktop snapshot, in `pnpm test` (no
// desktop checkout needed). A change to either side that is not mirrored on the other fails here
// or in the cross-repository check (sync-registry-drift.mjs, which also catches a stale snapshot).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareServerToDesktop } from "./sync-registry-compare.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const server = readJson(join(here, "../../../shared/sync-entity-registry.v2.json"));
const snapshot = readJson(join(here, "../desktop-sync-registry.snapshot.json"));

describe("sync entity registry vs desktop snapshot", () => {
  it("has the desktop's types, scopes and append_only flags", () => {
    expect(compareServerToDesktop(server, snapshot)).toEqual([]);
  });

  it("keeps the desktop's append-only history types append-only on the server", () => {
    const appendOnly = server.entity_types.filter((e) => e.append_only).map((e) => e.entity_type);
    for (const type of ["di_review_events", "work_order_verifications", "schedule_break_ins"]) {
      expect(appendOnly).toContain(type);
    }
  });

  it("reports a flipped append_only flag, a scope change and a missing type", () => {
    const drifted = structuredClone(server);
    drifted.entity_types.find((e) => e.entity_type === "work_order_verifications").append_only = false;
    drifted.entity_types.find((e) => e.entity_type === "articles").scope = "user";
    drifted.entity_types = drifted.entity_types.filter((e) => e.entity_type !== "schedule_break_ins");
    const problems = compareServerToDesktop(drifted, snapshot).join("\n");
    expect(problems).toMatch(/work_order_verifications: append_only false on the server/);
    expect(problems).toMatch(/articles: scope user on the server, tenant on the desktop/);
    expect(problems).toMatch(/schedule_break_ins: staged by the desktop, missing from the server registry/);
  });

  it("reports a type listed twice on either side", () => {
    const dupServer = structuredClone(server);
    dupServer.entity_types.push({ ...dupServer.entity_types[0] });
    expect(compareServerToDesktop(dupServer, snapshot).join("\n")).toMatch(/listed twice in the server registry/);
    const dupSnapshot = structuredClone(snapshot);
    dupSnapshot.entity_types.push({ ...dupSnapshot.entity_types[0], append_only: !dupSnapshot.entity_types[0].append_only });
    expect(compareServerToDesktop(server, dupSnapshot).join("\n")).toMatch(/listed twice in the desktop registry/);
  });
});
