import { NextRequest, NextResponse } from "next/server";
import { readCookie, sessionCookieName } from "@/lib/auth/cookies";

// The proxy only checks that a session cookie exists, which is a cheap first
// gate. Handlers and pages validate it against the database (requireUser).
const PUBLIC_PATHS = ["/login", "/api/auth/login"];

function isPublic(pathname: string) {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/** Never active in a production build, whatever USE_MOCK_DATA says. */
function mockBypass() {
  return process.env.USE_MOCK_DATA === "true" && process.env.NODE_ENV !== "production";
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublic(pathname) || mockBypass() || readCookie(request.headers.get("cookie"), sessionCookieName())) {
    return NextResponse.next();
  }
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Se requiere autenticación." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  // Behind a reverse proxy request.url carries the internal host, so prefer APP_URL.
  const base = process.env.APP_URL?.trim() || request.url;
  return NextResponse.redirect(new URL("/login", base), { headers: { "Cache-Control": "no-store" } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
