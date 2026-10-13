// @vitest-environment node
/**
 * Every text the console shows comes from the EN/FR JSON files (French is selectable):
 * - EN and FR have the same keys and the same {{variables}} in each text;
 * - every literal key passed to t() exists in both languages;
 * - no t() call carries an English fallback (t("key", "text") or defaultValue: "text");
 * - no English text written straight in the components (JSX text, user-facing attributes, sentences
 *   in code). Codes and identifiers shown as such (stable, acme-industries, INC-2026-042) are allowed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
const SRC = join(ROOT, "src");
const LOCALES = {
  vendorConsole: (l: string) => join(SRC, "i18n", "locale-data", l, "vendorConsole.json"),
  auth: (l: string) => join(SRC, "i18n", l, "auth.json"),
  common: (l: string) => join(SRC, "i18n", l, "common.json"),
} as const;
type Ns = keyof typeof LOCALES;
const LANGS = ["en", "fr"] as const;

function flatten(obj: Record<string, unknown>, prefix = "", out = new Map<string, string>()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && typeof v === "object") flatten(v as Record<string, unknown>, `${prefix}${k}.`, out);
    else out.set(`${prefix}${k}`, String(v));
  }
  return out;
}
const texts = Object.fromEntries(
  LANGS.map((l) => [
    l,
    Object.fromEntries((Object.keys(LOCALES) as Ns[]).map((ns) => [ns, flatten(JSON.parse(readFileSync(LOCALES[ns](l), "utf8")))])),
  ]),
) as Record<(typeof LANGS)[number], Record<Ns, Map<string, string>>>;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "__tests__" && e.name !== "test") out.push(...sourceFiles(p, []));
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Attributes whose value a user reads or a screen reader speaks. */
const USER_FACING_ATTRIBUTES = new Set(["title", "placeholder", "aria-label", "alt", "label", "description", "confirmLabel"]);
/** A code or identifier shown as such (lower-case token, version, reference), not prose. */
const isCode = (s: string) => /^[a-z0-9][a-z0-9._:/+-]*$/.test(s) || /^[A-Z0-9][A-Z0-9_-]*-[A-Z0-9_-]+$/.test(s) || !/[A-Za-z]{2}/.test(s);
/** English prose in code: at least two words, starting like a sentence. */
const isSentence = (s: string) => /^[A-Z][a-z']+(\s+\S+){1,}/.test(s.trim()) && !isCode(s.trim());

type Finding = { file: string; line: number; text: string };

function scan() {
  const hardcoded: Finding[] = [];
  const fallbacks: Finding[] = [];
  const keys: { ns: Ns; key: string; at: Finding }[] = [];
  for (const file of sourceFiles(SRC)) {
    if (file.startsWith(join(SRC, "i18n"))) continue;
    const source = readFileSync(file, "utf8");
    const fileNs = (/useTranslation\(\s*"(\w+)"/.exec(source)?.[1] ?? "common") as Ns;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const at = (node: ts.Node, text: string): Finding => ({
      file: relative(ROOT, file).replace(/\\/g, "/"),
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      text: text.trim().slice(0, 80),
    });
    const isStr = (n: ts.Node | undefined): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
      !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));

    const visit = (node: ts.Node, inT: boolean, inIgnored: boolean): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
        const owner = ts.isPropertyAccessExpression(callee) ? callee.expression.getText(sf) : "";
        if (name === "t") {
          const [a0, a1] = node.arguments;
          if (isStr(a0)) {
            const [ns, key] = a0.text.includes(":") ? (a0.text.split(":", 2) as [Ns, string]) : [fileNs, a0.text];
            keys.push({ ns, key, at: at(a0, a0.text) });
          }
          if (isStr(a1)) fallbacks.push(at(a1, a1.text));
          if (a1 && ts.isObjectLiteralExpression(a1)) {
            for (const p of a1.properties)
              if (ts.isPropertyAssignment(p) && p.name.getText(sf) === "defaultValue" && isStr(p.initializer)) fallbacks.push(at(p, p.initializer.text));
          }
          node.forEachChild((c) => visit(c, true, inIgnored));
          return;
        }
        // Developer-facing text: logs, thrown errors, class names, test ids.
        if (owner === "console" || ["cn", "clsx", "cva", "twMerge", "Error", "assertNever"].includes(name)) {
          node.forEachChild((c) => visit(c, inT, true));
          return;
        }
      }
      if (ts.isNewExpression(node) && /Error$/.test(node.expression.getText(sf))) {
        node.forEachChild((c) => visit(c, inT, true));
        return;
      }
      if (ts.isJsxAttribute(node)) {
        const attr = node.name.getText(sf);
        const init = node.initializer;
        if (init && ts.isStringLiteral(init)) {
          if (USER_FACING_ATTRIBUTES.has(attr) && !isCode(init.text)) hardcoded.push(at(init, `${attr}="${init.text}"`));
          return;
        }
        if (attr === "className" || attr === "data-testid" || attr === "id" || attr === "htmlFor") {
          node.forEachChild((c) => visit(c, inT, true));
          return;
        }
      }
      if (ts.isJsxText(node)) {
        const text = node.getText(sf).trim();
        if (text && !isCode(text)) hardcoded.push(at(node, text));
        return;
      }
      if (!inT && !inIgnored && ts.isTemplateExpression(node)) {
        // `Key ${id} was revoked.`: English around the interpolations.
        const words = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
        if (/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(words) && !/^[\s/?&=:.#-]*$/.test(node.head.text) && /^[A-Z]/.test(words.trim())) hardcoded.push(at(node, node.getText(sf)));
      }
      if (!inT && !inIgnored && isStr(node) && isSentence(node.text)) {
        const parent = node.parent;
        const isPropertyKey = ts.isPropertyAssignment(parent) && parent.name === node;
        const isTypeLiteral = ts.isLiteralTypeNode(parent);
        const isComparison = ts.isBinaryExpression(parent) || ts.isCaseClause(parent);
        if (!isPropertyKey && !isTypeLiteral && !isComparison) hardcoded.push(at(node, node.text));
      }
      node.forEachChild((c) => visit(c, inT, inIgnored));
    };
    visit(sf, false, false);
  }
  return { hardcoded, fallbacks, keys };
}

const found = scan();
const fmt = (f: Finding[]) => f.map((x) => `${x.file}:${x.line}  ${x.text}`);

describe("translations", () => {
  it("EN and FR have the same keys and the same {{variables}}", () => {
    const problems: string[] = [];
    for (const ns of Object.keys(LOCALES) as Ns[]) {
      const en = texts.en[ns];
      const fr = texts.fr[ns];
      for (const k of en.keys()) if (!fr.has(k)) problems.push(`${ns}:${k} missing in fr`);
      for (const k of fr.keys()) if (!en.has(k)) problems.push(`${ns}:${k} missing in en`);
      for (const [k, v] of en) {
        // A singular form may say "last hour" without its count.
        const vars = (s: string) =>
          [...s.matchAll(/\{\{\s*(\w+)/g)].map((m) => m[1]).filter((name) => !(k.endsWith("_one") && name === "count")).sort().join(",");
        if (fr.has(k) && vars(v) !== vars(fr.get(k)!)) problems.push(`${ns}:${k} variables differ: en {${vars(v)}} fr {${vars(fr.get(k)!)}}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("every literal key used by t() exists in EN and FR", () => {
    const has = (m: Map<string, string>, key: string) => m.has(key) || m.has(`${key}_one`) || m.has(`${key}_other`);
    const missing = found.keys
      .filter(({ ns, key }) => LANGS.some((l) => !texts[l][ns] || !has(texts[l][ns], key)))
      .map(({ ns, key, at }) => `${at.file}:${at.line}  ${ns}:${key}`);
    expect(missing).toEqual([]);
  });

  it("no t() call carries an English fallback", () => {
    expect(fmt(found.fallbacks)).toEqual([]);
  });

  it("no English text is written in the components", () => {
    expect(fmt(found.hardcoded)).toEqual([]);
  });
});
