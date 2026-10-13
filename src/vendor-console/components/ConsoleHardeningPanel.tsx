import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  listIncidentRunbooks,
  listReadinessChecks,
  type IncidentRunbookEntry,
  type ReadinessCheckItem,
} from "@/services/vendor-audit-support-service";

import { STEP_UP_KIND_NAMES } from "@/lib/step-up-kinds";

import { ConsoleStatusBanner } from "./ConsoleStatusBanner";
import { errorText } from "@/lib/error-text";

export function ConsoleHardeningPanel() {
  const { t } = useTranslation("vendorConsole");
  const [runbooks, setRunbooks] = useState<IncidentRunbookEntry[]>([]);
  const [readiness, setReadiness] = useState<ReadinessCheckItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [rb, checks] = await Promise.all([listIncidentRunbooks(), listReadinessChecks()]);
      setRunbooks(rb);
      setReadiness(checks);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="space-y-6">
      <p className="text-sm text-text-secondary">
        {t("audit.harden.intro")}
      </p>
      {error ? (
        <ConsoleStatusBanner tone="error" role="alert">
          {error}
        </ConsoleStatusBanner>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("audit.harden.guards.title")}</CardTitle>
          <CardDescription>{t("audit.harden.guards.body")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ul className="grid gap-1 text-sm sm:grid-cols-2" aria-label={t("audit.harden.guards.kindsAria")}>
            {STEP_UP_KIND_NAMES.map((kind) => (
              <li key={kind} className="flex gap-2">
                <span className="font-mono text-xs text-text-muted">{kind}</span>
                <span className="text-text-secondary">{t(`stepUp.kinds.${kind}`)}</span>
              </li>
            ))}
          </ul>
          <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
            {t("audit.harden.guards.refresh")}
          </Button>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">{t("audit.harden.runbooks.title")}</h3>
        <div className="grid gap-3 md:grid-cols-2">
          {runbooks.length === 0 ? (
            <Card className="md:col-span-2">
              <CardContent className="py-6 text-center text-sm text-text-muted">
                {loading
                  ? t("audit.harden.runbooks.loading")
                  : t("audit.harden.runbooks.empty")}
              </CardContent>
            </Card>
          ) : null}
          {runbooks.map((rb) => (
            <Card key={rb.runbook_id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{rb.title}</CardTitle>
                <CardDescription>{rb.summary}</CardDescription>
              </CardHeader>
              <CardContent>
                <ol className="list-inside list-decimal text-xs text-text-secondary">
                  {rb.first_steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("audit.harden.readiness.title")}</h3>
        <ul className="space-y-2">
          {readiness.length === 0 ? (
            <li className="rounded-md border border-surface-border bg-surface-1 px-3 py-2 text-sm text-text-muted">
              {loading
                ? t("audit.harden.readiness.loading")
                : t("audit.harden.readiness.empty")}
            </li>
          ) : null}
          {readiness.map((item) => (
            <li
              key={item.code}
              className="flex items-start justify-between gap-3 rounded-md border border-surface-border bg-surface-1 px-3 py-2 text-sm"
            >
              <div>
                <p className="font-mono text-xs text-text-muted">{item.code}</p>
                <p className="text-xs text-text-secondary">{item.description}</p>
              </div>
              <span className={item.passed ? "text-ok" : "text-attention-text"}>
                {item.passed ? t("audit.harden.readiness.pass") : t("audit.harden.readiness.gap")}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
