/**
 * Tenant media object store: any S3-compatible server reached through the AWS SDK. Production runs
 * Garage (docs/deploy/OBJECT_STORAGE_DECISION.md, deploy/OBJECT_STORAGE.md); nothing here is
 * specific to it beyond what plain S3 requires.
 *
 * Configuration (all of them, no defaults; none of them set = object storage not configured):
 *   S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION, S3_BUCKET,
 *   S3_FORCE_PATH_STYLE (true|false), DEPLOYMENT_ENV (first segment of every object key).
 * The bucket is created by the object store's own setup, never by this code: a missing bucket is
 * reported (ObjectStoreBucketMissingError), not silently recreated empty.
 */
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type ObjectStoreConfig = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle: boolean;
  deploymentEnv: string;
};

export type PresignResult = {
  url: string;
  method: "PUT" | "GET";
  bucket: string;
  object_key: string;
  expires_in_seconds: number;
};

export type ObjectListing = { key: string; size: number; etag: string };

/** Lifetime of every presigned URL handed to desktops and the console (15 minutes). */
export const PRESIGNED_URL_TTL_SECONDS = 900;

const CREDENTIAL_VARS = ["S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY"] as const;
const REQUIRED_VARS = [...CREDENTIAL_VARS, "S3_REGION", "S3_BUCKET", "S3_FORCE_PATH_STYLE", "DEPLOYMENT_ENV"] as const;

export class ObjectStoreConfigError extends Error {
  override name = "ObjectStoreConfigError";
}

/** The configured bucket does not exist on the object store (its setup did not run or was lost). */
export class ObjectStoreBucketMissingError extends Error {
  override name = "ObjectStoreBucketMissingError";
  constructor(readonly bucket: string) {
    super(`bucket '${bucket}' does not exist on the object store (see deploy/OBJECT_STORAGE.md)`);
  }
}

/**
 * Reads the S3_* settings. Returns null when none of endpoint/access key/secret key is set (object
 * storage deliberately not configured); throws when the settings are only partly there or invalid.
 */
export function loadObjectStoreConfig(env: NodeJS.ProcessEnv = process.env): ObjectStoreConfig | null {
  const value = (name: string) => env[name]?.trim() ?? "";
  if (CREDENTIAL_VARS.every((name) => value(name) === "")) return null;
  const missing = REQUIRED_VARS.filter((name) => value(name) === "");
  if (missing.length > 0) {
    throw new ObjectStoreConfigError(`object storage is partly configured: missing ${missing.join(", ")}`);
  }
  const endpoint = value("S3_ENDPOINT").replace(/\/$/, "");
  if (!/^https?:\/\/[^/]+$/.test(endpoint)) {
    throw new ObjectStoreConfigError("S3_ENDPOINT must be an http(s) origin without a path, e.g. http://object-store:3900");
  }
  const forcePathStyle = value("S3_FORCE_PATH_STYLE").toLowerCase();
  if (forcePathStyle !== "true" && forcePathStyle !== "false") {
    throw new ObjectStoreConfigError("S3_FORCE_PATH_STYLE must be 'true' or 'false'");
  }
  const deploymentEnv = value("DEPLOYMENT_ENV");
  if (!/^[a-z0-9-]+$/.test(deploymentEnv)) {
    throw new ObjectStoreConfigError("DEPLOYMENT_ENV must be lowercase letters, digits or '-' (it prefixes every object key)");
  }
  return {
    endpoint,
    region: value("S3_REGION"),
    accessKeyId: value("S3_ACCESS_KEY"),
    secretAccessKey: value("S3_SECRET_KEY"),
    bucket: value("S3_BUCKET"),
    forcePathStyle: forcePathStyle === "true",
    deploymentEnv,
  };
}

/**
 * S3 client for an S3-compatible server. Checksums only when an operation requires them: with the
 * SDK default ("when supported") every presigned PUT URL carries `x-amz-checksum-crc32=AAAAAA==`,
 * the CRC32 of an EMPTY body, which a server that verifies checksums (Garage does) rejects for any
 * real upload. Integrity of uploads is checked by our own SHA-256 comparisons instead.
 */
export function createS3Client(config: {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/** HeadBucket/HeadObject answer "not found" without an S3 error code in the body. */
export function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.name === "NoSuchBucket" || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Canonical TenantMedia key:
 * `{env}/media/{tenant}/{parent_type}/{parent_sync_id}/{content_sha256}`
 */
export function buildTenantMediaObjectKey(input: {
  deploymentEnv: string;
  tenantId: string;
  parentEntityType: string;
  parentEntitySyncId: string;
  contentSha256: string;
}): string {
  const sha = input.contentSha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    throw new Error("content_sha256 must be 64 lowercase hex characters");
  }
  const tenant = input.tenantId.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(tenant)) {
    throw new Error("tenant_id invalid for object key");
  }
  const parentType = input.parentEntityType.trim();
  const parentSync = input.parentEntitySyncId.trim();
  if (!parentType || !parentSync || parentType.includes("..") || parentSync.includes("..")) {
    throw new Error("invalid parent path segments");
  }
  const env = input.deploymentEnv.trim();
  if (!env) throw new Error("deployment env is required for object keys");
  return `${env}/media/${tenant}/${parentType}/${parentSync}/${sha}`;
}

export function assertTenantOwnsObjectKey(tenantId: string, objectKey: string): boolean {
  const parts = objectKey.split("/");
  // env / media / tenant / ...
  return parts.length >= 4 && parts[1] === "media" && parts[2] === tenantId;
}

export class TenantMediaObjectStore {
  readonly config: ObjectStoreConfig;
  private readonly client: S3Client;
  private bucketChecked = false;

  constructor(config: ObjectStoreConfig) {
    this.config = config;
    this.client = createS3Client(config);
  }

  /** null when object storage is not configured at all; throws ObjectStoreConfigError when partly. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): TenantMediaObjectStore | null {
    const cfg = loadObjectStoreConfig(env);
    if (!cfg) return null;
    return new TenantMediaObjectStore(cfg);
  }

  /**
   * The bucket exists (checked once per process, then trusted). Throws
   * ObjectStoreBucketMissingError when it does not, the provider's error when the store fails.
   */
  async assertBucket(): Promise<void> {
    if (this.bucketChecked) return;
    await this.headBucket();
    this.bucketChecked = true;
  }

  /** Health probe: the bucket answers HEAD (no creation, no caching). */
  async headBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
    } catch (err) {
      if (isNotFound(err)) throw new ObjectStoreBucketMissingError(this.config.bucket);
      throw err;
    }
  }

  async presignPut(objectKey: string, expiresInSeconds = PRESIGNED_URL_TTL_SECONDS): Promise<PresignResult> {
    await this.assertBucket();
    const cmd = new PutObjectCommand({ Bucket: this.config.bucket, Key: objectKey });
    const url = await getSignedUrl(this.client, cmd, { expiresIn: expiresInSeconds });
    return { url, method: "PUT", bucket: this.config.bucket, object_key: objectKey, expires_in_seconds: expiresInSeconds };
  }

  async presignGet(objectKey: string, expiresInSeconds = PRESIGNED_URL_TTL_SECONDS): Promise<PresignResult> {
    await this.assertBucket();
    const cmd = new GetObjectCommand({ Bucket: this.config.bucket, Key: objectKey });
    const url = await getSignedUrl(this.client, cmd, { expiresIn: expiresInSeconds });
    return { url, method: "GET", bucket: this.config.bucket, object_key: objectKey, expires_in_seconds: expiresInSeconds };
  }

  /** Every object under `prefix` with its size and ETag (paged). */
  async listObjects(prefix = ""): Promise<ObjectListing[]> {
    const out: ObjectListing[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const obj of page.Contents ?? []) {
        if (!obj.Key) continue;
        out.push({ key: obj.Key, size: obj.Size ?? 0, etag: (obj.ETag ?? "").replace(/"/g, "") });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  /** Every object key in the bucket under `prefix` (used by the off-site media backup). */
  async listObjectKeys(prefix = ""): Promise<string[]> {
    return (await this.listObjects(prefix)).map((o) => o.key);
  }

  /** Size and ETag of one object, or null when it does not exist. */
  async headObject(objectKey: string): Promise<{ size: number; etag: string } | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: objectKey }));
      return { size: out.ContentLength ?? 0, etag: (out.ETag ?? "").replace(/"/g, "") };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * Size and SHA-256 of one object, read in full (used to verify an uploaded diagnostic bundle).
   * Returns null when the object does not exist; throws `object_too_large` past `maxBytes`.
   */
  async readObjectDigest(objectKey: string, maxBytes: number): Promise<{ byteSize: number; sha256: string } | null> {
    let out;
    try {
      out = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: objectKey }));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    if (!out.Body) return null;
    const hash = createHash("sha256");
    let byteSize = 0;
    for await (const chunk of out.Body as AsyncIterable<Uint8Array>) {
      byteSize += chunk.length;
      if (byteSize > maxBytes) {
        (out.Body as { destroy?: () => void }).destroy?.();
        throw new Error("object_too_large");
      }
      hash.update(chunk);
    }
    return { byteSize, sha256: hash.digest("hex") };
  }

  /**
   * Size, SHA-256 and BLAKE2b-512 of one object in one read (release artifacts: the SHA-256 is
   * compared with the declared one, the BLAKE2b-512 is what the updater signature signs).
   * Returns null when the object does not exist; throws `object_too_large` past `maxBytes`.
   */
  async readObjectDigests(
    objectKey: string,
    maxBytes: number,
  ): Promise<{ byteSize: number; sha256: string; blake2b512: Buffer } | null> {
    let out;
    try {
      out = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: objectKey }));
    } catch (err) {
      if ((err as { name?: string }).name === "NoSuchKey") return null;
      throw err;
    }
    if (!out.Body) return null;
    const sha = createHash("sha256");
    const blake = createHash("blake2b512");
    let byteSize = 0;
    for await (const chunk of out.Body as AsyncIterable<Uint8Array>) {
      byteSize += chunk.length;
      if (byteSize > maxBytes) {
        (out.Body as { destroy?: () => void }).destroy?.();
        throw new Error("object_too_large");
      }
      sha.update(chunk);
      blake.update(chunk);
    }
    return { byteSize, sha256: sha.digest("hex"), blake2b512: blake.digest() };
  }

  /**
   * Server-side copy inside the bucket (release artifacts: the verified, served copy of an upload).
   * Single-request CopyObject: fine up to 5 GB (release artifacts are capped at 1 GB). Supported
   * by MinIO and Garage. Returns false when the source does not exist.
   */
  async copyObject(sourceKey: string, destinationKey: string): Promise<boolean> {
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.config.bucket,
          Key: destinationKey,
          CopySource: `${this.config.bucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`,
        }),
      );
      return true;
    } catch (err) {
      if ((err as { name?: string }).name === "NoSuchKey") return false;
      throw err;
    }
  }

  /** Streams one object's content into `writeTo` (off-site and local media backups). */
  async downloadObject(objectKey: string, writeTo: NodeJS.WritableStream): Promise<void> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: objectKey }));
    if (!out.Body) throw new Error(`object ${objectKey} has no body`);
    await pipeline(out.Body as NodeJS.ReadableStream, writeTo);
  }

  /**
   * Writes one object (media restore, migration, store self-check). `byteLength` is the exact body
   * length; `contentType` is kept as given (the migration preserves the source's).
   */
  async putObject(objectKey: string, body: Readable | Buffer, byteLength: number, contentType?: string): Promise<{ etag: string }> {
    const out = await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: objectKey,
        Body: body,
        ContentLength: byteLength,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );
    return { etag: (out.ETag ?? "").replace(/"/g, "") };
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: objectKey }));
  }
}
