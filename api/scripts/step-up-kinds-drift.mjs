/**
 * Drift check: step-up action kinds of the console/API (shared/step-up-actions.v1.json) against the
 * desktop's Rust enum StepUpActionKind and its label() (src-tauri/src/vps/vendor_admin_console.rs).
 *
 *   node api/scripts/step-up-kinds-drift.mjs --rust <path to vendor_admin_console.rs>
 *
 * Fails when: a Rust variant is missing from the catalog or has another label there; the catalog
 * names a Rust variant the enum does not have. Catalog kinds with `rust_variant: null` are the ones
 * the desktop has not added yet: listed, not failed (they must be added to the enum with the same
 * label; then the catalog entry names the variant).
 * CI runs it against the desktop repository's main branch (.github/workflows/ci.yml).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const catalogPath = join(here, "../../shared/step-up-actions.v1.json");

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Variant → label, from `pub enum StepUpActionKind { … }` and `fn label(self)`'s match arms. */
function parseRustStepUpKinds(source) {
  const enumBody = /pub enum StepUpActionKind\s*\{([^}]*)\}/.exec(source)?.[1];
  if (!enumBody) throw new Error("pub enum StepUpActionKind not found");
  const variants = [...enumBody.matchAll(/^\s*([A-Z][A-Za-z0-9]*)\s*,?\s*$/gm)].map((m) => m[1]);
  if (variants.length === 0) throw new Error("StepUpActionKind has no variants (parser out of date?)");
  const labelStart = source.indexOf("fn label(self)");
  if (labelStart < 0) throw new Error("StepUpActionKind::label not found");
  const labelFn = source.slice(labelStart, source.indexOf("\n    }", labelStart));
  const labels = new Map([...labelFn.matchAll(/Self::([A-Z][A-Za-z0-9]*)\s*=>\s*"([a-z0-9_]+)"/g)].map((m) => [m[1], m[2]]));
  const out = new Map();
  for (const v of variants) {
    const label = labels.get(v);
    if (!label) throw new Error(`StepUpActionKind::${v} has no label() arm`);
    out.set(v, label);
  }
  return out;
}

const rustPath = argValue("--rust");
if (!rustPath) {
  console.error("usage: node api/scripts/step-up-kinds-drift.mjs --rust <path to vendor_admin_console.rs>");
  process.exit(2);
}
const rust = parseRustStepUpKinds(readFileSync(rustPath, "utf8"));
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
assert.equal(catalog.version, 1);

const problems = [];
const byVariant = new Map(catalog.kinds.filter((k) => k.rust_variant).map((k) => [k.rust_variant, k]));
for (const [variant, label] of rust) {
  const entry = byVariant.get(variant);
  if (!entry) problems.push(`Rust StepUpActionKind::${variant} ("${label}") is missing from ${catalogPath}`);
  else if (entry.kind !== label) problems.push(`StepUpActionKind::${variant} is "${label}" in Rust but "${entry.kind}" in the catalog`);
}
for (const [variant, entry] of byVariant) {
  if (!rust.has(variant)) problems.push(`catalog kind "${entry.kind}" names Rust variant ${variant}, which the desktop enum does not have`);
}
const awaiting = catalog.kinds.filter((k) => k.rust_variant === null).map((k) => k.kind);

if (problems.length > 0) {
  console.error(`step-up kinds drift (${problems.length}):\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `step-up kinds aligned: ${rust.size} desktop kinds match the catalog; ` +
    `${awaiting.length} console-only kinds await the desktop enum: ${awaiting.join(", ")}`,
);
