/**
 * Release catalog: every desktop version the release workflow uploaded, where it is published
 * (ring + rollout percentage), its notes and its files. Publishing or widening needs an audit
 * reason and an authenticator code (step-up rollout_publish); a recall, forced_rollback.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePermissions } from "@/hooks/use-permissions";
import { errorText } from "@/lib/error-text";
import { StepUpKinds } from "@/lib/step-up-kinds";
import {
  listReleases,
  publishRelease,
  recallRelease,
  RELEASE_NOTES_MAX_LENGTH,
  RELEASE_RINGS,
  releaseStatus,
  ringsAllowedFrom,
  ROLLOUT_PERCENT_MAX,
  ROLLOUT_PERCENT_MIN,
  updateReleaseNotes,
  type Release,
  type ReleaseRing,
  type ReleaseStatus,
} from "@/services/release-catalog-service";

import { OperatorActionDialog } from "../components/OperatorActionDialog";
import { useVendorConsole } from "../VendorConsoleContext";
import { formatBytes, formatDate, formatDateTime } from "../ui/format";
import { EmptyState, FactRow, Loading, LoadError, Notice, Panel, StatusPill, type Tone } from "../ui/kit";

/** Quick choices for the rollout percentage (any whole number between the bounds is accepted). */
const ROLLOUT_PRESETS = [10, 25, 50, 100] as const;

const STATUS_TONE: Record<ReleaseStatus, Tone> = {
  uploading: "neutral",
  draft: "neutral",
  internal: "info",
  pilot: "info",
  stable: "ok",
  recalled: "danger",
};

export function ReleaseCatalogPanel() {
  const { t } = useTranslation("vendorConsole");
  const { can } = usePermissions();
  const canManage = can("rollout.manage");
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<Release | null>(null);
  const [recalling, setRecalling] = useState<Release | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setReleases(await listReleases());
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = (next: Release) => setReleases((list) => (list ? list.map((r) => (r.release_id === next.release_id ? next : r)) : list));

  return (
    <Panel
      title={t("updates.releases.title")}
      labelledBy="release-catalog-h"
      aside={
        <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
          {t("updates.releases.refresh")}
        </Button>
      }
    >
      <p className="text-[13px] text-text-secondary">{t("updates.releases.intro")}</p>
      <ul className="grid gap-1 text-[13px] text-text-secondary">
        {RELEASE_RINGS.map((ring) => (
          <li key={ring}>
            <span className="font-semibold text-text-primary">{t(`updates.releases.status.${ring}`)}</span> — {t(`updates.releases.rings.${ring}`)}
          </li>
        ))}
      </ul>
      {!canManage ? <Notice tone="info">{t("updates.releases.readOnly")}</Notice> : null}
      {success ? <Notice tone="ok">{success}</Notice> : null}
      {error ? <LoadError message={error} onRetry={() => void load()} /> : null}
      {releases === null && !error ? <Loading /> : null}
      {releases && releases.length === 0 ? <EmptyState title={t("updates.releases.empty")} body={t("updates.releases.emptyBody")} /> : null}
      {releases && releases.length > 0 ? (
        <ul className="flex flex-col gap-3" aria-label={t("updates.releases.listAria")}>
          {releases.map((r) => (
            <ReleaseRow
              key={r.release_id}
              release={r}
              open={openId === r.release_id}
              canManage={canManage}
              onToggle={() => setOpenId((id) => (id === r.release_id ? null : r.release_id))}
              onPublish={() => setPublishing(r)}
              onRecall={() => setRecalling(r)}
              onNotesSaved={(next) => {
                replace(next);
                setSuccess(t("updates.releases.notes.saved", { version: next.version }));
              }}
            />
          ))}
        </ul>
      ) : null}
      <PublishDialog
        release={publishing}
        onClose={() => setPublishing(null)}
        onPublished={(next) => {
          replace(next);
          setSuccess(t("updates.releases.publish.done", { version: next.version, ring: t(`updates.releases.status.${releaseStatus(next)}`), percent: next.rollout_percent }));
        }}
      />
      <RecallDialog
        release={recalling}
        onClose={() => setRecalling(null)}
        onRecalled={(next) => {
          replace(next);
          setSuccess(t("updates.releases.recall.done", { version: next.version }));
        }}
      />
    </Panel>
  );
}

/** Why a release cannot be published now, or null when it can. */
function publishBlocker(r: Release): "uploading" | "recalled" | null {
  if (r.recalled_at) return "recalled";
  if (r.state === "uploading") return "uploading";
  return null;
}

function ReleaseRow({
  release: r,
  open,
  canManage,
  onToggle,
  onPublish,
  onRecall,
  onNotesSaved,
}: {
  release: Release;
  open: boolean;
  canManage: boolean;
  onToggle: () => void;
  onPublish: () => void;
  onRecall: () => void;
  onNotesSaved: (next: Release) => void;
}) {
  const { t } = useTranslation("vendorConsole");
  const status = releaseStatus(r);
  const blocker = publishBlocker(r);
  const detailId = `release-detail-${r.release_id}`;
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-surface-border p-4" data-testid={`release-${r.version}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-[15px] font-bold text-text-primary">{t("updates.releases.version", { version: r.version })}</span>
          <StatusPill tone={STATUS_TONE[status]}>{t(`updates.releases.status.${status}`)}</StatusPill>
          {r.channel && !r.recalled_at ? (
            <span className="text-[13px] text-text-secondary">{t("updates.releases.percentOfRing", { percent: r.rollout_percent })}</span>
          ) : null}
          {!r.code_signed ? <StatusPill tone="attention">{t("updates.releases.unsigned")}</StatusPill> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" aria-expanded={open} aria-controls={detailId} onClick={onToggle}>
            {open ? t("updates.releases.hideDetails") : t("updates.releases.showDetails")}
          </Button>
          {canManage ? (
            <Button
              type="button"
              size="sm"
              disabled={blocker !== null}
              title={blocker ? t(`updates.releases.publish.blocked.${blocker}`) : undefined}
              onClick={onPublish}
            >
              {r.channel ? t("updates.releases.publish.widen") : t("updates.releases.publish.action")}
            </Button>
          ) : null}
          {canManage && blocker === null ? (
            <Button type="button" size="sm" variant="destructive" onClick={onRecall}>
              {t("updates.releases.recall.action")}
            </Button>
          ) : null}
        </div>
      </div>
      {!r.code_signed ? <p className="text-[13px] text-attention-text">{t("updates.releases.unsignedHelp")}</p> : null}
      {canManage && blocker ? <p className="text-[13px] text-text-secondary">{t(`updates.releases.publish.blocked.${blocker}`)}</p> : null}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-text-secondary">
        <span>
          {r.published_at ? t("updates.releases.publishedAt", { date: formatDate(r.published_at) }) : t("updates.releases.notPublished")}
        </span>
        <span>{t("updates.releases.files", { count: r.artifacts.length })}</span>
      </div>
      {r.recalled_at ? (
        <Notice tone="danger">
          {t("updates.releases.recalledInfo", { date: formatDateTime(r.recalled_at), by: r.recalled_by ?? "—", reason: r.recalled_reason ?? "—" })}
        </Notice>
      ) : null}
      {open ? (
        <div id={detailId} className="flex flex-col gap-4 border-t border-surface-border pt-3">
          <div className="grid gap-1.5 sm:max-w-md">
            <FactRow label={t("updates.releases.gitCommit")} value={<code className="font-mono text-xs">{r.git_commit}</code>} />
            <FactRow label={t("updates.releases.registeredBy")} value={r.registered_by} />
            <FactRow label={t("updates.releases.registeredAt")} value={formatDateTime(r.registered_at)} />
          </div>
          <ArtifactTable release={r} />
          <NotesEditor release={r} canManage={canManage} onSaved={onNotesSaved} />
        </div>
      ) : null}
    </li>
  );
}

function ArtifactTable({ release }: { release: Release }) {
  const { t } = useTranslation("vendorConsole");
  if (release.artifacts.length === 0) return <p className="text-[13px] text-text-secondary">{t("updates.releases.artifacts.none")}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <caption className="pb-2 text-left text-sm font-semibold text-text-primary">{t("updates.releases.artifacts.title")}</caption>
        <thead className="text-text-secondary">
          <tr>
            <th className="py-1 pr-4 font-medium">{t("updates.releases.artifacts.platform")}</th>
            <th className="py-1 pr-4 font-medium">{t("updates.releases.artifacts.file")}</th>
            <th className="py-1 pr-4 font-medium">{t("updates.releases.artifacts.size")}</th>
            <th className="py-1 pr-4 font-medium">{t("updates.releases.artifacts.verified")}</th>
          </tr>
        </thead>
        <tbody>
          {release.artifacts.map((a) => (
            <tr key={`${a.target}-${a.arch}`} className="border-t border-surface-border align-top">
              <td className="py-1.5 pr-4">
                {a.target} / {a.arch}
              </td>
              <td className="py-1.5 pr-4">
                <span className="break-all">{a.file_name}</span>
                <span className="block break-all font-mono text-[11px] text-text-muted" title={t("updates.releases.artifacts.sha256")}>
                  {a.sha256}
                </span>
              </td>
              <td className="py-1.5 pr-4 whitespace-nowrap">{formatBytes(a.byte_size)}</td>
              <td className="py-1.5 pr-4">
                {a.verified_at ? (
                  <StatusPill tone="ok">{t("updates.releases.artifacts.verifiedAt", { date: formatDate(a.verified_at) })}</StatusPill>
                ) : (
                  <StatusPill tone="neutral">{t("updates.releases.artifacts.notVerified")}</StatusPill>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NotesEditor({ release, canManage, onSaved }: { release: Release; canManage: boolean; onSaved: (next: Release) => void }) {
  const { t } = useTranslation("vendorConsole");
  const [en, setEn] = useState(release.notes_en);
  const [fr, setFr] = useState(release.notes_fr);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEn(release.notes_en);
    setFr(release.notes_fr);
  }, [release.notes_en, release.notes_fr]);

  const changed = en.trim() !== release.notes_en.trim() || fr.trim() !== release.notes_fr.trim();
  const valid = en.trim().length > 0 && fr.trim().length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await updateReleaseNotes(release.release_id, { notes_en: en.trim(), notes_fr: fr.trim() }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const idEn = `notes-en-${release.release_id}`;
  const idFr = `notes-fr-${release.release_id}`;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-semibold text-text-primary">{t("updates.releases.notes.title")}</p>
      <p className="text-[13px] text-text-secondary">{t("updates.releases.notes.help")}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={idEn}>{t("updates.releases.notes.en")}</Label>
          <Textarea id={idEn} rows={6} maxLength={RELEASE_NOTES_MAX_LENGTH} readOnly={!canManage} value={en} onChange={(e) => setEn(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={idFr}>{t("updates.releases.notes.fr")}</Label>
          <Textarea id={idFr} rows={6} maxLength={RELEASE_NOTES_MAX_LENGTH} readOnly={!canManage} value={fr} onChange={(e) => setFr(e.target.value)} />
        </div>
      </div>
      {!valid ? <p className="text-[13px] text-text-secondary">{t("updates.releases.notes.required")}</p> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {canManage ? (
        <div>
          <Button type="button" size="sm" disabled={busy || !changed || !valid} onClick={() => void save()}>
            {busy ? t("updates.releases.notes.saving") : t("updates.releases.notes.save")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PublishDialog({ release, onClose, onPublished }: { release: Release | null; onClose: () => void; onPublished: (next: Release) => void }) {
  const { t } = useTranslation("vendorConsole");
  const { requireStepUp } = useVendorConsole();
  const [ring, setRing] = useState<ReleaseRing>(RELEASE_RINGS[0]);
  const [percentText, setPercentText] = useState("");

  useEffect(() => {
    if (!release) return;
    setRing(release.channel ?? RELEASE_RINGS[0]);
    setPercentText(String(release.rollout_percent));
  }, [release]);

  const percent = /^\d{1,3}$/.test(percentText.trim()) ? Number(percentText.trim()) : NaN;
  const percentOk = Number.isInteger(percent) && percent >= ROLLOUT_PERCENT_MIN && percent <= ROLLOUT_PERCENT_MAX;
  const unchanged = release !== null && release.channel === ring && release.rollout_percent === percent;

  const confirm = async (reason: string) => {
    if (!release) return;
    const stepUpToken = await requireStepUp(StepUpKinds.rolloutPublish);
    onPublished(await publishRelease(release.release_id, { channel: ring, rollout_percent: percent }, { reason_code: reason, step_up_token: stepUpToken }));
  };

  const ringLabel = t(`updates.releases.status.${ring}`);
  return (
    <OperatorActionDialog
      open={release !== null}
      title={release ? t("updates.releases.publish.title", { version: release.version }) : ""}
      description={t("updates.releases.publish.body")}
      confirmLabel={t("updates.releases.publish.confirm")}
      extraValid={percentOk && !unchanged}
      onConfirm={confirm}
      onClose={onClose}
    >
      {release ? (
        <>
          <fieldset className="grid gap-2">
            <legend className="pb-1 text-sm font-medium text-text-primary">{t("updates.releases.publish.ringLabel")}</legend>
            {ringsAllowedFrom(release.channel).map((r) => (
              <label key={r} className="flex cursor-pointer items-start gap-2 rounded-lg border border-surface-border p-2.5 text-sm">
                <input type="radio" name="release-ring" className="mt-1" value={r} checked={ring === r} onChange={() => setRing(r)} />
                <span>
                  <span className="font-semibold text-text-primary">{t(`updates.releases.status.${r}`)}</span>
                  <span className="block text-[13px] text-text-secondary">{t(`updates.releases.rings.${r}`)}</span>
                </span>
              </label>
            ))}
            {release.channel ? <p className="text-[13px] text-text-secondary">{t("updates.releases.publish.noNarrowing")}</p> : null}
          </fieldset>
          <div className="grid gap-1.5">
            <Label htmlFor="release-rollout-percent">{t("updates.releases.publish.percentLabel")}</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="release-rollout-percent"
                className="w-24"
                inputMode="numeric"
                autoComplete="off"
                value={percentText}
                onChange={(e) => setPercentText(e.target.value)}
              />
              {ROLLOUT_PRESETS.map((p) => (
                <Button key={p} type="button" size="sm" variant={percent === p ? "default" : "outline"} onClick={() => setPercentText(String(p))}>
                  {t("updates.releases.publish.preset", { percent: p })}
                </Button>
              ))}
            </div>
            <p className="text-[13px] text-text-secondary">{t("updates.releases.publish.percentHelp", { ring: ringLabel })}</p>
            {!percentOk ? (
              <p className="text-[13px] text-danger">{t("updates.releases.publish.percentInvalid", { min: ROLLOUT_PERCENT_MIN, max: ROLLOUT_PERCENT_MAX })}</p>
            ) : null}
            {percentOk && unchanged ? <p className="text-[13px] text-text-secondary">{t("updates.releases.publish.unchanged")}</p> : null}
          </div>
          {!release.code_signed ? <Notice tone="attention">{t("updates.releases.unsignedHelp")}</Notice> : null}
        </>
      ) : null}
    </OperatorActionDialog>
  );
}

function RecallDialog({ release, onClose, onRecalled }: { release: Release | null; onClose: () => void; onRecalled: (next: Release) => void }) {
  const { t } = useTranslation("vendorConsole");
  const { requireStepUp } = useVendorConsole();
  const confirm = async (reason: string) => {
    if (!release) return;
    const stepUpToken = await requireStepUp(StepUpKinds.forcedRollback);
    onRecalled(await recallRelease(release.release_id, { reason_code: reason, step_up_token: stepUpToken }));
  };
  return (
    <OperatorActionDialog
      open={release !== null}
      title={release ? t("updates.releases.recall.title", { version: release.version }) : ""}
      description={t("updates.releases.recall.body")}
      confirmLabel={t("updates.releases.recall.confirm")}
      destructive
      onConfirm={confirm}
      onClose={onClose}
    />
  );
}
