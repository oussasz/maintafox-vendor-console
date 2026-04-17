import type { ReactNode } from "react";

type BannerTone = "error" | "success" | "info" | "warning";

const toneClass: Record<BannerTone, string> = {
  error: "border-red-500/40 bg-red-500/10 text-red-200",
  success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  info: "border-surface-border bg-surface-2 text-text-secondary",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-200",
};

export function ConsoleStatusBanner({
  tone,
  children,
  role = "status",
}: {
  tone: BannerTone;
  children: ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${toneClass[tone]}`} role={role}>
      {children}
    </div>
  );
}
