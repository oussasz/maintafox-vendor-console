import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enAuth from "./en/auth.json";
import enCommon from "./en/common.json";
import frAuth from "./fr/auth.json";
import frCommon from "./fr/common.json";
import enVendor from "./locale-data/en/vendorConsole.json";
import frVendor from "./locale-data/fr/vendorConsole.json";

let initialized = false;

export function initI18n(): void {
  if (initialized) return;
  initialized = true;
  void i18n.use(initReactI18next).init({
    resources: {
      en: { common: enCommon, vendorConsole: enVendor, auth: enAuth },
      fr: { common: frCommon, vendorConsole: frVendor, auth: frAuth },
    },
    lng: "en",
    fallbackLng: "en",
    ns: ["common", "vendorConsole", "auth"],
    defaultNS: "common",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
}

export { i18n };
