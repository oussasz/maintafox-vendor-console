/**
 * HTTP helpers shared by the route families: CORS policy, rate limiters, request validation and
 * pagination, and the request types set by the auth middlewares.
 */
import type cors from "cors";
import type express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import { CONSOLE_CORS_ORIGINS, DESKTOP_APP_ORIGINS, isDeviceRoute } from "./config.js";

/**
 * Admin/console routes: only CORS_ORIGIN (credentialed). Device routes additionally accept
 * DESKTOP_APP_ORIGINS, without credentials — the desktop authenticates with a Bearer header.
 */
export const corsOptionsDelegate: cors.CorsOptionsDelegate<express.Request> = (req, callback) => {
  const origin = req.header("Origin");
  if (
    origin &&
    !CONSOLE_CORS_ORIGINS.includes(origin) &&
    DESKTOP_APP_ORIGINS.includes(origin) &&
    isDeviceRoute(req.path)
  ) {
    callback(null, { origin, credentials: false });
    return;
  }
  callback(null, { origin: CONSOLE_CORS_ORIGINS, credentials: true });
};

function rateLimitedResponse(_req: express.Request, res: express.Response): void {
  res.status(429).json({ error: "rate_limited", message: "Too many requests; retry later." });
}

/** Brute-force guard on password login (per client IP). */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: rateLimitedResponse,
});

/** Password re-verification for privileged actions (per authenticated operator). */
export const stepUpRateLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `user:${(req as AuthRequest).userId ?? "unknown"}`,
  handler: rateLimitedResponse,
});

/** Licence-key guessing guard on activation preview/claim (per client IP). */
export const activationRateLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: rateLimitedResponse,
});

/** Public checkout creates tenants from unauthenticated input (per client IP). */
export const publicCheckoutRateLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: rateLimitedResponse,
});

/** Per activated machine; desktop retries with backoff on 429 (sync RATE_LIMIT class). */
export const deviceRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const act = (req as express.Request & { activation?: ActivationAuthContext }).activation;
    return act ? `device:${act.tenantId}:${act.machineFingerprint}` : `ip:${req.ip ?? "unknown"}`;
  },
  handler: rateLimitedResponse,
});

export function sendValidationError(
  res: express.Response,
  parsed: z.SafeParseError<unknown>,
  source: "body" | "query" | "params" = "body",
): void {
  res.status(400).json({
    error: "invalid_request",
    source,
    details: parsed.error.flatten(),
  });
}

const PaginationQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  with_pagination: z.coerce.boolean().optional(),
});

export function parsePagination(query: unknown): {
  cursor: string | null;
  limit: number;
  withPagination: boolean;
} {
  const parsed = PaginationQuery.safeParse(query);
  if (!parsed.success) {
    return { cursor: null, limit: 50, withPagination: false };
  }
  const cursor = parsed.data.cursor?.trim() || null;
  const limit = parsed.data.limit ?? 50;
  const withPagination = parsed.data.with_pagination === true || cursor !== null || parsed.data.limit !== undefined;
  return { cursor, limit, withPagination };
}

export type AuthRequest = express.Request & { userId?: string };

export type IdempotentResponse = {
  status: number;
  body: unknown;
};

export function resolveActorId(req: express.Request): string {
  return `user_${(req as AuthRequest).userId ?? "anonymous"}`;
}

export type ActivationAuthContext = {
  tenantId: string;
  licenseId: string;
  machineFingerprint: string;
  /** Raw bearer token (echoed by policy-refresh for desktop claim schema). */
  token: string;
  /** Token issue time, seconds since epoch. */
  tokenIssuedAt: number;
};
