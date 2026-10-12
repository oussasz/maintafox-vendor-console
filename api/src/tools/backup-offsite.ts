/**
 * Off-site copy of the backups (deploy/BACKUP_AND_RESTORE.md) to any S3-compatible bucket.
 * Every object is encrypted on this server with `age` to the owner's public key
 * (BACKUP_AGE_RECIPIENT) before it leaves; only the owner's private key, kept off the server, can
 * decrypt it. Nothing is ever deleted off-site by this tool: retention there is the bucket's
 * lifecycle rule, so a compromised server cannot wipe the off-site history with a write-only key.
 *
 *   node dist/tools/backup-offsite.js push-file  --file <path> --key <remote/relative/key>
 *   node dist/tools/backup-offsite.js push-dir   --dir <path> --key-prefix <remote/prefix>
 *   node dist/tools/backup-offsite.js push-media
 *   node dist/tools/backup-offsite.js list       --key-prefix <remote/prefix>
 *   node dist/tools/backup-offsite.js fetch      --key <remote/relative/key> --out <path>
 *
 * Remote keys are `${BACKUP_OFFSITE_S3_PREFIX}/<key>.age`. push-dir and push-media upload only the
 * files that are not off-site yet (WAL segments, base backups and media objects never change).
 * A local file that is already age-encrypted (`*.age`, BACKUP_LOCAL_ENCRYPTION=required, encrypted
 * to the same BACKUP_AGE_RECIPIENT) is uploaded as it is, under its name without `.age`, so the
 * off-site layout is the same in both modes and nothing is encrypted twice.
 * Required environment (all of them, no defaults): BACKUP_OFFSITE_S3_ENDPOINT, _REGION, _BUCKET,
 * _ACCESS_KEY, _SECRET_KEY, _PREFIX, _FORCE_PATH_STYLE (true|false), BACKUP_AGE_RECIPIENT.
 * push-media also needs the media bucket settings the API uses (S3_ENDPOINT, S3_ACCESS_KEY, ...).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, mkdtempSync, openSync, readSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { TenantMediaObjectStore } from "../storage/object-store.js";

const ENCRYPTED_SUFFIX = ".age";
const AGE_HEADER = "age-encryption.org/v1\n";

export type OffsiteConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  forcePathStyle: boolean;
  ageRecipient: string;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`environment variable ${name} is required for the off-site backup`);
  return value;
}

export function loadOffsiteConfig(env: NodeJS.ProcessEnv = process.env): OffsiteConfig {
  const forcePathStyle = required(env, "BACKUP_OFFSITE_S3_FORCE_PATH_STYLE").toLowerCase();
  if (forcePathStyle !== "true" && forcePathStyle !== "false") {
    throw new Error("BACKUP_OFFSITE_S3_FORCE_PATH_STYLE must be 'true' or 'false'");
  }
  const prefix = required(env, "BACKUP_OFFSITE_S3_PREFIX").replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9._/-]+$/.test(prefix) || prefix.includes("..")) {
    throw new Error("BACKUP_OFFSITE_S3_PREFIX may only contain letters, digits, '.', '_', '-' and '/'");
  }
  const ageRecipient = required(env, "BACKUP_AGE_RECIPIENT");
  if (!/^age1[0-9a-z]{58}$/.test(ageRecipient)) {
    throw new Error("BACKUP_AGE_RECIPIENT must be an age public key (age1..., from `age-keygen`)");
  }
  const endpoint = required(env, "BACKUP_OFFSITE_S3_ENDPOINT").replace(/\/$/, "");
  if (!/^https?:\/\//.test(endpoint)) {
    throw new Error("BACKUP_OFFSITE_S3_ENDPOINT must be an http(s) URL");
  }
  return {
    endpoint,
    region: required(env, "BACKUP_OFFSITE_S3_REGION"),
    bucket: required(env, "BACKUP_OFFSITE_S3_BUCKET"),
    accessKeyId: required(env, "BACKUP_OFFSITE_S3_ACCESS_KEY"),
    secretAccessKey: required(env, "BACKUP_OFFSITE_S3_SECRET_KEY"),
    prefix,
    forcePathStyle: forcePathStyle === "true",
    ageRecipient,
  };
}

/** A relative key with only safe path segments (no '..', no leading '/'). */
export function assertRelativeKey(key: string): string {
  const k = key.replace(/\\/g, "/");
  if (!k || k.startsWith("/") || k.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`invalid off-site key '${key}'`);
  }
  return k;
}

function runAge(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("age", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => reject(new Error(`cannot run age: ${err.message}`)));
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`age exited with ${code}: ${stderr.trim()}`));
    });
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** The file starts with the age v1 header (it was encrypted before it reached this tool). */
export function isAgeFile(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(AGE_HEADER.length);
    const n = readSync(fd, head, 0, head.length, 0);
    return n === head.length && head.toString("latin1") === AGE_HEADER;
  } finally {
    closeSync(fd);
  }
}

export class OffsiteStore {
  private readonly client: S3Client;

  constructor(readonly config: OffsiteConfig) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  remoteKey(key: string): string {
    return `${this.config.prefix}/${assertRelativeKey(key)}${ENCRYPTED_SUFFIX}`;
  }

  /** Relative keys (without the prefix and the .age suffix) present under `keyPrefix`. */
  async listRelativeKeys(keyPrefix: string): Promise<Set<string>> {
    const base = `${this.config.prefix}/`;
    const listPrefix = `${base}${keyPrefix ? `${assertRelativeKey(keyPrefix)}/` : ""}`;
    const keys = new Set<string>();
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: listPrefix, ContinuationToken: token }),
      );
      for (const obj of page.Contents ?? []) {
        if (obj.Key?.endsWith(ENCRYPTED_SUFFIX)) {
          keys.add(obj.Key.slice(base.length, -ENCRYPTED_SUFFIX.length));
        }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  /**
   * Uploads `path` as `key`: a plaintext file is encrypted with age first (its SHA-256 travels as
   * metadata); a `*.age` file, already encrypted on this server to the same recipient, is uploaded
   * as it is. A `*.age` name without the age header is refused, never uploaded as plaintext.
   */
  async pushFile(path: string, key: string): Promise<{ key: string; bytes: number }> {
    if (path.endsWith(ENCRYPTED_SUFFIX)) {
      if (!isAgeFile(path)) throw new Error(`${path} is named .age but is not an age-encrypted file`);
      const remote = this.remoteKey(key);
      const bytes = statSync(path).size;
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: remote,
          Body: createReadStream(path),
          ContentLength: bytes,
          ContentType: "application/octet-stream",
          Metadata: { "encrypted-on-server": "true" },
        }),
      );
      return { key: remote, bytes };
    }
    const plainPath = path;
    const remote = this.remoteKey(key);
    const work = mkdtempSync(join(tmpdir(), "mfx-offsite-"));
    try {
      const encrypted = join(work, "object.age");
      await runAge(["--encrypt", "--recipient", this.config.ageRecipient, "--output", encrypted, plainPath]);
      const bytes = statSync(encrypted).size;
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: remote,
          Body: createReadStream(encrypted),
          ContentLength: bytes,
          ContentType: "application/octet-stream",
          Metadata: { "plaintext-sha256": await sha256File(plainPath) },
        }),
      );
      return { key: remote, bytes };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** Downloads `key` (still encrypted) to `outPath`. */
  async fetch(key: string, outPath: string): Promise<void> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: this.remoteKey(key) }));
    if (!out.Body) throw new Error(`off-site object ${key} has no body`);
    await pipeline(out.Body as NodeJS.ReadableStream, createWriteStream(outPath));
  }
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    // .partial / .tmp = still being written by the backup or by the WAL archiver.
    else if (entry.isFile() && !entry.name.endsWith(".partial") && !entry.name.endsWith(".tmp")) out.push(full);
  }
  return out.sort();
}

/** Uploads every file under `dir` whose key is not off-site yet. */
export async function pushDirectory(store: OffsiteStore, dir: string, keyPrefix: string): Promise<{ uploaded: number; already: number }> {
  const present = await store.listRelativeKeys(keyPrefix);
  let uploaded = 0;
  let already = 0;
  for (const file of listFilesRecursive(dir)) {
    const name = relative(dir, file).split(sep).join("/");
    const key = `${assertRelativeKey(keyPrefix)}/${name.endsWith(ENCRYPTED_SUFFIX) ? name.slice(0, -ENCRYPTED_SUFFIX.length) : name}`;
    if (present.has(key)) {
      already += 1;
      continue;
    }
    await store.pushFile(file, key);
    uploaded += 1;
  }
  return { uploaded, already };
}

/** Copies every media object that is not off-site yet (media keys are content-addressed). */
export async function pushMedia(store: OffsiteStore, media: TenantMediaObjectStore): Promise<{ uploaded: number; already: number }> {
  const present = await store.listRelativeKeys("media");
  let uploaded = 0;
  let already = 0;
  for (const objectKey of await media.listObjectKeys()) {
    const key = `media/${assertRelativeKey(objectKey)}`;
    if (present.has(key)) {
      already += 1;
      continue;
    }
    const work = mkdtempSync(join(tmpdir(), "mfx-media-"));
    try {
      const plain = join(work, "object");
      await media.downloadObject(objectKey, createWriteStream(plain));
      await store.pushFile(plain, key);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    uploaded += 1;
  }
  return { uploaded, already };
}

function argValue(argv: string[], name: string): string {
  const i = argv.indexOf(name);
  const value = i >= 0 ? argv[i + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  const store = new OffsiteStore(loadOffsiteConfig());
  let result: unknown;
  switch (command) {
    case "push-file":
      result = await store.pushFile(argValue(argv, "--file"), argValue(argv, "--key"));
      break;
    case "push-dir":
      result = await pushDirectory(store, argValue(argv, "--dir"), argValue(argv, "--key-prefix"));
      break;
    case "push-media": {
      const media = TenantMediaObjectStore.fromEnv();
      if (!media) throw new Error("media bucket settings (S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY) are not set");
      result = await pushMedia(store, media);
      break;
    }
    case "list":
      result = [...(await store.listRelativeKeys(argValue(argv, "--key-prefix")))].sort();
      break;
    case "fetch":
      await store.fetch(argValue(argv, "--key"), argValue(argv, "--out"));
      result = { fetched: argValue(argv, "--key") };
      break;
    default:
      throw new Error(`unknown command '${command ?? ""}' (push-file | push-dir | push-media | list | fetch)`);
  }
  process.stdout.write(`${JSON.stringify({ command, result })}\n`);
}

main().catch((err) => {
  process.stderr.write(`backup-offsite failed: ${(err as Error).message}\n`);
  process.exit(1);
});
