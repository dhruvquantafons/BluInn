/**
 * The sign-in routes, shared by proxy.ts and the sign-in actions. BluInn is
 * served from the root, so every other page is addressed by its plain path.
 */
export const HOME_PATH = "/";
export const LOGIN_PATH = "/login";
/** The second sign-in step, reached with a session. */
export const VERIFY_PATH = "/login/verify";

/**
 * A `next` value from the query string, kept only if it is a path on this
 * site. "//host" and "/\host" are protocol-relative to a browser, so they
 * would send a freshly signed-in user somewhere else entirely.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return HOME_PATH;
  if (/[\u0000-\u001f]/.test(next)) return HOME_PATH;
  if (next === LOGIN_PATH || next.startsWith(`${LOGIN_PATH}?`)) return HOME_PATH;
  return next;
}
