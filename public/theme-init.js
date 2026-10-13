/*
 * Applies the console theme before the first paint (no flash of the wrong theme).
 * Light is the default; "dark" only when this browser chose it in the console.
 * Kept in sync with src/components/ui/ThemeProvider.tsx (THEME_STORAGE_KEY).
 * A plain script file, not inline, so a strict Content-Security-Policy (script-src 'self') allows it.
 */
/* global window, document */
(function () {
  var theme = "light";
  try {
    if (window.localStorage.getItem("maintafox.console.theme") === "dark") theme = "dark";
  } catch {
    /* Storage blocked (private mode, policy): stay light. */
  }
  var root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(theme);
})();
