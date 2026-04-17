import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

interface VendorConsoleSectionPageProps {
  titleKey: string;
  titleDefault: string;
  bodyKey: string;
  bodyDefault: string;
}

export function VendorConsoleSectionPage({
  titleKey,
  titleDefault,
  bodyKey,
  bodyDefault,
}: VendorConsoleSectionPageProps) {
  const { t } = useTranslation("vendorConsole");
  const [params] = useSearchParams();
  const evidence = params.get("evidence");
  const q = params.get("q");

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">{t(titleKey, titleDefault)}</h1>
      <p className="text-sm text-text-secondary">{t(bodyKey, bodyDefault)}</p>
      {(evidence || q) && (
        <div
          className="rounded-md border border-surface-border bg-surface-1 p-3 text-sm"
          role="region"
          aria-label={t("section.evidenceAria", "Active evidence context")}
        >
          <p className="font-medium text-text-primary">{t("section.evidenceLabel", "Evidence context")}</p>
          <ul className="mt-2 list-inside list-disc text-xs text-text-secondary">
            {q ? <li>{`q=${q}`}</li> : null}
            {evidence ? <li>{`evidence=${evidence}`}</li> : null}
          </ul>
        </div>
      )}
    </div>
  );
}
