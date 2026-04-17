import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function collectTsxFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsxFiles(absolute));
      continue;
    }
    if (extname(entry.name) === ".tsx") {
      files.push(absolute);
    }
  }
  return files;
}

const noOpClickPatterns = [
  /onClick=\{\(\)\s*=>\s*\{\s*\}\s*\}/m,
  /onClick=\{\(\)\s*=>\s*null\s*\}/m,
  /onClick=\{\(\)\s*=>\s*void\s+0\s*\}/m,
  /onClick=\{undefined\}/m,
];

describe("vendor-console ui hardening guards", () => {
  const currentFile = fileURLToPath(import.meta.url);
  const vendorConsoleDir = dirname(dirname(currentFile));
  const tsxFiles = collectTsxFiles(vendorConsoleDir);

  it("does not contain silent or explicit no-op click handlers", () => {
    const violations: string[] = [];

    for (const file of tsxFiles) {
      const source = readFileSync(file, "utf8");
      for (const pattern of noOpClickPatterns) {
        if (pattern.test(source)) {
          violations.push(`${file} matches ${pattern}`);
          break;
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("requires explicit disabled reason for unavailable buttons", () => {
    const violations: string[] = [];
    const disabledButtonBlock = /<Button([\s\S]*?)>([\s\S]*?)<\/Button>/gm;

    for (const file of tsxFiles) {
      const source = readFileSync(file, "utf8");
      const matches = source.matchAll(disabledButtonBlock);
      for (const match of matches) {
        const attrs = match[1] ?? "";
        const body = match[2] ?? "";
        const mentionsUnavailable = /unavailable/i.test(body);
        if (!mentionsUnavailable) continue;
        if (!/\bdisabled\b/.test(attrs)) continue;
        if (!/\btitle=/.test(attrs)) {
          violations.push(`${file} has disabled unavailable button without explicit reason in title`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
