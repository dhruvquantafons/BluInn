// No `server-only` import: proxy.ts checks sessions through this pool too.
// `pg` cannot be bundled for the browser, so nothing here can leak there.
import { Pool, type PoolClient } from "pg";

/**
 * The connection to Neon, and the one rule every query follows: it runs in a
 * transaction under the role and claims of whoever asked, exactly as Supabase's
 * PostgREST does. That is what lets the row level security policies in
 * neon/migrations keep doing all the authorization.
 *
 *   anon           signed out (the login page)
 *   authenticated  a signed-in staff member; auth.uid() is their id
 *   service        trusted server work (crons, webhooks, staff accounts). Runs
 *                  as the connecting role, which owns the tables and so is not
 *                  subject to RLS — what Supabase's service_role key does.
 */

export type DbRole = "anon" | "authenticated" | "service";

export interface DbContext {
  role: DbRole;
  /** The JWT-style claims auth.uid(), auth.role() and auth.jwt() read. */
  claims: Record<string, unknown>;
}

export const ANON: DbContext = { role: "anon", claims: { role: "anon" } };
export const SERVICE: DbContext = { role: "service", claims: { role: "service_role" } };

export function hasDatabaseConfig() {
  return Boolean(process.env.DATABASE_URL);
}

const globalForPool = globalThis as unknown as { __bluinnPool?: Pool };

export function pool(): Pool {
  if (!globalForPool.__bluinnPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    const p = new Pool({
      connectionString,
      // A serverless function serves a handful of requests at once. Neon's
      // pooler (the "-pooler" host) multiplexes these onto real connections.
      max: Number(process.env.DATABASE_POOL_MAX ?? 5),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
    });
    // An idle connection dropped by Neon (scale to zero) must not crash the
    // process; the pool replaces it on the next checkout.
    p.on("error", () => {});
    globalForPool.__bluinnPool = p;
  }
  return globalForPool.__bluinnPool;
}

function literal(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Runs `fn` inside one transaction as the given context. Errors roll back and
 * are rethrown unchanged (they carry Postgres's code, detail and hint).
 */
export async function withContext<T>(
  ctx: DbContext,
  fn: (client: PoolClient) => Promise<T>,
  { readOnly = false }: { readOnly?: boolean } = {},
): Promise<T> {
  const client = await pool().connect();
  let broken = false;
  try {
    const claims = JSON.stringify(ctx.claims);
    const sub = typeof ctx.claims.sub === "string" ? ctx.claims.sub : "";
    const claimRole = String(ctx.claims.role ?? "");
    // One round trip: begin, switch role, publish the claims. UTC, as on
    // Supabase, so now()::date and timestamps read the same as they did there.
    await client.query(
      [
        readOnly ? "begin read only" : "begin",
        "set local time zone 'UTC'",
        ctx.role === "service" ? "" : `set local role ${ctx.role}`,
        `select set_config('request.jwt.claims', ${literal(claims)}, true),
                set_config('request.jwt.claim.sub', ${literal(sub)}, true),
                set_config('request.jwt.claim.role', ${literal(claimRole)}, true)`,
      ]
        .filter(Boolean)
        .join(";\n"),
    );
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      broken = true;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

/** A single query as the service context. For the auth and storage layers. */
export async function serviceQuery<R extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<R[]> {
  return withContext(SERVICE, async (c) => (await c.query<R>(sql, params)).rows);
}
