/**
 * The `age` program (https://age-encryption.org) as used by the backup tools: encryption to the
 * owner's public key on the server, decryption only where the owner provides the private key.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import { pipeline } from "node:stream/promises";

export const AGE_HEADER = "age-encryption.org/v1\n";

/** Runs `age` with `args`; rejects with its stderr when it exits non-zero. */
export function runAge(args: string[]): Promise<void> {
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

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}
