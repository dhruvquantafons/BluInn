import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The signed-in browser's cookie on Neon deployments.
 *
 *   sb-bluinn-session = base64url({ sid, sub, iat, exp }) . HMAC-SHA256
 *
 * The signature lets proxy.ts tell a genuine, unexpired session from anything
 * else without a database round trip. It is not the whole check: every page
 * and query also confirms that the session row (sid) still exists, which is
 * how signing out and "end sessions" take effect at once.
 *
 * The "sb-" prefix is deliberate: proxy.ts clears dead sessions by that
 * prefix, whichever backend wrote them.
 *
 * No `server-only` import: proxy.ts uses this module too.
 */

export const SESSION_COOKIE = "sb-bluinn-session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Re-issued with a fresh expiry once it is this old, so active users stay signed in. */
export const SESSION_REFRESH_SECONDS = 24 * 60 * 60;

export interface SessionToken {
  sid: string;
  sub: string;
  iat: number;
  exp: number;
}

function secret(): string | null {
  const s = process.env.AUTH_SECRET;
  return s && s.length >= 32 ? s : null;
}

export function hasAuthSecret() {
  return secret() !== null;
}

function sign(payload: string, key: string) {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function encodeSession(sid: string, sub: string, iat = Math.floor(Date.now() / 1000)): string {
  const key = secret();
  if (!key) throw new Error("AUTH_SECRET is not set (32+ characters).");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ sid, sub, iat, exp: now + SESSION_TTL_SECONDS })).toString("base64url");
  return `${payload}.${sign(payload, key)}`;
}

export function decodeSession(value: string | undefined | null): SessionToken | null {
  const key = secret();
  if (!value || !key) return null;
  const [payload, mac] = value.split(".");
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload, key));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const token = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionToken;
    if (typeof token.sid !== "string" || typeof token.sub !== "string") return null;
    if (!Number.isFinite(token.exp) || token.exp * 1000 < Date.now()) return null;
    return token;
  } catch {
    return null;
  }
}

/** The cookie's attributes. httpOnly: no script ever needs to read it. */
export function sessionCookieOptions(maxAge = SESSION_TTL_SECONDS) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}
