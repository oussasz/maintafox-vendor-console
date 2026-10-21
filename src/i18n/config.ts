import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enAuth from "./en/auth.json";
import enCommon from "./en/common.json";
import frAuth from "./fr/auth.json";
import frCommon from "./fr/common.json";
import enVendor from "./locale-data/en/vendorConsole.json";
import frVendor from "./locale-data/fr/vendorConsole.json";

/** Languages the console ships (every text exists in each: src/i18n/__tests__/translations.test.ts). */
export const SUPPORTED_LANGUAGES = ["en", "fr"] as const;
export type ConsoleLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Where this browser remembers the operator's choice (a per-browser convenience, not an account setting). */
const LANGUAGE_STORAGE_KEY = "maintafox.console.language";

function isSupported(value: string | null | undefined): value is ConsoleLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value ?? "");
}

function rememberedLanguage(): ConsoleLanguage | null {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isSupported(stored) ? stored : null;
  } catch {
    // Storage blocked (private window, policy): the browser language decides.
    return null;
  }
}

/** The operator's last choice in this browser, else the browser's language when the console has it, else English. */
export function initialLanguage(): ConsoleLanguage {
  const remembered = rememberedLanguage();
  if (remembered) return remembered;
  const browser = typeof navigator !== "undefined" ? navigator.language.slice(0, 2).toLowerCase() : "";
  return isSupported(browser) ? browser : "en";
}

/** Switches the console's language and remembers it in this browser. */
export async function setConsoleLanguage(language: ConsoleLanguage): Promise<void> {
  await i18n.changeLanguage(language);
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Storage blocked: the choice lasts until the page is reloaded.
  }
}

let initialized = false;

export function initI18n(): void {
  if (initialized) return;
  initialized = true;
  i18n.on("languageChanged", (language) => {
    if (typeof document !== "undefined") document.documentElement.lang = language;
  });
  void i18n.use(initReactI18next).init({
    resources: {
      en: { common: enCommon, vendorConsole: enVendor, auth: enAuth },
      fr: { common: frCommon, vendorConsole: frVendor, auth: frAuth },
    },
    lng: initialLanguage(),
    fallbackLng: "en",
    supportedLngs: [...SUPPORTED_LANGUAGES],
    ns: ["common", "vendorConsole", "auth"],
    defaultNS: "common",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
}

export { i18n };
