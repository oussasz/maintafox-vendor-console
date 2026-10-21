# Console languages (Phase 4.7)

The console is available in **English** and **French**. The operator picks the language with the
selector on the sign-in page and in the top bar; the choice is remembered in that browser
(`localStorage` key `maintafox.console.language`). Without a remembered choice the console uses
the browser's language when it is French, otherwise English.

**Where texts live.** Every text is in the JSON files: `src/i18n/locale-data/{en,fr}/vendorConsole.json`
(console pages), `src/i18n/{en,fr}/auth.json` (sign-in), `src/i18n/{en,fr}/common.json` (shared
labels, error messages). Components never carry English: `src/i18n/__tests__/translations.test.ts`
fails the build when

- EN and FR do not have the same keys, or a text's `{{variables}}` differ between them;
- a component calls `t()` with a key that does not exist, or with an English fallback;
- a component contains English text (JSX text, `title` / `placeholder` / `aria-label` / `label`
  values, sentences in code, sentences in template strings).

Codes and identifiers shown as such (`stable`, `INC-2026-042`, `1.8.0`) are not texts.

**Errors.** Services throw `ApiRequestError` (status, the API's `error` code, its message;
`src/lib/api-error.ts`). `errorText(err)` (`src/lib/error-text.ts`) shows a known code in the
operator's language (`common.json` `errors.codes.*`, step-up refusals `errors.guard.*`), otherwise
the server's own explanation as sent (English: server messages are not translated). A lost
connection, an unreadable answer and an ended session have their own texts.

**Adding a text.** Add the key to both EN and FR files, use `t("key")`. Adding a language: a new
folder per file above, the code in `SUPPORTED_LANGUAGES` (`src/i18n/config.ts`) and its name in
`common.json` `language.names`.

## Behaviour changes made with the translation work

- Revoking a licence key now needs a reason (it is the audit reason sent to the server); the
  console used to send a fixed English sentence when the field was empty.
- Editing a key no longer pre-fills the audit rationale with a fixed sentence; the operator writes it.
- "Extend grace" and "Toggle trust-revoke disconnect" (Machines) now ask for a reason in a dialog
  before the authenticator code; they used to send the fixed reason `offline-policy-change`.

## Deploy checklist

Console image only (no API or database change). Rebuild and restart the console; open it, switch
to Français in the top bar, check a page. Rollback: previous console image.
