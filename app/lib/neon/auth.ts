import "server-only";
import QRCode from "qrcode";
import { PRODUCT } from "../app-config";
import { ANON, serviceQuery, type DbContext } from "./db";
import { hashPassword, verifyPassword } from "./password";
import { newSecret, otpauthUri, verifyCode } from "./totp";
import {
  SESSION_COOKIE,
  SESSION_REFRESH_SECONDS,
  SESSION_TTL_SECONDS,
  decodeSession,
  encodeSession,
  sessionCookieOptions,
} from "./session-token";

/**
 * Sign-in, sessions and authenticator apps on Neon — the parts of Supabase
 * Auth this app uses, with the same method names and result shapes as
 * supabase-js's `auth` object, so the call sites did not change.
 *
 * Users live in auth.users, sessions in auth.sessions, authenticators in
 * auth.mfa_factors (db/platform.sql). All of it is reached as the service
 * context: the API roles have no access to the auth schema.
 */

export interface CookieAdapter {
  get(name: string): string | undefined;
  /** May throw in a Server Component, where cookies are read-only. */
  set(name: string, value: string, options: ReturnType<typeof sessionCookieOptions>): void;
}

interface AuthError {
  message: string;
  status: number;
  code?: string;
}

interface FactorRow extends Record<string, unknown> {
  id: string;
  friendly_name: string | null;
  factor_type: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface UserRow extends Record<string, unknown> {
  id: string;
  email: string;
  encrypted_password: string | null;
  raw_user_meta_data: Record<string, unknown>;
  raw_app_meta_data: Record<string, unknown>;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  aal: string;
  amr: { method: string; timestamp: number }[];
  created_at: string;
  refreshed_at: string;
}

export interface NeonUser {
  id: string;
  aud: "authenticated";
  role: "authenticated";
  email: string;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
  created_at: string;
  updated_at: string;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
  factors: (FactorRow & { factor_type: "totp"; status: "verified" | "unverified" })[];
}

function fail(message: string, status = 400, code?: string): AuthError {
  return { message, status, code };
}

async function loadUser(id: string): Promise<NeonUser | null> {
  const [row] = await serviceQuery<UserRow>("select * from auth.users where id = $1", [id]);
  if (!row) return null;
  const factors = await serviceQuery<FactorRow>(
    "select id, friendly_name, factor_type, status, created_at, updated_at from auth.mfa_factors where user_id = $1 order by created_at",
    [id],
  );
  return toUser(row, factors);
}

function toUser(row: UserRow, factors: FactorRow[]): NeonUser {
  return {
    id: row.id,
    aud: "authenticated",
    role: "authenticated",
    email: row.email,
    email_confirmed_at: row.email_confirmed_at,
    last_sign_in_at: row.last_sign_in_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    user_metadata: row.raw_user_meta_data ?? {},
    app_metadata: { provider: "email", ...(row.raw_app_meta_data ?? {}) },
    factors: factors as NeonUser["factors"],
  };
}

function claimsFor(user: NeonUser, session: SessionRow, iat: number) {
  return {
    sub: user.id,
    role: "authenticated",
    aud: "authenticated",
    email: user.email,
    aal: session.aal,
    amr: session.amr,
    session_id: session.id,
    iat,
    user_metadata: user.user_metadata,
    app_metadata: user.app_metadata,
  };
}

/** The signed-in state behind one request: cookie → session row → user. */
interface Current {
  user: NeonUser;
  session: SessionRow;
  iat: number;
}

export function createNeonAuth(cookies: CookieAdapter | null) {
  let current: Promise<Current | null> | null = null;

  function writeCookie(value: string, maxAge?: number) {
    if (!cookies) return;
    try {
      cookies.set(SESSION_COOKIE, value, sessionCookieOptions(maxAge));
    } catch {
      // A Server Component cannot set cookies. proxy.ts refreshes them on the
      // next navigation, and actions (which can) are where sessions change.
    }
  }

  function resolve(): Promise<Current | null> {
    if (!current) {
      current = (async () => {
        const token = decodeSession(cookies?.get(SESSION_COOKIE));
        if (!token) return null;
        const [session] = await serviceQuery<SessionRow>(
          "select * from auth.sessions where id = $1 and user_id = $2",
          [token.sid, token.sub],
        );
        if (!session) return null;
        const user = await loadUser(session.user_id);
        if (!user) return null;
        // Keep active sessions alive, at most once a day.
        if (Date.now() / 1000 - (token.exp - SESSION_TTL_SECONDS) > SESSION_REFRESH_SECONDS) {
          writeCookie(encodeSession(session.id, user.id, token.iat));
          void serviceQuery("update auth.sessions set refreshed_at = now() where id = $1", [session.id]).catch(() => {});
        }
        return { user, session, iat: token.iat };
      })();
    }
    return current;
  }

  async function startSession(user: NeonUser, ephemeral: boolean) {
    const now = Math.floor(Date.now() / 1000);
    const [session] = await serviceQuery<SessionRow>(
      `insert into auth.sessions (user_id, aal, amr) values ($1, 'aal1', $2::jsonb) returning *`,
      [user.id, JSON.stringify([{ method: "password", timestamp: now }])],
    );
    await serviceQuery("update auth.users set last_sign_in_at = now() where id = $1", [user.id]);
    if (!ephemeral) {
      writeCookie(encodeSession(session.id, user.id, now));
      current = Promise.resolve({ user, session, iat: now });
    }
    return session;
  }

  async function requireCurrent(): Promise<Current | AuthError> {
    const c = await resolve();
    return c ?? fail("Auth session missing!", 401, "session_not_found");
  }

  const auth = {
    /** The claims RLS sees for this request. */
    async context(): Promise<DbContext> {
      const c = await resolve();
      if (!c) return ANON;
      return { role: "authenticated", claims: claimsFor(c.user, c.session, c.iat) };
    },

    async getUser() {
      const c = await resolve();
      if (!c) return { data: { user: null }, error: fail("Auth session missing!", 401, "session_not_found") };
      return { data: { user: c.user }, error: null };
    },

    async getSession() {
      const c = await resolve();
      return { data: { session: c ? { user: c.user, expires_at: null } : null }, error: null };
    },

    async getClaims() {
      const c = await resolve();
      if (!c) return { data: null, error: fail("Auth session missing!", 401) };
      return { data: { claims: claimsFor(c.user, c.session, c.iat) }, error: null };
    },

    async signInWithPassword({ email, password }: { email: string; password: string }) {
      const [row] = await serviceQuery<UserRow>("select * from auth.users where lower(email) = lower($1)", [email.trim()]);
      // Hash even when there is no such user, so timing does not reveal
      // which emails have accounts.
      const ok = await verifyPassword(password, row?.encrypted_password ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AA==");
      if (!row || !ok) {
        return { data: { user: null, session: null }, error: fail("Invalid login credentials", 400, "invalid_credentials") };
      }
      const user = (await loadUser(row.id))!;
      const session = await startSession(user, !cookies);
      return { data: { user, session: { id: session.id, user } }, error: null };
    },

    async signOut({ scope = "global" }: { scope?: "global" | "local" | "others" } = {}) {
      const c = await resolve();
      if (c) {
        if (scope === "local") await serviceQuery("delete from auth.sessions where id = $1", [c.session.id]);
        else if (scope === "others") {
          await serviceQuery("delete from auth.sessions where user_id = $1 and id <> $2", [c.user.id, c.session.id]);
        } else await serviceQuery("delete from auth.sessions where user_id = $1", [c.user.id]);
      }
      if (scope !== "others") {
        writeCookie("", 0);
        current = Promise.resolve(null);
      }
      return { error: null };
    },

    async updateUser(attrs: { password?: string; data?: Record<string, unknown>; email?: string }) {
      const c = await requireCurrent();
      if ("message" in c) return { data: { user: null }, error: c };
      if (attrs.email !== undefined) return { data: { user: null }, error: fail("Changing the email is not supported here.", 400) };
      if (attrs.password !== undefined) {
        await serviceQuery("update auth.users set encrypted_password = $2, updated_at = now() where id = $1", [
          c.user.id,
          await hashPassword(attrs.password),
        ]);
      }
      if (attrs.data) {
        await serviceQuery(
          "update auth.users set raw_user_meta_data = raw_user_meta_data || $2::jsonb, updated_at = now() where id = $1",
          [c.user.id, JSON.stringify(attrs.data)],
        );
      }
      const user = (await loadUser(c.user.id))!;
      current = Promise.resolve({ ...c, user });
      return { data: { user }, error: null };
    },

    mfa: {
      async listFactors() {
        const c = await requireCurrent();
        if ("message" in c) return { data: null, error: c };
        const all = c.user.factors;
        return {
          data: { all, totp: all.filter((f) => f.factor_type === "totp" && f.status === "verified"), phone: [] },
          error: null,
        };
      },

      async enroll({ friendlyName }: { factorType: "totp"; friendlyName?: string; issuer?: string }) {
        const c = await requireCurrent();
        if ("message" in c) return { data: null, error: c };
        const secret = newSecret();
        const [factor] = await serviceQuery<{ id: string }>(
          `insert into auth.mfa_factors (user_id, friendly_name, factor_type, status, secret)
           values ($1, $2, 'totp', 'unverified', $3) returning id`,
          [c.user.id, friendlyName ?? null, secret],
        );
        const uri = otpauthUri(secret, c.user.email, PRODUCT.name);
        const qr_code = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
        current = null;
        return {
          data: { id: factor.id, type: "totp" as const, friendly_name: friendlyName ?? null, totp: { qr_code, secret, uri } },
          error: null,
        };
      },

      async unenroll({ factorId }: { factorId: string }) {
        const c = await requireCurrent();
        if ("message" in c) return { data: null, error: c };
        await serviceQuery("delete from auth.mfa_factors where id = $1 and user_id = $2", [factorId, c.user.id]);
        current = null;
        return { data: { id: factorId }, error: null };
      },

      async challengeAndVerify({ factorId, code }: { factorId: string; code: string }) {
        const c = await requireCurrent();
        if ("message" in c) return { data: null, error: c };
        const [factor] = await serviceQuery<{ id: string; secret: string; last_used_step: string | null }>(
          "select id, secret, last_used_step from auth.mfa_factors where id = $1 and user_id = $2",
          [factorId, c.user.id],
        );
        if (!factor) return { data: null, error: fail("Factor not found", 404, "mfa_factor_not_found") };
        const step = verifyCode(factor.secret, code);
        if (step === null || (factor.last_used_step !== null && step <= Number(factor.last_used_step))) {
          return { data: null, error: fail("Invalid TOTP code entered", 422, "mfa_verification_failed") };
        }
        await serviceQuery(
          "update auth.mfa_factors set status = 'verified', last_used_step = $2, updated_at = now() where id = $1",
          [factor.id, step],
        );
        const amr = [...c.session.amr.filter((a) => a.method !== "totp"), { method: "totp", timestamp: Math.floor(Date.now() / 1000) }];
        const [session] = await serviceQuery<SessionRow>(
          "update auth.sessions set aal = 'aal2', amr = $2::jsonb, refreshed_at = now() where id = $1 returning *",
          [c.session.id, JSON.stringify(amr)],
        );
        const user = (await loadUser(c.user.id))!;
        current = Promise.resolve({ user, session, iat: c.iat });
        return { data: { user }, error: null };
      },

      async getAuthenticatorAssuranceLevel() {
        const c = await resolve();
        if (!c) return { data: { currentLevel: null, nextLevel: null, currentAuthenticationMethods: [] }, error: null };
        const hasVerified = c.user.factors.some((f) => f.status === "verified");
        return {
          data: {
            currentLevel: c.session.aal,
            nextLevel: hasVerified ? "aal2" : c.session.aal,
            currentAuthenticationMethods: c.session.amr,
          },
          error: null,
        };
      },
    },

    admin: {
      async createUser({
        email,
        password,
        user_metadata = {},
      }: {
        email: string;
        password?: string;
        email_confirm?: boolean;
        user_metadata?: Record<string, unknown>;
      }) {
        try {
          const [row] = await serviceQuery<UserRow>(
            `insert into auth.users (email, encrypted_password, raw_user_meta_data, email_confirmed_at)
             values (lower($1), $2, $3::jsonb, now()) returning *`,
            [email.trim(), password ? await hashPassword(password) : null, JSON.stringify(user_metadata)],
          );
          return { data: { user: toUser(row, []) }, error: null };
        } catch (err) {
          if ((err as { code?: string }).code === "23505") {
            return {
              data: { user: null },
              error: fail("A user with this email address has already been registered", 422, "email_exists"),
            };
          }
          return { data: { user: null }, error: fail((err as Error).message, 500) };
        }
      },

      async deleteUser(id: string) {
        try {
          await serviceQuery("delete from auth.users where id = $1", [id]);
          return { data: { user: null }, error: null };
        } catch (err) {
          return { data: { user: null }, error: fail((err as Error).message, 400) };
        }
      },

      async updateUserById(id: string, attrs: { password?: string; user_metadata?: Record<string, unknown> }) {
        if (attrs.password !== undefined) {
          await serviceQuery("update auth.users set encrypted_password = $2, updated_at = now() where id = $1", [
            id,
            await hashPassword(attrs.password),
          ]);
        }
        if (attrs.user_metadata) {
          await serviceQuery(
            "update auth.users set raw_user_meta_data = raw_user_meta_data || $2::jsonb, updated_at = now() where id = $1",
            [id, JSON.stringify(attrs.user_metadata)],
          );
        }
        const user = await loadUser(id);
        if (!user) return { data: { user: null }, error: fail("User not found", 404, "user_not_found") };
        return { data: { user }, error: null };
      },

      mfa: {
        async listFactors({ userId }: { userId: string }) {
          const factors = await serviceQuery<FactorRow>(
            "select id, friendly_name, factor_type, status, created_at, updated_at from auth.mfa_factors where user_id = $1",
            [userId],
          );
          return { data: { factors }, error: null };
        },
        async deleteFactor({ userId, id }: { userId: string; id: string }) {
          await serviceQuery("delete from auth.mfa_factors where id = $1 and user_id = $2", [id, userId]);
          return { data: { id }, error: null };
        },
      },
    },
  };

  return auth;
}

export type NeonAuth = ReturnType<typeof createNeonAuth>;
