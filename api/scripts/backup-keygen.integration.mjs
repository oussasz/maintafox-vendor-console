/**
 * deploy/backup/keygen.sh with the real `age` tools (deploy/BACKUP_AND_RESTORE.md §7.2): the
 * one-time key generation the owner runs on the VPS. Needs `age`, `age-keygen` and a POSIX `sh`.
 *
 *   1. .env already has a recipient -> refused, nothing created
 *   2. wrong confirmation, then end of input -> exit 1, .env unchanged, no key left behind
 *   3. wrong confirmation, then the right one (last 6 characters of the printed key) -> the
 *      recipient is appended to .env, it is the public key of the printed private key (a round
 *      trip encrypt -> decrypt proves it), and the private key file is gone
 *   4. an empty BACKUP_AGE_RECIPIENT= line is filled in place, other lines untouched
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KEYGEN = resolve(dirname(fileURLToPath(import.meta.url)), "../../deploy/backup/keygen.sh");
const fwd = (p) => p.replace(/\\/g, "/");

for (const tool of ["age", "age-keygen"]) {
  if (spawnSync(tool, ["--version"]).status !== 0) {
    console.error(`${tool} is required on PATH (CI: apt-get install age)`);
    process.exit(1);
  }
}

/** Runs keygen.sh; `answer(stdout, n)` returns the line to type at prompt n, or null to close stdin. */
function keygen(envFile, memDir, answer) {
  return new Promise((resolveRun, reject) => {
    const child = spawn("sh", [fwd(KEYGEN), fwd(envFile), fwd(memDir)], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let prompts = 0;
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const seen = stdout.split("type the LAST 6 characters").length - 1;
      while (prompts < seen) {
        prompts += 1;
        const line = answer(stdout, prompts);
        if (line === null) child.stdin.end();
        else child.stdin.write(`${line}\n`);
      }
    });
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

const secretOf = (stdout) => /^(AGE-SECRET-KEY-1[0-9A-Z]+)$/m.exec(stdout)?.[1];

async function main() {
  const root = mkdtempSync(join(tmpdir(), "mfx-keygen-"));
  try {
    const mem = join(root, "mem");
    mkdirSync(mem);

    // 1. Already configured.
    const configured = join(root, "configured.env");
    writeFileSync(configured, "FOO=1\nBACKUP_AGE_RECIPIENT=age1existing\n");
    let r = await keygen(configured, mem, () => null);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /BACKUP_AGE_RECIPIENT is already set/);
    assert.equal(readFileSync(configured, "utf8"), "FOO=1\nBACKUP_AGE_RECIPIENT=age1existing\n");
    assert.deepEqual(readdirSync(mem), []);

    // 2. No confirmation: nothing changes, the key is discarded.
    const envFile = join(root, ".env");
    writeFileSync(envFile, "FOO=1\nBAR=2");
    r = await keygen(envFile, mem, (_out, n) => (n === 1 ? "nope!!" : null));
    assert.equal(r.code, 1);
    assert.match(r.stdout, /That does not match/);
    assert.match(r.stderr, /No confirmation: nothing was changed and the key was discarded/);
    assert.ok(secretOf(r.stdout), "the private key is shown");
    assert.equal(readFileSync(envFile, "utf8"), "FOO=1\nBAR=2");
    assert.deepEqual(readdirSync(mem), [], "no key file left behind");

    // 3. Confirmed (after one wrong try): recipient saved, key wiped.
    r = await keygen(envFile, mem, (out, n) => (n === 1 ? "wrong!" : secretOf(out).slice(-6)));
    assert.equal(r.code, 0, r.stderr);
    const secret = secretOf(r.stdout);
    assert.match(r.stdout, /shown ONCE/);
    assert.match(r.stdout, /If you lose it, the backups cannot be read by anyone/);
    assert.match(r.stdout, /Confirmed\. BACKUP_AGE_RECIPIENT is saved in \.env and the private key was wiped/);
    assert.deepEqual(readdirSync(mem), [], "the private key no longer exists on the server");
    const lines = readFileSync(envFile, "utf8").split("\n");
    assert.deepEqual(lines.slice(0, 2), ["FOO=1", "BAR=2"]);
    const recipient = /^BACKUP_AGE_RECIPIENT=(age1[0-9a-z]{58})$/.exec(lines[2])?.[1];
    assert.ok(recipient, `recipient line: ${lines[2]}`);
    assert.ok(!readFileSync(envFile, "utf8").includes("AGE-SECRET-KEY"), "the private key is never written to .env");
    const ownerKey = join(root, "owner-saved.key");
    writeFileSync(ownerKey, `${secret}\n`);
    const sealed = spawnSync("age", ["--encrypt", "--recipient", recipient], { input: "backup bytes" });
    assert.equal(sealed.status, 0);
    const opened = spawnSync("age", ["--decrypt", "--identity", fwd(ownerKey)], { input: sealed.stdout });
    assert.equal(opened.status, 0, String(opened.stderr));
    assert.equal(String(opened.stdout), "backup bytes", "the saved private key opens what is encrypted to the recipient");

    // 4. An empty line is filled in place.
    const emptyLine = join(root, "empty-line.env");
    writeFileSync(emptyLine, "FOO=1\nBACKUP_AGE_RECIPIENT=\nBAR=2\n");
    r = await keygen(emptyLine, mem, (out) => secretOf(out).slice(-6));
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(emptyLine, "utf8"), /^FOO=1\nBACKUP_AGE_RECIPIENT=age1[0-9a-z]{58}\nBAR=2\n$/);
    assert.deepEqual(readdirSync(mem), []);

    console.log("backup-keygen: OK (refuses an existing key, no change without confirmation, recipient saved + key wiped after confirmation)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
