import { hasAuthSecret } from "../neon/session-token";

/**
 * Which backend this deployment uses, and whether it is configured.
 *
 *   Neon      DATABASE_URL (+ AUTH_SECRET). The app runs the queries itself,
 *             see app/lib/neon/. Takes precedence when set.
 *   Supabase  NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY (+ the
 *             service role key). Used by the Windows desktop build.
 *
 * Every entry point that would build a client checks this first and shows a
 * setup notice instead of throwing.
 */
export function usesNeon() {
  return Boolean(process.env.DATABASE_URL);
}

export function hasSupabaseConfig() {
  if (usesNeon()) return hasAuthSecret();
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

/**
 * Whether trusted server work (lockout tracking, creating staff logins, the
 * crons and webhooks) can run: always on Neon, and on Supabase only with the
 * service role key.
 */
export function hasServiceAccess() {
  return usesNeon() || Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
}
