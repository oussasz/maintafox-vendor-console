/**
 * Real translations for component tests (English): import this instead of mocking react-i18next,
 * so a test also proves the text it looks for exists in the language files.
 */
import { i18n, initI18n } from "@/i18n/config";

initI18n();
await i18n.changeLanguage("en");
