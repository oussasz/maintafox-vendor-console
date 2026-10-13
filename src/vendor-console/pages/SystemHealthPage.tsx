/**
 * System health (2026 redesign): one green or orange sentence, then Server, Backups, Data sync and
 * App updates in plain words. The technical figures stay one tab away.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePermissions } from "@/hooks/use-permissions";
import { errorText } from "@/lib/error-text";
import { getConsoleHealth, type ConsoleHealth } from "@/services/console-dashboard-service";

import { PlatformHealthOpsPanel } from "../components/PlatformHealthOpsPanel";
import { formatAgo, formatBytes, formatDateTime } from "../ui/format";
import { FactRow, Headline, LoadError, Loading, Notice, PageHeader, Panel, StatusPill } from "../ui/kit";

export function SystemHealthPage() {
  const { t } = useTranslation("vendorConsole");
  const { can } = usePermissions();
  const [data, setData] = useState<ConsoleHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await getConsoleHealth());
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("nav.health")} subtitle={t("sysHealth.subtitle")} />
      <Tabs defaultValue="summary">
        <TabsList aria-label={t("sysHealth.tabsAria")}>
          <TabsTrigger value="summary">{t("sysHealth.tabs.summary")}</TabsTrigger>
          <TabsTrigger value="details">{t("sysHealth.tabs.details")}</TabsTrigger>
        </TabsList>
        <TabsContent value="summary" className="flex flex-col gap-5">
          {error ? <LoadError message={error} onRetry={() => void load()} /> : null}
          {!data && !error ? <Loading /> : null}
          {data ? <HealthSummary data={data} canSeeDevices={can("sync.operate") || can("entitlement.manage")} canSeeUpdates={can("rollout.manage")} /> : null}
        </TabsContent>
        <TabsContent value="details">
          <PlatformHealthOpsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function HealthSummary({ data, canSeeDevices, canSeeUpdates }: { data: ConsoleHealth; canSeeDevices: boolean; canSeeUpdates: boolean }) {
  const { t } = useTranslation("vendorConsole");
  const { server, backups: b, sync, updates } = data;
  const backupsOk = !b.backup_late && b.last_backup_status !== "failed" && !b.restore_test_overdue && b.last_restore_test_status !== "failed";
  const serverOk = server.database.state === "ok" && server.file_storage === "ok";
  const latest = updates.versions.find((v) => v.version !== null) ?? null;
  return (
    <>
      <Headline
        large
        tone={data.status === "ok" ? "ok" : "attention"}
        title={t(data.status === "ok" ? "sysHealth.allOk" : "sysHealth.needsLook")}
        detail={t("sysHealth.checked", { ago: formatAgo(data.checked_at) })}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={t("sysHealth.server")} labelledBy="h-srv" aside={<StatusPill tone={serverOk ? "ok" : "attention"}>{t(serverOk ? "sysHealth.online" : "sysHealth.degraded")}</StatusPill>}>
          <FactRow
            label={t("sysHealth.answering")}
            value={server.database.latency_ms === null ? t("sysHealth.unknown") : t("sysHealth.ms", { ms: server.database.latency_ms })}
          />
          <FactRow label={t("sysHealth.database")} value={t(`sysHealth.dbState.${server.database.state in { ok: 1, slow: 1, down: 1 } ? server.database.state : "unknown"}`)} />
          <FactRow
            label={t("sysHealth.fileStorage")}
            value={t(`sysHealth.storageState.${server.file_storage in { ok: 1, not_configured: 1, unreachable: 1 } ? server.file_storage : "unknown"}`)}
          />
          <FactRow
            label={t("sysHealth.diskFree")}
            value={server.disk_free_bytes === null ? t("sysHealth.unknown") : t("sysHealth.diskOf", { free: formatBytes(server.disk_free_bytes), total: formatBytes(server.disk_total_bytes) })}
          />
        </Panel>

        <Panel title={t("sysHealth.backups")} labelledBy="h-bak" aside={<StatusPill tone={backupsOk ? "ok" : "attention"}>{t(backupsOk ? "sysHealth.protected" : "sysHealth.lookSoon")}</StatusPill>}>
          <FactRow
            label={t("sysHealth.lastBackup")}
            value={b.last_backup_at ? formatDateTime(b.last_backup_at) : t("sysHealth.never")}
          />
          {b.last_backup_status === "failed" ? <Notice tone="danger">{t("sysHealth.lastBackupFailed", { at: formatDateTime(b.last_backup_attempt_at) })}</Notice> : null}
          <FactRow
            label={t("sysHealth.encryptedWithKey")}
            value={b.encrypted === null ? t("sysHealth.unknown") : b.encrypted ? t("machines.yes") : t("machines.no")}
          />
          <FactRow
            label={t("sysHealth.lastRestoreTest")}
            value={
              b.last_restore_test_status === "failed"
                ? t("sysHealth.failed")
                : b.last_restore_test_at
                  ? t("sysHealth.passedOn", { at: formatDateTime(b.last_restore_test_at) })
                  : t("sysHealth.never")
            }
          />
          {b.retention_days !== null ? <FactRow label={t("sysHealth.copiesKept")} value={t("sysHealth.days", { count: b.retention_days })} /> : null}
          {b.offsite === "disabled" ? <Notice tone="attention">{t("sysHealth.onlyOnServer")}</Notice> : null}
          {b.offsite === "failed" ? <Notice tone="danger">{t("sysHealth.offsiteFailed")}</Notice> : null}
        </Panel>

        <Panel
          title={t("sysHealth.sync")}
          labelledBy="h-sync"
          aside={
            <StatusPill tone={sync.devices_up_to_date === sync.devices_total ? "ok" : "attention"}>
              {sync.devices_up_to_date === sync.devices_total ? t("sysHealth.allUpToDate") : t("sysHealth.devicesToCheck", { count: sync.devices_total - sync.devices_up_to_date })}
            </StatusPill>
          }
        >
          <FactRow label={t("sysHealth.devicesUpToDate")} value={t("sysHealth.nOfM", { n: sync.devices_up_to_date, m: sync.devices_total })} />
          <FactRow label={t("sysHealth.refused", { hours: sync.window_hours })} value={sync.refused_not_applied} />
          <FactRow label={t("sysHealth.conflicts", { hours: sync.window_hours })} value={sync.conflicts} />
          {sync.first_device_behind && canSeeDevices ? (
            <Link
              to={`/vendor-console/customers/${encodeURIComponent(sync.first_device_behind.tenant_id)}?tab=sync&device=${encodeURIComponent(sync.first_device_behind.machine_id)}`}
              className="text-sm font-semibold text-primary hover:underline"
            >
              {t("sysHealth.seeBehind")}
            </Link>
          ) : null}
        </Panel>

        <Panel title={t("sysHealth.updates")} labelledBy="h-upd" aside={<StatusPill tone="neutral">{t("sysHealth.versionsInUse", { count: updates.versions.length })}</StatusPill>}>
          {updates.devices_total === 0 ? (
            <p className="text-sm text-text-secondary">{t("sysHealth.noDevices")}</p>
          ) : (
            updates.versions.map((v) => (
              <FactRow
                key={v.version ?? "unknown"}
                label={v.version ? t("sysHealth.version", { version: v.version }) : t("sysHealth.versionUnknown")}
                value={t("sysHealth.devicesCount", { count: v.devices })}
              />
            ))
          )}
          {latest ? <p className="text-[13px] text-text-secondary">{t("sysHealth.releaseCatalogLater")}</p> : null}
          {canSeeUpdates ? (
            <Link to="/vendor-console/updates" className="text-sm font-semibold text-primary hover:underline">
              {t("sysHealth.goToUpdates")}
            </Link>
          ) : null}
        </Panel>
      </div>
    </>
  );
}
