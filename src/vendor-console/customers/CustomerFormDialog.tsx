/**
 * New customer, or edit the details of one: company name, code (slug), edition, update channel and
 * rollout group. Fields are checked before sending; a taken code is shown on its field.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiRequestError } from "@/lib/api-error";
import { errorText } from "@/lib/error-text";
import {
  createTenant,
  listEditions,
  updateTenant,
  type ControlTenant,
  type EditionCatalogEntry,
  type EditionId,
} from "@/services/license-control-service";

import { Notice } from "../ui/kit";

type Channel = "stable" | "pilot" | "internal";
type Form = { slug: string; display_name: string; rollout_cohort: string; update_channel: Channel; edition: EditionId };
type Errors = Partial<Record<keyof Form, string>>;

/** Values a new customer starts with (the default edition, channel and rollout group of the API). */
const NEW_CUSTOMER: Form = { slug: "", display_name: "", rollout_cohort: "stable-main", update_channel: "stable", edition: "core" };
const CHANNELS: Channel[] = ["stable", "pilot", "internal"];
const selectClass = "h-11 w-full rounded-lg border border-input bg-surface-1 pl-3 pr-9 text-sm text-text-primary";

/** Field problems as translation keys (vendorConsole `customers.validation.*`). */
function validate(form: Form): Errors {
  const errors: Errors = {};
  const slug = form.slug.trim();
  const name = form.display_name.trim();
  const cohort = form.rollout_cohort.trim();
  if (!slug) errors.slug = "customers.validation.slugRequired";
  else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) errors.slug = "customers.validation.slugFormat";
  else if (slug.length < 3 || slug.length > 64) errors.slug = "customers.validation.slugLength";
  if (!name) errors.display_name = "customers.validation.nameRequired";
  else if (name.length < 2 || name.length > 120) errors.display_name = "customers.validation.nameLength";
  if (!cohort) errors.rollout_cohort = "customers.validation.cohortRequired";
  else if (cohort.length > 64) errors.rollout_cohort = "customers.validation.cohortLength";
  return errors;
}

function fromTenant(tenant: ControlTenant): Form {
  return {
    slug: tenant.slug,
    display_name: tenant.display_name,
    rollout_cohort: tenant.rollout_cohort ?? NEW_CUSTOMER.rollout_cohort,
    update_channel: (tenant.update_channel ?? NEW_CUSTOMER.update_channel) as Channel,
    edition: (tenant.edition ?? NEW_CUSTOMER.edition) as EditionId,
  };
}

export function CustomerFormDialog({
  open,
  tenant,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** The customer being edited; absent for a new customer. */
  tenant?: ControlTenant | null;
  onClose: () => void;
  onSaved: (saved: ControlTenant) => void;
}) {
  const { t } = useTranslation("vendorConsole");
  const editing = Boolean(tenant);
  const [form, setForm] = useState<Form>(NEW_CUSTOMER);
  const [editions, setEditions] = useState<EditionCatalogEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugTaken, setSlugTaken] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(tenant ? fromTenant(tenant) : NEW_CUSTOMER);
    setError(null);
    setSlugTaken(null);
    setTouched(false);
    listEditions()
      .then(setEditions)
      .catch((err: unknown) => setError(errorText(err)));
  }, [open, tenant]);

  const errors = useMemo(() => validate(form), [form]);
  const valid = Object.keys(errors).length === 0;
  const fieldError = (key: keyof Form) => (touched && errors[key] ? t(errors[key] as string) : null);

  const save = async () => {
    setTouched(true);
    if (!valid) return;
    setSaving(true);
    setError(null);
    setSlugTaken(null);
    const body = {
      slug: form.slug.trim(),
      display_name: form.display_name.trim(),
      rollout_cohort: form.rollout_cohort.trim(),
      update_channel: form.update_channel,
      edition: form.edition,
    };
    try {
      onSaved(tenant ? await updateTenant(tenant.id, body) : await createTenant(body));
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "tenant_conflict") setSlugTaken(errorText(err));
      else setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? t("customers.editCompany") : t("customers.addCompany")}</DialogTitle>
          <DialogDescription>{editing ? t("customers.editDescription") : t("customers.form.newBody")}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="customer-name">{t("customers.companyName")}</Label>
            <Input
              id="customer-name"
              value={form.display_name}
              onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))}
              aria-invalid={Boolean(fieldError("display_name"))}
            />
            {fieldError("display_name") ? <p className="text-xs text-danger">{fieldError("display_name")}</p> : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="customer-slug">{t("customers.tenantSlug")}</Label>
            <Input
              id="customer-slug"
              value={form.slug}
              placeholder="acme-industries"
              onChange={(e) => {
                setSlugTaken(null);
                setForm((f) => ({ ...f, slug: e.target.value.replace(/\s+/g, "-").toLowerCase() }));
              }}
              aria-invalid={Boolean(fieldError("slug") ?? slugTaken)}
            />
            <p className="text-xs text-text-secondary">{t("customers.form.slugHint")}</p>
            {fieldError("slug") || slugTaken ? <p className="text-xs text-danger">{fieldError("slug") ?? slugTaken}</p> : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="customer-edition">{t("customers.edition")}</Label>
              <select
                id="customer-edition"
                className={selectClass}
                value={form.edition}
                onChange={(e) => setForm((f) => ({ ...f, edition: e.target.value as EditionId }))}
              >
                {editions.map((ed) => (
                  <option key={ed.id} value={ed.id}>
                    {ed.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="customer-channel">{t("customers.columns.channel")}</Label>
              <select
                id="customer-channel"
                className={selectClass}
                value={form.update_channel}
                onChange={(e) => setForm((f) => ({ ...f, update_channel: e.target.value as Channel }))}
              >
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {t(`customers.form.channels.${c}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="customer-cohort">{t("customers.cohort")}</Label>
            <Input
              id="customer-cohort"
              value={form.rollout_cohort}
              onChange={(e) => setForm((f) => ({ ...f, rollout_cohort: e.target.value }))}
              aria-invalid={Boolean(fieldError("rollout_cohort"))}
            />
            <p className="text-xs text-text-secondary">{t("customers.form.cohortHint")}</p>
            {fieldError("rollout_cohort") ? <p className="text-xs text-danger">{fieldError("rollout_cohort")}</p> : null}
          </div>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              {t("operatorAction.cancel")}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? (editing ? t("customers.savingTenant") : t("customers.creatingTenant")) : editing ? t("customers.saveChanges") : t("customers.addCompany")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
