import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { hasSupabaseConfig, usesNeon } from "./app/lib/supabase/config";
import {
  SESSION_COOKIE,
  SESSION_REFRESH_SECONDS,
  SESSION_TTL_SECONDS,
  decodeSession,
  encodeSession,
  sessionCookieOptions,
} from "./app/lib/neon/session-token";
import { sessionExists } from "./app/lib/neon/session-check";
import {
  SUPABASE_COOKIE_PREFIX,
  TWO_FACTOR_COOKIE,
  TWO_FACTOR_COOKIE_PATH,
} from "./app/lib/session-cookies";
import { HOME_PATH, LOGIN_PATH, VERIFY_PATH } from "./app/lib/routes";

/**
 * Refreshes the session cookie on every page request and bounces signed-out
 * visitors to the login page — a Supabase session, or on Neon the app's own
 * (app/lib/neon/session-token.ts).
 *
 * Next.js 16 renamed the `middleware` convention to `proxy`; Supabase's own
 * docs still show the old name. Authorization is NOT decided here alone —
 * every page and server action re-checks via requireStaff().
 */
export async function proxy(request: NextRequest) {
  // Without credentials there is no session to refresh. The pages render
  // a setup notice instead, so let the request through rather than erroring.
  if (!hasSupabaseConfig()) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  let user: { id: string } | null;
  let authError: unknown;

  if (usesNeon()) {
    // Neon: a signed cookie whose session row still exists (see
    // app/lib/neon/session-token.ts). Re-issued once a day so an active
    // user is never signed out mid-shift.
    const raw = request.cookies.get(SESSION_COOKIE)?.value;
    const token = decodeSession(raw);
    let alive = false;
    if (token) {
      try {
        alive = await sessionExists(token.sid, token.sub);
      } catch {
        // Database unreachable: let the page report it rather than signing
        // everyone out.
        return response;
      }
    }
    user = alive && token ? { id: token.sub } : null;
    authError = raw && !user ? new Error("session expired") : null;
    if (alive && token && Date.now() / 1000 - (token.exp - SESSION_TTL_SECONDS) > SESSION_REFRESH_SECONDS) {
      response.cookies.set(SESSION_COOKIE, encodeSession(token.sid, token.sub, token.iat), sessionCookieOptions());
    }
  } else {
    ({ user, authError } = await supabaseUser(request, (r) => (response = r)));
  }

  return decide(request, response, user, authError);
}

/**
 * Supabase: refreshes the session cookie through @supabase/ssr. The response
 * is rebuilt whenever cookies change, and handed back through setResponse.
 */
async function supabaseUser(request: NextRequest, setResponse: (r: NextResponse) => void) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
          setResponse(response);
        },
      },
    },
  );

  // getUser() revalidates the token with Supabase; getSession() would trust
  // whatever the cookie claims, so it must not be used for a security check.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  return { user, authError };
}

function decide(request: NextRequest, response: NextResponse, user: { id: string } | null, authError: unknown) {
  // A session cookie whose refresh token no longer exists in the project —
  // after the project was swapped, its auth data reset, or the token revoked —
  // is retried on every request and never recovers on its own, because the
  // browser keeps sending it. Expire it here so one redirect to the login page
  // ends it, rather than every page load failing the same way.
  //
  // Only when Supabase actually rejected something: a visitor with no cookie
  // at all reports a missing session, and there is nothing to clear.
  const staleSession =
    Boolean(authError) &&
    !user &&
    request.cookies.getAll().some((c) => c.name.startsWith(SUPABASE_COOKIE_PREFIX));

  const clearStaleSession = (res: NextResponse) => {
    if (!staleSession) return res;
    for (const cookie of request.cookies.getAll()) {
      if (cookie.name.startsWith(SUPABASE_COOKIE_PREFIX)) {
        res.cookies.set({ name: cookie.name, value: "", path: "/", maxAge: 0 });
      }
    }
    // The second-factor marker is bound to a user who is no longer signed in.
    res.cookies.set({
      name: TWO_FACTOR_COOKIE,
      value: "",
      path: TWO_FACTOR_COOKIE_PATH,
      maxAge: 0,
    });
    return res;
  };

  const { pathname } = request.nextUrl;
  const isLoginRoute = pathname === LOGIN_PATH;
  const isVerifyRoute = pathname === VERIFY_PATH;

  if (!user && !isLoginRoute) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = LOGIN_PATH;
    loginUrl.search = "";
    if (!isVerifyRoute && pathname !== HOME_PATH) loginUrl.searchParams.set("next", pathname);
    return clearStaleSession(NextResponse.redirect(loginUrl));
  }

  if (user && isLoginRoute) {
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = HOME_PATH;
    homeUrl.search = "";
    return NextResponse.redirect(homeUrl);
  }

  return clearStaleSession(response);
}

export const config = {
  matcher: [
    /*
     * Every page. Left out: the API routes, which authenticate each caller
     * with their own secret or signature, and the static and metadata files
     * the login page itself needs.
     */
    "/((?!api/|_next/static|_next/image|icon.svg|favicon.ico|robots.txt).*)",
  ],
};
