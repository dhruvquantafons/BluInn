import "server-only";
import { PostgrestClient } from "@supabase/postgrest-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ANON, SERVICE, type DbContext } from "./db";
import { createNeonAuth, type CookieAdapter } from "./auth";
import { REST_URL, restFetch } from "./rest";
import { createNeonStorage } from "./storage";

/**
 * A supabase-js-shaped client backed by Neon.
 *
 * `.from()` and `.rpc()` are supabase-js's own query builder, pointed at the
 * in-process PostgREST in rest.ts; `.auth` and `.storage` are the Neon
 * implementations in auth.ts and storage.ts. The rest of the app receives a
 * SupabaseClient and cannot tell the difference — which is the point: the
 * hundreds of queries written against Supabase run unchanged.
 */
function build(context: () => Promise<DbContext>, cookies: CookieAdapter | null, service: boolean) {
  const auth = createNeonAuth(cookies);
  const ctx = service ? () => Promise.resolve(SERVICE) : context;
  const rest = new PostgrestClient(REST_URL, { fetch: restFetch(ctx), retry: false });
  const client = {
    from: (relation: string) => rest.from(relation),
    rpc: (fn: string, args?: Record<string, unknown>, options?: Parameters<typeof rest.rpc>[2]) =>
      rest.rpc(fn, args, options),
    schema: (name: string) => rest.schema(name),
    auth,
    storage: createNeonStorage(ctx),
    // Realtime has no counterpart on Neon; LiveRefresh polls instead.
    channel: () => {
      throw new Error("Realtime is not available on the Neon backend");
    },
    removeChannel: async () => "ok" as const,
  };
  return client as unknown as SupabaseClient;
}

/** Signed-in requests: queries run as `authenticated` with this user's claims. */
export function createNeonUserClient(cookies: CookieAdapter) {
  let auth: ReturnType<typeof createNeonAuth> | null = null;
  const client = build(() => auth!.context(), cookies, false);
  auth = (client as unknown as { auth: ReturnType<typeof createNeonAuth> }).auth;
  return client;
}

/** Trusted server work: bypasses row level security, as the service role did. */
export function createNeonServiceClient() {
  return build(() => Promise.resolve(SERVICE), null, true);
}

/** No cookies, no session kept: for checking a password without signing in. */
export function createNeonEphemeralClient() {
  return build(() => Promise.resolve(ANON), null, false);
}
