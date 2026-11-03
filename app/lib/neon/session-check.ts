import { pool } from "./db";

/**
 * Whether a signed session cookie still has its row in auth.sessions — false
 * once that browser, or every browser, has been signed out. Used by proxy.ts,
 * which must not wave a dead session past the login page: getSession() would
 * reject it, send it back to /login, and the two would bounce forever.
 */
export async function sessionExists(sid: string, sub: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(sid) || !/^[0-9a-f-]{36}$/i.test(sub)) return false;
  const { rowCount } = await pool().query("select 1 from auth.sessions where id = $1 and user_id = $2", [sid, sub]);
  return (rowCount ?? 0) > 0;
}
