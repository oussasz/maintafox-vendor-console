import { Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useTheme, type Theme } from "@/components/ui/ThemeProvider";
import { cn } from "@/lib/utils";

/**
 * Light / Dark switch for the top bar and the sign-in page: an icon and a visible word naming the
 * theme it switches to, so it reads the same to sighted and screen-reader users.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={next === "dark" ? t("theme.switchToDark") : t("theme.switchToLight")}
      title={next === "dark" ? t("theme.switchToDark") : t("theme.switchToLight")}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-lg border border-input bg-surface-1 px-2.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {next === "dark" ? <Moon className="h-4 w-4" aria-hidden /> : <Sun className="h-4 w-4" aria-hidden />}
      <span>{next === "dark" ? t("theme.dark") : t("theme.light")}</span>
    </button>
  );
}

/** The same choice as two radio buttons, for Settings > Display. */
export function ThemeChoice() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-semibold text-text-primary">{t("theme.label")}</legend>
      <div className="flex flex-wrap gap-2.5">
        {(["light", "dark"] as const).map((value) => (
          <label
            key={value}
            className={cn(
              "inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3.5 py-2.5 text-sm text-text-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
              theme === value ? "border-primary bg-primary-bg font-semibold" : "border-input bg-surface-1 hover:bg-surface-3",
            )}
          >
            <input
              type="radio"
              name="console-theme"
              value={value}
              checked={theme === value}
              onChange={() => setTheme(value)}
              className="h-4 w-4 accent-primary"
            />
            {value === "dark" ? <Moon className="h-4 w-4" aria-hidden /> : <Sun className="h-4 w-4" aria-hidden />}
            {t(`theme.${value}`)}
          </label>
        ))}
      </div>
      <p className="text-[13px] text-text-secondary">{t("theme.hint")}</p>
    </fieldset>
  );
}
