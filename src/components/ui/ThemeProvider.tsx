import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";

export type Theme = "dark" | "light";

/**
 * Where this browser keeps the operator's choice. Light is the default: a missing or unknown value
 * means light. public/theme-init.js reads the same key to set the theme before the first paint.
 * (The earlier key "maintafox:theme:v2" is ignored on purpose: it could hold "dark" from the old
 * console and opened the redesign in a theme it was not built for.)
 */
export const THEME_STORAGE_KEY = "maintafox.console.theme";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readSavedTheme(): Theme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readSavedTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Storage blocked: the theme still applies for this visit.
    }
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
