import type { ReactNode } from "react";

type BannerTone = "error" | "success" | "info" | "warning";

const toneClass: Record<BannerTone, string> = {
  error: "border-danger-border bg-danger-bg text-danger",
  success: "border-ok-border bg-ok-bg text-ok-text",
  info: "border-surface-border bg-primary-bg text-text-primary",
  warning: "border-attention/40 bg-attention-bg text-attention-text",
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
    <div className={`rounded-lg border px-3.5 py-2.5 text-sm ${toneClass[tone]}`} role={role}>
      {children}
    </div>
  );
}
