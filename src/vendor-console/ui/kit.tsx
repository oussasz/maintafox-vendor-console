/**
 * Building blocks of the console screens (2026 redesign): page header, white panels, key-figure
 * tiles, status pills, fact rows, empty and error states. Colours come from the palette tokens
 * (tailwind.config.ts: navy, attention, ok, danger); orange is only for "needs attention".
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type Tone = "ok" | "attention" | "danger" | "info" | "neutral";

const pillClass: Record<Tone, string> = {
  ok: "bg-ok-bg text-ok-text",
  attention: "bg-attention-bg text-attention-text",
  danger: "bg-danger-bg text-danger",
  info: "bg-primary-bg text-primary",
  neutral: "bg-surface-3 text-text-secondary",
};

const dotClass: Record<Tone, string> = {
  ok: "bg-ok",
  attention: "bg-attention-strong",
  danger: "bg-danger",
  info: "bg-primary",
  neutral: "bg-text-muted",
};

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-[26px] font-bold leading-tight text-text-primary">{title}</h1>
        {subtitle ? <p className="text-[15px] text-text-secondary">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-3">{actions}</div> : null}
    </header>
  );
}

/** A white card section with an optional heading and something on the right of it. */
export function Panel({
  title,
  aside,
  children,
  className,
  labelledBy,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  labelledBy?: string;
}) {
  return (
    <section
      aria-labelledby={title && labelledBy ? labelledBy : undefined}
      className={cn("flex min-w-0 flex-col gap-3 rounded-xl border border-surface-border bg-surface-1 px-[22px] py-5", className)}
    >
      {title || aside ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {title ? (
            <h2 id={labelledBy} className="text-[17px] font-bold text-text-primary">
              {title}
            </h2>
          ) : (
            <span />
          )}
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function KpiTile({
  label,
  value,
  hint,
  tone = "neutral",
  action,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "neutral" | "attention";
  action?: { label: string; to: string };
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-surface-border bg-surface-1 px-5 py-[18px]">
      <span className="text-[13px] font-medium text-text-secondary">{label}</span>
      <span className={cn("text-[30px] font-bold leading-tight", tone === "attention" ? "text-attention-strong" : "text-text-primary")}>{value}</span>
      {action ? (
        <Link to={action.to} className="text-[13px] font-semibold text-primary hover:underline">
          {action.label}
        </Link>
      ) : hint ? (
        <span className="text-[13px] text-text-secondary">{hint}</span>
      ) : null}
    </div>
  );
}

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={cn("inline-block whitespace-nowrap rounded-full px-2.5 py-[3px] text-xs font-semibold", pillClass[tone])}>{children}</span>;
}

export function Dot({ tone, size = 10 }: { tone: Tone; size?: number }) {
  return <span aria-hidden="true" className={cn("inline-block shrink-0 rounded-full", dotClass[tone])} style={{ width: size, height: size }} />;
}

/** "Label ........ value" line of a panel. */
export function FactRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="text-right font-semibold text-text-primary">{value}</span>
    </div>
  );
}

/** One green or orange sentence summing a state up. */
export function Headline({ tone, title, detail, large = false }: { tone: "ok" | "attention"; title: ReactNode; detail?: ReactNode; large?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3.5 border",
        large ? "rounded-xl px-[22px] py-[18px]" : "rounded-lg px-3.5 py-3",
        tone === "ok" ? "border-ok-border bg-ok-bg text-ok-text" : "border-attention/40 bg-attention-bg text-attention-text",
      )}
      role="status"
    >
      <Dot tone={tone} size={large ? 14 : 10} />
      <div className="flex flex-col gap-0.5">
        <span className={cn("font-bold", large ? "text-[17px]" : "text-sm")}>{title}</span>
        {detail ? <span className="text-sm">{detail}</span> : null}
      </div>
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: ReactNode; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-surface-border bg-surface-0 px-5 py-6">
      <p className="text-[15px] font-semibold text-text-primary">{title}</p>
      {body ? <p className="text-sm text-text-secondary">{body}</p> : null}
      {action}
    </div>
  );
}

/** A failure the operator can act on: one sentence and a retry. */
export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger-border bg-danger-bg px-5 py-4" role="alert">
      <p className="text-sm font-medium text-danger">{message}</p>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t("action.retry")}
        </Button>
      ) : null}
    </div>
  );
}

export function Loading() {
  const { t } = useTranslation();
  return (
    <p className="py-6 text-sm text-text-secondary" role="status">
      {t("app.loading")}
    </p>
  );
}

export function Notice({ tone, children }: { tone: "ok" | "attention" | "danger" | "info"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-lg px-3.5 py-2.5 text-[13px]",
        tone === "ok" && "bg-ok-bg text-ok-text",
        tone === "attention" && "bg-attention-bg text-attention-text",
        tone === "danger" && "bg-danger-bg text-danger",
        tone === "info" && "bg-primary-bg text-text-primary",
      )}
      role={tone === "danger" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
