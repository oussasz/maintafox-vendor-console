/**
 * Every text/background pair of the console, in both themes, against WCAG 2.2 AA: 4.5:1 for text,
 * 3:1 for field borders, focus rings and status marks (1.4.3, 1.4.11). The values are read from
 * src/styles/globals.css itself, so a token changed there without checking fails here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const CSS = readFileSync(resolve(__dirname, "../globals.css"), "utf8").replace(/\r\n/g, "\n");

type Rgb = [number, number, number];

/** The custom properties declared in the first block whose selector list is exactly `selector`. */
function block(selector: string): Map<string, string> {
  const at = CSS.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`globals.css has no block for ${selector}`);
  const body = CSS.slice(CSS.indexOf("{", at) + 1, CSS.indexOf("\n}", at));
  const vars = new Map<string, string>();
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(m[1], m[2].trim());
  return vars;
}

function resolveColor(vars: Map<string, string>, name: string): Rgb {
  const raw = vars.get(name);
  if (raw === undefined) throw new Error(`${name} is not defined`);
  const ref = /^var\((--[\w-]+)\)$/.exec(raw);
  if (ref) return resolveColor(vars, ref[1]);
  const rgbVar = /^rgb\(var\((--[\w-]+)\)\)$/.exec(raw);
  if (rgbVar) return resolveColor(vars, rgbVar[1]);
  const hex = /^#([0-9a-f]{6})$/i.exec(raw);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as Rgb;
  const channels = /^(\d{1,3}) (\d{1,3}) (\d{1,3})$/.exec(raw);
  if (channels) return [Number(channels[1]), Number(channels[2]), Number(channels[3])];
  throw new Error(`${name}: cannot read colour "${raw}"`);
}

const luminance = ([r, g, b]: Rgb) => {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const ratio = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** `fg` at `alpha` over `bg` (a Tailwind `/20` tint). */
const mix = (fg: Rgb, bg: Rgb, alpha: number) => fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha))) as Rgb;

const TEXT = 4.5;
const UI = 3;

/** [foreground, background, minimum, tint of the background colour or 1] — what the components actually pair. */
const PAIRS: [string, string, number, number?][] = [
  // Body text on the ground, cards, table headers and hovered rows.
  ...["--text-primary", "--text-secondary", "--text-muted"].flatMap(
    (fg) => ["--surface-0", "--surface-1", "--surface-2", "--surface-3"].map((bg) => [fg, bg, TEXT] as [string, string, number]),
  ),
  ["--text-danger", "--surface-1", TEXT],
  ["--text-success", "--surface-1", TEXT],
  ["--text-warning", "--surface-1", TEXT],
  // Links and the primary button.
  ["--c-primary", "--surface-0", TEXT],
  ["--c-primary", "--surface-1", TEXT],
  ["--c-primary", "--c-primary-bg", TEXT],
  ["--c-primary-fg", "--c-primary", TEXT],
  ["--c-primary-fg", "--c-primary-dark", TEXT],
  ["--text-primary", "--c-primary-bg", TEXT],
  // Dangerous actions and errors.
  ["--c-destructive-fg", "--c-destructive", TEXT],
  ["--c-danger", "--surface-1", TEXT],
  ["--c-danger", "--c-danger-bg", TEXT],
  // Status pills, alerts and notices.
  ["--c-attention-text", "--c-attention-bg", TEXT],
  ["--c-attention-text", "--surface-1", TEXT],
  ["--c-attention-strong", "--surface-1", TEXT],
  ["--text-primary", "--c-attention-bg", TEXT],
  ["--c-ok-text", "--c-ok-bg", TEXT],
  ["--c-ok-text", "--surface-1", TEXT],
  ["--c-ok", "--surface-1", TEXT],
  ["--c-accent-foreground-check", "--c-accent", TEXT],
  // Older pages: .badge-* is the status colour on a 20 % tint of itself.
  ["--c-status-success", "--surface-1", TEXT, 0.2],
  ["--c-status-danger", "--surface-1", TEXT, 0.2],
  ["--c-status-info", "--surface-1", TEXT, 0.2],
  ["--c-status-danger", "--surface-1", TEXT],
  ["--c-status-neutral", "--surface-1", TEXT],
  // Navy sidebar (dark in both themes).
  ["--c-navy-text", "--c-navy", TEXT],
  ["--c-navy-muted", "--c-navy", TEXT],
  ["--c-navy-text", "--c-navy-active", TEXT],
  ["--c-navy-muted", "--c-navy-active", TEXT],
  // Non-text: field and outline-button borders, focus ring, status dots and the attention bar.
  ["--input", "--surface-1", UI],
  ["--input", "--surface-0", UI],
  ["--ring", "--surface-1", UI],
  ["--ring", "--surface-0", UI],
  // Status dots inside their pills (ui/kit.tsx StatusPill).
  ["--c-ok", "--c-ok-bg", UI],
  ["--c-attention-strong", "--c-attention-bg", UI],
  ["--c-danger", "--c-danger-bg", UI],
  ["--c-primary", "--c-primary-bg", UI],
  ["--text-muted", "--surface-3", UI],
];

for (const [theme, selector] of [
  ["light", ":root,\n.light"],
  ["dark", ".dark"],
] as const) {
  describe(`${theme} theme`, () => {
    const vars = block(selector);
    // The accent (amber) is always read with the fixed --accent-foreground.
    vars.set("--c-accent-foreground-check", vars.get("--accent-foreground") ?? "");

    it.each(PAIRS)("%s on %s reaches %s:1", (fg, bg, min, tint) => {
      const back = resolveColor(vars, bg);
      const front = resolveColor(vars, fg);
      const ground = tint !== undefined ? mix(front, back, tint) : back;
      expect(Number(ratio(front, ground).toFixed(2))).toBeGreaterThanOrEqual(min);
    });

    it("defines every palette colour Tailwind uses", () => {
      const config = readFileSync(resolve(__dirname, "../../../tailwind.config.ts"), "utf8");
      for (const m of config.matchAll(/c\("([\w-]+)"\)/g)) expect(vars.has(`--c-${m[1]}`), `--c-${m[1]}`).toBe(true);
    });
  });
}

describe("theme defaults", () => {
  it("makes :root the light theme, so a page without a theme class is never half dark", () => {
    expect(block(":root,\n.light").get("--surface-1")).toBe("#ffffff");
    expect(block(".dark").get("--surface-1")).not.toBe("#ffffff");
  });
});
