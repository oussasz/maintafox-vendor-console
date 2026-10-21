/**
 * Process-level helpers shared by the whole API: async error forwarding for Express 4, startup
 * failure, required environment, structured JSON logs, ids/hashes and small value helpers.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { writeSync } from "node:fs";

import type express from "express";

/**
 * Express 4 does not catch a rejected promise from an async handler (the request would hang and
 * the rejection would be unhandled). Wrap every handler registered through the app's routing
 * methods so a rejection reaches next(err) and the final error handler. Error handlers (4 args)
 * are left as they are so Express still recognises them by arity.
 */
export function forwardAsyncErrors(target: express.Express): void {
  type Handler = (req: express.Request, res: express.Response, next: express.NextFunction) => unknown;
  const wrap = (fn: unknown): unknown => {
    if (typeof fn !== "function" || fn.length === 4) return fn;
    const handler = fn as Handler;
    return function asyncSafe(req: express.Request, res: express.Response, next: express.NextFunction) {
      try {
        const out = handler(req, res, next);
        if (out && typeof (out as Promise<unknown>).catch === "function") {
          (out as Promise<unknown>).catch(next);
        }
      } catch (err) {
        next(err);
      }
    };
  };
  for (const method of ["use", "get", "post", "put", "patch", "delete"] as const) {
    const original = (target[method] as (...args: unknown[]) => unknown).bind(target);
    (target as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
      original(...args.map((a) => (Array.isArray(a) ? a.map(wrap) : wrap(a))));
  }
}

/**
 * Startup failure: write synchronously (stderr is an async pipe on Windows, so console.error
 * followed by process.exit can drop the message) and exit non-zero.
 */
export function fatal(message: string): never {
  writeSync(2, `FATAL: ${message}
`);
  process.exit(1);
}

/** Required configuration: the process refuses to start rather than run on a hidden default. */
export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    fatal(`environment variable ${name} is required (see .env.example).`);
  }
  return value;
}

export function structuredLog(event: string, payload: Record<string, unknown>): void {
  // JSON line output is intentionally stable for log shipping/alert parsers.
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...payload,
    }),
  );
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export function randomLicenseKey(): string {
  return `MFX-${randomBytes(4).toString("hex").toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export type ForceUpdateMode = "off" | "required" | "emergency" | "inherit";

/** Constant-time comparison of two secrets (webhook signature, scrape token). */
export function safeEqualUtf8(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
