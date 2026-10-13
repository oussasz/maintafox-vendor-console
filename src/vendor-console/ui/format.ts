/**
 * Dates, durations and sizes in the operator's language (Intl, current i18next language).
 */
import i18n from "i18next";

const lang = () => i18n.resolvedLanguage ?? i18n.language ?? "en";

/** 12 Oct 2026 / 12 oct. 2026 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(lang(), { day: "numeric", month: "short", year: "numeric" }).format(d);
}

/** 12 Oct 2026, 02:30 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : new Intl.DateTimeFormat(lang(), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

/** "4 minutes ago", "il y a 3 jours" */
export function formatAgo(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const seconds = Math.round((ms - nowMs) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang(), { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86_400), "day");
}

/** 12.4 GB */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${new Intl.NumberFormat(lang(), { maximumFractionDigits: v >= 100 || i === 0 ? 0 : 1 }).format(v)} ${units[i]}`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat(lang()).format(n);
}
