import { useTranslation } from "react-i18next";

import type { SignedClaimPreviewV1 } from "@maintafox/contracts";

import { Badge } from "@/components/ui/badge";

export interface SignedClaimPreviewCardProps {
  preview: SignedClaimPreviewV1;
}

/** Read-only signed-envelope preview before activation (payload digests, not raw secrets). */
export function SignedClaimPreviewCard({ preview }: SignedClaimPreviewCardProps) {
  const { t } = useTranslation("vendorConsole");

  return (
    <section
      className="rounded-lg border border-surface-border bg-surface-1 p-4"
      aria-labelledby="signed-claim-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="signed-claim-heading" className="text-sm font-semibold text-text-primary">
          {t("preview.title")}
        </h2>
        <Badge variant="outline">{t("preview.schema", { v: preview.schema_version })}</Badge>
      </div>
      <p className="mt-1 text-xs text-text-secondary">
        {t("preview.hint")}
      </p>
      <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-text-muted">{t("preview.tenant")}</dt>
          <dd className="font-mono text-xs">{preview.tenant_id}</dd>
        </div>
        <div>
          <dt className="text-text-muted">{t("preview.tier")}</dt>
          <dd>{preview.tier}</dd>
        </div>
        <div>
          <dt className="text-text-muted">{t("preview.slots")}</dt>
          <dd>{preview.machine_slots}</dd>
        </div>
        <div>
          <dt className="text-text-muted">{t("preview.channel")}</dt>
          <dd className="uppercase">{preview.update_channel}</dd>
        </div>
        <div>
          <dt className="text-text-muted">{t("preview.grace")}</dt>
          <dd>{preview.offline_grace_hours}</dd>
        </div>
        <div>
          <dt className="text-text-muted">{t("preview.valid")}</dt>
          <dd className="text-xs">
            {preview.valid_from_rfc3339} → {preview.valid_until_rfc3339}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-text-muted">{t("preview.payload")}</dt>
          <dd className="break-all font-mono text-xs">{preview.payload_sha256}</dd>
        </div>
        <div>
          <dt className="text-text-muted">{t("preview.issuer")}</dt>
          <dd className="font-mono text-xs">
            {preview.issuer} / {preview.key_id}
          </dd>
        </div>
        <div>
          <dt className="text-text-muted">{t("preview.sig")}</dt>
          <dd className="font-mono text-xs">{preview.signature_alg}</dd>
        </div>
      </dl>
    </section>
  );
}
