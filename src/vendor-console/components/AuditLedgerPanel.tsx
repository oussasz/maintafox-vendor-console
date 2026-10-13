import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import auditCategoryCatalog from "@shared/audit-action-categories.v1.json";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  downloadAuditLedgerCsv,
  listAuditLedger,
  type AuditRecord,
  verifyAuditLedgerChainRemote,
} from "@/services/vendor-audit-support-service";
import { ConsoleStatusBanner } from "./ConsoleStatusBanner";
import { errorText } from "@/lib/error-text";

/** Ledger categories (shared with the API, which refuses records in any other one). */
const CATEGORIES: string[] = auditCategoryCatalog.categories.map((c) => c.category);
const KNOWN_CATEGORIES = new Set(CATEGORIES);

export function AuditLedgerPanel({ scopeQuery }: { /** Only records matching this (e.g. a customer id), for the History tab of a customer. */ scopeQuery?: string } = {}) {
  const { t } = useTranslation("vendorConsole");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [detail, setDetail] = useState<AuditRecord | null>(null);
  const [chainStatus, setChainStatus] = useState<"idle" | "ok" | "fail" | "checking">("idle");
  const [rows, setRows] = useState<AuditRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRows = async () => {
    setLoading(true);
    setError(null);
    try {
      const out = await listAuditLedger({
        q: scopeQuery ?? (query.trim() || undefined),
        category,
        limit: 500,
      });
      setRows(out);
      if (detail && !out.some((r) => r.record_id === detail.record_id)) {
        setDetail(null);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => {
      void loadRows();
    }, 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, category]);

  const runChainVerify = async () => {
    setChainStatus("checking");
    try {
      const r = await verifyAuditLedgerChainRemote();
      setChainStatus(r.status === "ok" ? "ok" : "fail");
    } catch {
      setChainStatus("fail");
    }
  };

  const onExport = async () => {
    setError(null);
    try {
      const blob = await downloadAuditLedgerCsv();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "audit-ledger.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">
        {t("audit.ledger.intro")}
      </p>

      <div className="flex flex-wrap items-end gap-3">
        {scopeQuery ? null : (
        <div className="flex flex-col gap-1">
          <Label className="text-xs">{t("audit.ledger.search")}</Label>
          <Input
            className="h-9 w-56 font-mono text-xs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("audit.ledger.searchPh")}
          />
        </div>
        )}
        <div className="flex flex-col gap-1">
          <Label className="text-xs">{t("audit.ledger.category")}</Label>
          <Select
            value={category}
            onValueChange={setCategory}
          >
            <SelectTrigger className="h-9 w-48 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("audit.ledger.filter.all")}</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {t(`audit.ledger.categories.${c}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="button" size="sm" variant="secondary" onClick={() => void runChainVerify()}>
          {t("audit.ledger.verifyChain")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void onExport()}>
          {t("audit.ledger.export")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void loadRows()}>
          {t("audit.ledger.refresh")}
        </Button>
        {chainStatus === "checking" ? (
          <span className="text-xs text-text-muted">{t("audit.ledger.checking")}</span>
        ) : null}
        {chainStatus === "ok" ? (
          <span className="text-xs text-ok">{t("audit.ledger.chainOk")}</span>
        ) : null}
        {chainStatus === "fail" ? (
          <span className="text-xs text-destructive">{t("audit.ledger.chainFail")}</span>
        ) : null}
      </div>
      {error ? (
        <ConsoleStatusBanner tone="error" role="alert">
          {error}
        </ConsoleStatusBanner>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-surface-border">
        <table className="w-full min-w-[960px] text-left text-sm">
          <thead className="border-b border-surface-border bg-surface-2 text-xs uppercase text-text-muted">
            <tr>
              <th className="px-3 py-2">{t("audit.ledger.col.seq")}</th>
              <th className="px-3 py-2">{t("audit.ledger.col.when")}</th>
              <th className="px-3 py-2">{t("audit.ledger.col.actor")}</th>
              <th className="px-3 py-2">{t("audit.ledger.col.action")}</th>
              <th className="px-3 py-2">{t("audit.ledger.col.category")}</th>
              <th className="px-3 py-2">{t("audit.ledger.col.integrity")}</th>
              <th className="px-3 py-2">{t("audit.ledger.col.drill")}</th>
            </tr>
          </thead>
          <tbody>
              {rows.length === 0 ? (
                <tr className="border-b border-surface-border last:border-0">
                  <td colSpan={7} className="px-3 py-4 text-center text-sm text-text-muted">
                    {loading
                      ? t("audit.ledger.loading")
                      : t("audit.ledger.empty")}
                  </td>
                </tr>
              ) : null}
              {rows.map((row) => (
                <tr key={row.record_id} className="border-b border-surface-border last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{row.sequence}</td>
                  <td className="px-3 py-2 text-xs">{row.occurred_at_rfc3339}</td>
                  <td className="px-3 py-2 font-mono text-xs">{row.actor_id}</td>
                  <td className="px-3 py-2 font-mono text-xs">{row.action_code}</td>
                  <td className="px-3 py-2 text-xs">
                    {KNOWN_CATEGORIES.has(row.action_category) ? t(`audit.ledger.categories.${row.action_category}`) : row.action_category}
                  </td>
                  <td className="px-3 py-2 font-mono text-[10px] text-text-muted">
                    {row.record_integrity_sha256.slice(0, 12)}…
                  </td>
                  <td className="px-3 py-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => setDetail(row)}>
                      {t("audit.ledger.open")}
                    </Button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Sheet open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{t("audit.ledger.detail.title")}</SheetTitle>
            <SheetDescription className="font-mono text-xs">{detail?.record_id}</SheetDescription>
          </SheetHeader>
          {detail ? (
            <div className="mt-4 space-y-3 text-xs">
              <div>
                <p className="text-text-muted">{t("audit.ledger.detail.correlation")}</p>
                <p className="font-mono">{detail.correlation_id}</p>
              </div>
              <div>
                <p className="text-text-muted">{t("audit.ledger.detail.reason")}</p>
                <p>
                  {detail.reason_code ?? "—"} · {detail.approval_correlation_id ?? "—"}
                </p>
              </div>
              <div>
                <p className="text-text-muted">{t("audit.ledger.detail.snapshots")}</p>
                <p className="break-all font-mono text-[10px]">{detail.before_snapshot_sha256 ?? "—"}</p>
                <p className="break-all font-mono text-[10px]">{detail.after_snapshot_sha256 ?? "—"}</p>
              </div>
              <div>
                <p className="text-text-muted">{t("audit.ledger.detail.chainPrev")}</p>
                <p className="break-all font-mono text-[10px]">{detail.chain_prev_hash ?? "—"}</p>
              </div>
              <div>
                <p className="text-text-muted">{t("audit.ledger.detail.refs")}</p>
                <ul className="mt-1 list-inside list-disc font-mono">
                  {detail.entity_refs.tenant_id ? <li>tenant: {detail.entity_refs.tenant_id}</li> : null}
                  {detail.entity_refs.entitlement_id ? <li>entitlement: {detail.entity_refs.entitlement_id}</li> : null}
                  {detail.entity_refs.machine_id ? <li>machine: {detail.entity_refs.machine_id}</li> : null}
                  {detail.entity_refs.sync_batch_id ? <li>sync_batch: {detail.entity_refs.sync_batch_id}</li> : null}
                  {detail.entity_refs.release_id ? <li>release: {detail.entity_refs.release_id}</li> : null}
                  {detail.entity_refs.incident_id ? <li>incident: {detail.entity_refs.incident_id}</li> : null}
                  {detail.entity_refs.support_ticket_id ? (
                    <li>support_ticket: {detail.entity_refs.support_ticket_id}</li>
                  ) : null}
                </ul>
              </div>
              <div>
                <p className="text-text-muted">{t("audit.ledger.detail.severityHint")}</p>
                <p className="text-text-secondary">{t("audit.ledger.detail.severityNotProvided")}</p>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
