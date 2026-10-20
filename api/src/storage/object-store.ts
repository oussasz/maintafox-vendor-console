import {
  CopyObjectCommand,
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
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

function loadConfigFromEnv(): ObjectStoreConfig | null {
  const endpoint = process.env["S3_ENDPOINT"]?.trim() || process.env["MINIO_ENDPOINT"]?.trim();
  const accessKeyId =
    process.env["S3_ACCESS_KEY"]?.trim() || process.env["MINIO_ROOT_USER"]?.trim();
  const secretAccessKey =
    process.env["S3_SECRET_KEY"]?.trim() || process.env["MINIO_ROOT_PASSWORD"]?.trim();
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    return null;
  }
  return {
    endpoint: endpoint.replace(/\/$/, ""),
    region: process.env["S3_REGION"]?.trim() || "us-east-1",
    accessKeyId,
    secretAccessKey,
    bucket: process.env["S3_BUCKET"]?.trim() || "maintafox-tenant-media",
    forcePathStyle: (process.env["S3_FORCE_PATH_STYLE"] ?? "true").toLowerCase() !== "false",
    deploymentEnv: process.env["DEPLOYMENT_ENV"]?.trim() || "dev",
  };
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
  const env = input.deploymentEnv.trim() || "dev";
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
  private bucketReady = false;

  constructor(config: ObjectStoreConfig) {
    this.config = config;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  static fromEnv(): TenantMediaObjectStore | null {
    const cfg = loadConfigFromEnv();
    if (!cfg) return null;
    return new TenantMediaObjectStore(cfg);
  }

  async ensureBucket(): Promise<void> {
    if (this.bucketReady) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.config.bucket }));
    }
    this.bucketReady = true;
  }

  async presignPut(objectKey: string, expiresInSeconds = 900): Promise<PresignResult> {
    await this.ensureBucket();
    const cmd = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: objectKey,
    });
    const url = await getSignedUrl(this.client, cmd, { expiresIn: expiresInSeconds });
    return {
      url,
      method: "PUT",
      bucket: this.config.bucket,
      object_key: objectKey,
      expires_in_seconds: expiresInSeconds,
    };
  }

  /** Health probe: the bucket answers HEAD (no creation). Throws with the provider's error. */
  async headBucket(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
  }

  /** Every object key in the bucket under `prefix` (paged; used by the off-site media backup). */
  async listObjectKeys(prefix = ""): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const obj of page.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
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
      if ((err as { name?: string }).name === "NoSuchKey") return null;
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

  /** Streams one object's content into `writeTo` (used by the off-site media backup). */
  async downloadObject(objectKey: string, writeTo: NodeJS.WritableStream): Promise<void> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: objectKey }));
    if (!out.Body) throw new Error(`object ${objectKey} has no body`);
    await pipeline(out.Body as NodeJS.ReadableStream, writeTo);
  }

  async presignGet(objectKey: string, expiresInSeconds = 900): Promise<PresignResult> {
    await this.ensureBucket();
    const cmd = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: objectKey,
    });
    const url = await getSignedUrl(this.client, cmd, { expiresIn: expiresInSeconds });
    return {
      url,
      method: "GET",
      bucket: this.config.bucket,
      object_key: objectKey,
      expires_in_seconds: expiresInSeconds,
    };
  }
}
