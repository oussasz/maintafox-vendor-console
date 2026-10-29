import forms from "@tailwindcss/forms";
import typography from "@tailwindcss/typography";
import type { Config } from "tailwindcss";

/** A palette colour from globals.css (`--c-<name>`, RGB channels) that keeps opacity modifiers working. */
const c = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        /* ── Shadcn/ui semantic tokens (resolve via CSS custom properties) ── */
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        destructive: {
          DEFAULT: c("destructive"),
          foreground: "var(--destructive-foreground)",
        },
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        /* ── Maintafox palette: RGB channels from src/styles/globals.css, one set per theme ── */
        primary: {
          DEFAULT: c("primary"),
          dark: c("primary-dark"),
          light: c("primary-light"),
          bg: c("primary-bg"),
          foreground: "var(--primary-foreground)",
        },
        accent: {
          DEFAULT: c("accent"),
          dark: c("accent-dark"),
          foreground: "var(--accent-foreground)",
        },
        /* Console redesign: navy sidebar, orange only for "needs attention", green for OK. */
        navy: {
          DEFAULT: c("navy"),
          active: c("navy-active"),
          text: c("navy-text"),
          muted: c("navy-muted"),
        },
        attention: {
          DEFAULT: c("attention"),
          bg: c("attention-bg"),
          text: c("attention-text"),
          strong: c("attention-strong"),
        },
        ok: {
          DEFAULT: c("ok"),
          bg: c("ok-bg"),
          text: c("ok-text"),
          border: c("ok-border"),
        },
        danger: {
          DEFAULT: c("danger"),
          bg: c("danger-bg"),
          border: c("danger-border"),
        },
        status: {
          success: c("status-success"),
          danger: c("status-danger"),
          warning: c("status-warning"),
          info: c("status-info"),
          neutral: c("status-neutral"),
        },
        overlay: c("overlay"),
        surface: {
          0: "var(--surface-0)",
          1: "var(--surface-1)",
          2: "var(--surface-2)",
          3: "var(--surface-3)",
          border: "var(--surface-border)",
        },
        text: {
          primary: "var(--text-primary)",
          secondary: "var(--text-secondary)",
          muted: "var(--text-muted)",
          danger: "var(--text-danger)",
          success: "var(--text-success)",
          warning: "var(--text-warning)",
        },
      },
      fontFamily: {
        sans: [
          '"IBM Plex Sans"',
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          "Roboto",
          "sans-serif",
        ],
        mono: ['"JetBrains Mono"', '"Fira Code"', "ui-monospace", "monospace"],
      },
      fontSize: {
        "2xs": ["0.625rem", { lineHeight: "1rem" }],
        xs: ["0.75rem", { lineHeight: "1rem" }],
        sm: ["0.8125rem", { lineHeight: "1.25rem" }],
        base: ["0.875rem", { lineHeight: "1.5rem" }],
        lg: ["1rem", { lineHeight: "1.5rem" }],
        xl: ["1.125rem", { lineHeight: "1.75rem" }],
        "2xl": ["1.25rem", { lineHeight: "1.75rem" }],
      },
      spacing: {
        sidebar: "240px",
        "sidebar-sm": "64px",
        topbar: "52px",
        statusbar: "24px",
      },
      animation: {
        "fade-in": "fadeIn 120ms ease-in",
        "slide-in": "slideIn 150ms ease-out",
        "spin-slow": "spin 2s linear infinite",
      },
      keyframes: {
        fadeIn: { from: { opacity: "0" }, to: { opacity: "1" } },
        slideIn: {
          from: { transform: "translateX(-8px)", opacity: "0" },
          to: { transform: "translateX(0)", opacity: "1" },
        },
      },
      borderRadius: {
        sm: "4px",
        md: "6px",
        lg: "8px",
        xl: "12px",
      },
      borderColor: {
        DEFAULT: "var(--border)",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        panel: "var(--shadow-panel)",
        focus: "var(--shadow-focus)",
      },
      transitionDuration: {
        fast: "100ms",
        base: "150ms",
        normal: "200ms",
        slow: "300ms",
      },
    },
  },
  plugins: [forms, typography],
} satisfies Config;
