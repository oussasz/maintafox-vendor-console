/**
 * Prometheus text exposition format 0.0.4 (also read by OpenMetrics scrapers), for
 * GET /api/v1/ops/metrics.
 */
export type MetricSample = { labels?: Record<string, string>; value: number };
export type MetricFamily = { name: string; help: string; type: "gauge" | "counter"; samples: MetricSample[] };

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatValue(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "+Inf";
  if (v === -Infinity) return "-Inf";
  return String(v);
}

export function renderPrometheus(families: MetricFamily[]): string {
  const lines: string[] = [];
  for (const f of families) {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(f.name)) throw new Error(`invalid metric name ${f.name}`);
    lines.push(`# HELP ${f.name} ${f.help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`);
    lines.push(`# TYPE ${f.name} ${f.type}`);
    for (const s of f.samples) {
      const entries = Object.entries(s.labels ?? {});
      const labels = entries.length
        ? `{${entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",")}}`
        : "";
      lines.push(`${f.name}${labels} ${formatValue(s.value)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
