import type { SyncHealthSeverityV1 } from "@shared/ipc-types";

import { Badge } from "@/components/ui/badge";

export function opsSeverityBadgeVariant(
  s: SyncHealthSeverityV1,
): "default" | "secondary" | "destructive" | "outline" {
  if (s === "critical") return "destructive";
  if (s === "warn") return "secondary";
  return "outline";
}

export function OpsSeverityBadge({
  severity,
  label,
}: {
  severity: SyncHealthSeverityV1;
  label?: string;
}) {
  return (
    <Badge variant={opsSeverityBadgeVariant(severity)}>{label ?? severity}</Badge>
  );
}
