/**
 * Local copy of the tenant media bucket inside the backups (deploy/BACKUP_AND_RESTORE.md §1,
 * docs/deploy/OBJECT_STORAGE_DECISION.md). It replaces MinIO's object versioning: Garage keeps
 * only the current content of each key, so every night every object is copied into
 * $BACKUP_DIR/media/ (age-encrypted to the owner's key when BACKUP_LOCAL_ENCRYPTION=required), and
 * an object that is deleted or overwritten in the bucket keeps its last copy for
 * MEDIA_BACKUP_REMOVED_RETENTION_DAYS days. Being inside the backups, the copy also reaches the
 * on-premise pull (deploy/backup-pull/), which bucket versioning never did.
 *
 *   node dist/tools/media-backup.js backup  --run-ts 20261012T023000Z
 *   node dist/tools/media-backup.js restore --source <dir> [--identity <age key file>] [--replace]
 *
 * Layout (no other file: nothing in the backup volume is plaintext when encryption is required):
 *   media/current/<key>+<etag>.age            the latest copy of every object in the bucket
 *   media/removed/<run-ts>/<key>+<etag>.age   objects deleted or overwritten in the bucket, noticed
 *                                             by the run <run-ts>
 * <key> is the object key with every path segment percent-encoded (encodeObjectKey), <etag> the
 * object's ETag when it was copied: a new ETag for the same key means the object was overwritten.
 * With BACKUP_LOCAL_ENCRYPTION=disabled the copies end in `.bin` (plaintext); when encryption is
 * turned on later, the next run encrypts them and deletes the plaintext.
 *
 * backup environment: BACKUP_DIR, BACKUP_WORK_DIR, BACKUP_LOCAL_ENCRYPTION (required|disabled),
 * BACKUP_AGE_RECIPIENT (when required), MEDIA_BACKUP_REMOVED_RETENTION_DAYS, and the media bucket
 * settings (S3_*, DEPLOYMENT_ENV) the API uses. restore: BACKUP_WORK_DIR and the S3_* settings;
 * `--identity` is the owner's private key file, needed for `.age` copies (never kept on the server).
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { CHECK_PROBE_PREFIX, isNoSuchKey, TenantMediaObjectStore } from "../storage/object-store.js";
import { isAgeFile, runAge } from "./age-cli.js";

const ENCRYPTED_SUFFIX = ".age";
const PLAIN_SUFFIX = ".bin";
const ETAG_SEPARATOR = "+";
const RUN_TS = /^[0-9]{8}T[0-9]{6}Z$/;
const ETAG = /^[0-9A-Za-z-]+$/;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`environment variable ${name} is required for the media backup`);
  return value;
}

function argValue(argv: string[], name: string): string {
  const i = argv.indexOf(name);
  const value = i >= 0 ? argv[i + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}

/**
 * Object key -> relative file path: each '/'-separated segment keeps [A-Za-z0-9_-] and '.' (not
 * as the first character), every other byte becomes %XX. Injective ('%' itself is encoded), never
 * produces '.', '..', an empty segment or '+', and stays inside the pull's allowed characters.
 */
export function encodeObjectKey(key: string): string {
  const segments = key.split("/");
  if (segments.some((s) => s === "")) throw new Error(`object key '${key}' has an empty path segment; cannot be stored as a file`);
  return segments
    .map((segment) =>
      [...Buffer.from(segment, "utf8")]
        .map((byte, i) => {
          const c = String.fromCharCode(byte);
          if (/[A-Za-z0-9_-]/.test(c) || (c === "." && i > 0)) return c;
          return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
        })
        .join(""),
    )
    .join("/");
}

export function decodeObjectKey(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      if (!/^[A-Za-z0-9_%-][A-Za-z0-9._%-]*$/.test(segment)) throw new Error(`'${path}' is not an encoded object key`);
      return decodeURIComponent(segment);
    })
    .join("/");
}

type CopyFile = { file: string; encodedKey: string; etag: string; encrypted: boolean };

/** Parses `<encoded key>+<etag>.age|.bin` (relative path with '/'); null for anything else. */
function parseCopyFile(file: string): CopyFile | null {
  let encrypted: boolean;
  let base: string;
  if (file.endsWith(ENCRYPTED_SUFFIX)) {
    encrypted = true;
    base = file.slice(0, -ENCRYPTED_SUFFIX.length);
  } else if (file.endsWith(PLAIN_SUFFIX)) {
    encrypted = false;
    base = file.slice(0, -PLAIN_SUFFIX.length);
  } else {
    return null;
  }
  const at = base.lastIndexOf(ETAG_SEPARATOR);
  if (at <= 0) return null;
  const etag = base.slice(at + 1);
  if (!ETAG.test(etag)) return null;
  return { file, encodedKey: base.slice(0, at), etag, encrypted };
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

function moveInto(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  renameSync(from, to);
}

/** age-encrypts `plain` to `dest` (written as dest.partial, checked, then renamed). */
async function encryptTo(recipient: string, plain: string, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const partial = `${dest}.partial`;
  await runAge(["--encrypt", "--recipient", recipient, "--output", partial, plain]);
  // The same structural check as deploy/backup/lib.sh encrypt_to: header + ciphertext longer than
  // the plaintext (nonce + one tag per 64 KiB chunk).
  if (!isAgeFile(partial)) throw new Error(`encrypting ${plain} produced no age file`);
  if (statSync(partial).size <= statSync(plain).size + 16) throw new Error(`encrypted copy of ${plain} is too short`);
  renameSync(partial, dest);
}

type EncryptionMode = { encrypt: true; recipient: string } | { encrypt: false };

function encryptionMode(): EncryptionMode {
  const mode = required("BACKUP_LOCAL_ENCRYPTION");
  if (mode === "disabled") return { encrypt: false };
  if (mode !== "required") throw new Error(`BACKUP_LOCAL_ENCRYPTION must be 'required' or 'disabled', got '${mode}'`);
  const recipient = required("BACKUP_AGE_RECIPIENT");
  if (!/^age1[0-9a-z]{58}$/.test(recipient)) throw new Error("BACKUP_AGE_RECIPIENT must be an age public key (age1...)");
  return { encrypt: true, recipient };
}

function mediaStoreFromEnv(): TenantMediaObjectStore {
  const media = TenantMediaObjectStore.fromEnv();
  if (!media) throw new Error("media bucket settings (S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, ...) are not set");
  return media;
}

export async function backupMedia(runTs: string): Promise<Record<string, number>> {
  if (!RUN_TS.test(runTs)) throw new Error(`--run-ts must look like 20261012T023000Z, got '${runTs}'`);
  const backupDir = required("BACKUP_DIR");
  const workDir = required("BACKUP_WORK_DIR");
  const retentionDays = Number(required("MEDIA_BACKUP_REMOVED_RETENTION_DAYS"));
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error("MEDIA_BACKUP_REMOVED_RETENTION_DAYS must be a positive integer");
  const mode = encryptionMode();
  const media = mediaStoreFromEnv();
  await media.headBucket();

  const root = join(backupDir, "media");
  const currentDir = join(root, "current");
  const removedDir = join(root, "removed", runTs);
  const work = join(workDir, `media-${runTs}`);
  mkdirSync(currentDir, { recursive: true, mode: 0o700 });
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const stats = { objects: 0, bytes: 0, copied: 0, unchanged: 0, superseded: 0, removed: 0, vanished: 0, encrypted_existing: 0, pruned_runs: 0 };

  // What is already copied, by encoded key. Leftovers of an interrupted run (*.partial) go.
  const copies = new Map<string, CopyFile[]>();
  for (const full of listFiles(currentDir)) {
    const rel = relative(currentDir, full).split(sep).join("/");
    if (rel.endsWith(".partial")) {
      rmSync(full);
      continue;
    }
    const parsed = parseCopyFile(rel);
    if (!parsed) throw new Error(`unexpected file in ${currentDir}: ${rel} (not written by this tool)`);
    copies.set(parsed.encodedKey, [...(copies.get(parsed.encodedKey) ?? []), parsed]);
  }
  // A copy set aside keeps its content; with encryption required, a plaintext copy (written before
  // encryption was turned on) is encrypted on the way.
  const keepAside = async (c: CopyFile) => {
    const from = join(currentDir, c.file);
    if (mode.encrypt && !c.encrypted) {
      const base = c.file.slice(0, -PLAIN_SUFFIX.length);
      await encryptTo(mode.recipient, from, join(removedDir, `${base}${ENCRYPTED_SUFFIX}`));
      rmSync(from);
    } else {
      moveInto(from, join(removedDir, c.file));
    }
  };

  try {
    const inBucket = new Set<string>();
    for (const obj of await media.listObjects()) {
      // The start-up check's probe objects are not media and live only seconds.
      if (obj.key.startsWith(CHECK_PROBE_PREFIX)) continue;
      if (!ETAG.test(obj.etag)) throw new Error(`object ${obj.key} has no usable ETag ('${obj.etag}')`);
      const encodedKey = encodeObjectKey(obj.key);
      inBucket.add(encodedKey);
      stats.objects += 1;
      stats.bytes += obj.size;
      const existing = copies.get(encodedKey) ?? [];
      const same = existing.find((c) => c.etag === obj.etag);
      for (const c of existing) {
        if (c === same) continue;
        // Another ETag: the object was overwritten since that copy; the old content is kept aside.
        await keepAside(c);
        stats.superseded += 1;
      }
      if (same) {
        if (mode.encrypt && !same.encrypted) {
          // Encryption turned on since this copy was made: encrypt it now, delete the plaintext.
          const plain = join(currentDir, same.file);
          await encryptTo(mode.recipient, plain, join(currentDir, `${encodedKey}${ETAG_SEPARATOR}${same.etag}${ENCRYPTED_SUFFIX}`));
          rmSync(plain);
          stats.encrypted_existing += 1;
        }
        stats.unchanged += 1;
        continue;
      }
      const plain = join(work, "object");
      const sink = createWriteStream(plain, { mode: 0o600 });
      try {
        await media.downloadObject(obj.key, sink);
      } catch (err) {
        sink.destroy();
        rmSync(plain, { force: true });
        if (!isNoSuchKey(err)) throw err;
        // Deleted between the listing and the download: treated as deleted, not as a failed night.
        // Its older copies (other ETags) were kept aside just above; none is left in current/.
        inBucket.delete(encodedKey);
        copies.delete(encodedKey);
        if (existing.length > 0) stats.removed += 1;
        stats.objects -= 1;
        stats.bytes -= obj.size;
        stats.vanished += 1;
        continue;
      }
      const got = statSync(plain).size;
      if (got !== obj.size) throw new Error(`object ${obj.key}: read ${got} bytes, the bucket lists ${obj.size}`);
      const name = `${encodedKey}${ETAG_SEPARATOR}${obj.etag}`;
      if (mode.encrypt) {
        await encryptTo(mode.recipient, plain, join(currentDir, `${name}${ENCRYPTED_SUFFIX}`));
        rmSync(plain);
      } else {
        moveInto(plain, join(currentDir, `${name}${PLAIN_SUFFIX}`));
      }
      stats.copied += 1;
    }
    for (const [encodedKey, existing] of copies) {
      if (inBucket.has(encodedKey)) continue;
      for (const c of existing) await keepAside(c);
      stats.removed += 1;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const removedRoot = join(root, "removed");
  // Encryption turned on: plaintext copies set aside by earlier runs are encrypted too.
  if (mode.encrypt) {
    for (const full of listFiles(removedRoot)) {
      if (!full.endsWith(PLAIN_SUFFIX)) continue;
      await encryptTo(mode.recipient, full, `${full.slice(0, -PLAIN_SUFFIX.length)}${ENCRYPTED_SUFFIX}`);
      rmSync(full);
      stats.encrypted_existing += 1;
    }
  }

  // Retention of removed/overwritten copies: by the run time in the directory name.
  if (existsSync(removedRoot)) {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    for (const name of readdirSync(removedRoot)) {
      if (!RUN_TS.test(name)) continue;
      const at = Date.parse(`${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6, 8)}T${name.slice(9, 11)}:${name.slice(11, 13)}:${name.slice(13, 15)}Z`);
      if (at < cutoff) {
        rmSync(join(removedRoot, name), { recursive: true, force: true });
        stats.pruned_runs += 1;
      }
    }
  }
  return stats;
}

/**
 * Puts every copy under `source` (media/current, or one media/removed/<run-ts>) back into the
 * bucket. Objects already in the bucket are left alone unless `replace`. Every restored object is
 * read back and its size compared.
 */
export async function restoreMedia(source: string, identity: string | null, replace: boolean): Promise<Record<string, number>> {
  const workDir = required("BACKUP_WORK_DIR");
  const media = mediaStoreFromEnv();
  await media.headBucket();
  const work = join(workDir, `media-restore-${process.pid}`);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const stats = { restored: 0, skipped_present: 0 };
  try {
    for (const full of listFiles(source)) {
      const rel = relative(source, full).split(sep).join("/");
      const copy = parseCopyFile(rel);
      if (!copy) throw new Error(`${rel} is not a media copy (<key>+<etag>.age or .bin)`);
      const key = decodeObjectKey(copy.encodedKey);
      if (!replace && (await media.headObject(key))) {
        stats.skipped_present += 1;
        continue;
      }
      let plain = full;
      if (copy.encrypted) {
        if (!identity) throw new Error(`${rel} is encrypted: --identity <owner's age key file> is required`);
        plain = join(work, "object");
        await runAge(["--decrypt", "--identity", identity, "--output", plain, full]);
      }
      const size = statSync(plain).size;
      await media.putObject(key, createReadStream(plain), size);
      const head = await media.headObject(key);
      if (!head || head.size !== size) throw new Error(`restored object ${key} reads back as ${head?.size ?? "missing"} bytes, expected ${size}`);
      if (plain !== full) rmSync(plain, { force: true });
      stats.restored += 1;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return stats;
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  let result: unknown;
  switch (command) {
    case "backup":
      result = await backupMedia(argValue(argv, "--run-ts"));
      break;
    case "restore":
      result = await restoreMedia(
        argValue(argv, "--source"),
        argv.includes("--identity") ? argValue(argv, "--identity") : null,
        argv.includes("--replace"),
      );
      break;
    default:
      throw new Error(`unknown command '${command ?? ""}' (backup | restore)`);
  }
  process.stdout.write(`${JSON.stringify({ command, result })}\n`);
}

// Only when run as a program (the encoding helpers are imported by tests).
if (process.argv[1] && /media-backup\.js$/.test(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`media-backup failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
