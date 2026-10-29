/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP) for vendor-console operators.
 *
 * Parameters are the ones every authenticator app supports by default: HMAC-SHA1, 6 digits,
 * 30-second steps. A code is accepted for the current step and one step either side (clock drift),
 * and never twice: the caller stores the last accepted step and passes it back (`afterStep`).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;
/** Steps accepted either side of the current one (authenticator clock drift). */
export const TOTP_DRIFT_STEPS = 1;
/** 20 bytes = 160 bits, the HMAC-SHA1 block-size recommendation of RFC 4226 §4. */
export const TOTP_SECRET_BYTES = 20;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes RFC 4648 base32 (case-insensitive, spaces and padding ignored); throws on other characters. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** HOTP value (RFC 4226 §5.3) for one counter, zero-padded to `digits`. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS, algorithm: "sha1" | "sha256" | "sha512" = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totpStep(unixSeconds: number): number {
  return Math.floor(unixSeconds / TOTP_STEP_SECONDS);
}

/**
 * Returns the matched step when `code` is valid for `nowSeconds` (± TOTP_DRIFT_STEPS) and that step
 * is later than `afterStep` (replay protection), otherwise null.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  nowSeconds: number,
  afterStep: number | null,
): number | null {
  const normalized = code.replace(/\s/g, "");
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(normalized)) return null;
  const current = totpStep(nowSeconds);
  for (let delta = -TOTP_DRIFT_STEPS; delta <= TOTP_DRIFT_STEPS; delta += 1) {
    const step = current + delta;
    if (afterStep !== null && step <= afterStep) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(normalized))) return step;
  }
  return null;
}

/** otpauth:// URI (Key Uri Format) that authenticator apps read from the enrolment QR code. */
export function otpauthUri(input: { issuer: string; accountName: string; secret: Buffer }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.accountName)}`;
  const params = new URLSearchParams({
    secret: base32Encode(input.secret),
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
