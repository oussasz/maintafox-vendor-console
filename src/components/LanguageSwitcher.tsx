import i18n from "i18next";
import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";

import { setConsoleLanguage, SUPPORTED_LANGUAGES, type ConsoleLanguage } from "@/i18n/config";
import { cn } from "@/lib/utils";

/** Language of the console (English / Français), on the sign-in page and in the top bar. */
export function LanguageSwitcher({ className }: { className?: string }) {
  // useTranslation re-renders this on a language change; the language itself is read from the instance.
  const { t } = useTranslation();
  const current = (SUPPORTED_LANGUAGES as readonly string[]).includes(i18n.resolvedLanguage ?? "")
    ? (i18n.resolvedLanguage as ConsoleLanguage)
    : "en";
  return (
    <label className={cn("inline-flex items-center gap-1 text-xs text-text-secondary", className)}>
      <Languages className="h-4 w-4" aria-hidden />
      <span className="sr-only">{t("language.label")}</span>
      <select
        className="h-8 rounded-md border border-surface-border bg-surface-1 px-2 text-xs text-text-primary"
        value={current}
        onChange={(e) => void setConsoleLanguage(e.target.value as ConsoleLanguage)}
      >
        {SUPPORTED_LANGUAGES.map((language) => (
          <option key={language} value={language} lang={language}>
            {t(`language.names.${language}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
