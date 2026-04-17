import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const token = process.env.BEARER_TOKEN;
const outputDir = process.env.OUTPUT_DIR ?? `./sprint9-baseline-${new Date().toISOString().replace(/[:.]/g, "")}`;
const sampleCount = Number(process.env.SAMPLES ?? "60");
const sampleIntervalMs = Number(process.env.INTERVAL_MS ?? "2000");

if (!token) {
  console.error("Set BEARER_TOKEN for an authenticated control-plane admin user.");
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

const rows = [];

for (let i = 0; i < sampleCount; i += 1) {
  const started = Date.now();
  const res = await fetch(`${baseUrl}/api/v1/ops/observability/slo`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const body = await res.json();
  const latencyMs = Date.now() - started;
  rows.push({
    ts: new Date().toISOString(),
    status: res.status,
    latency_ms: latencyMs,
    api_availability_percent: body?.api_health?.availability_percent ?? null,
    auth_p95_ms: body?.auth_latency_ms?.p95 ?? null,
    activation_success_rate_percent: body?.activation_claims?.success_rate_percent ?? null,
    activation_failure_reasons: JSON.stringify(body?.activation_claims?.failures_by_reason ?? []),
    sync_stale_ratio_percent: body?.sync_operator_surface?.stale_ratio_percent ?? null,
    sync_dead_letter_total: body?.sync_operator_surface?.dead_letter_total ?? null,
  });
  if (i < sampleCount - 1) {
    await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs));
  }
}

const header = Object.keys(rows[0] ?? { ts: "", status: "", latency_ms: "" });
const csv = [
  header.join(","),
  ...rows.map((row) =>
    header
      .map((k) => `"${String(row[k] ?? "").replaceAll(`"`, `""`)}"`)
      .join(","),
  ),
].join("\n");

writeFileSync(join(outputDir, "slo_baseline.csv"), csv, "utf8");
writeFileSync(join(outputDir, "slo_baseline.json"), JSON.stringify(rows, null, 2), "utf8");
console.log(`Wrote ${rows.length} samples to ${outputDir}`);
