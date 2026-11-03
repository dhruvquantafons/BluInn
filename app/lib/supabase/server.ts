import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { usesNeon } from "./config";
import {
  createNeonEphemeralClient,
  createNeonServiceClient,
  createNeonUserClient,
} from "../neon/client";

// Each factory below returns a Neon-backed client when DATABASE_URL is set
// (app/lib/neon/), and a real Supabase client otherwise. Both have the same
// shape, so callers never need to know which.

/**
 * Supabase client bound to the signed-in staff member's cookies.
 * Every query it makes is subject to row level security.
 */
export async function createClient() {
  const cookieStore = await cookies();

  if (usesNeon()) {
    return createNeonUserClient({
      get: (name) => cookieStore.get(name)?.value,
      set: (name, value, options) => cookieStore.set(name, value, options),
    });
  }

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // proxy.ts refreshes the session, so this is safe to ignore.
          }
        },
      },
    },
  );
}

/**
 * Service-role client. Bypasses row level security, so it is only for
 * trusted server-side work where there is no signed-in user: the nightly
 * jobs, the payment webhook and the device endpoints.
 *
 * Never import this into a Client Component.
 */
export function createServiceClient() {
  if (usesNeon()) return createNeonServiceClient();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");

  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    cookies: { getAll: () => [], setAll: () => {} },
  });
}

/**
 * Admin client for privileged auth operations — creating a staff login,
 * resetting a password, deleting an account.
 *
 * Uses supabase-js directly rather than the SSR helper, because the
 * `auth.admin` API expects a plain client with no session handling. Holds the
 * service role key, so it must never be imported into a Client Component, and
 * every caller re-checks that the requester is an administrator.
 */
export function createAdminClient() {
  if (usesNeon()) return createNeonServiceClient();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");

  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * A throwaway anonymous client that keeps no session and sets no cookies.
 * Used to check a password (re-authentication) without replacing the
 * signed-in session — which would also drop it from aal2 back to aal1.
 */
export function createEphemeralClient() {
  if (usesNeon()) return createNeonEphemeralClient();
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
