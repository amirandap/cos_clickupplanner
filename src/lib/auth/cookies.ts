// Dependency-free so the Next proxy can import it. It only checks that a
// cookie is present, requireUser() does the real validation against the DB.
export function secureCookies() {
  return (process.env.APP_URL ?? "").trim().toLowerCase().startsWith("https:");
}

/** `__Host-` pins the cookie to the exact host over HTTPS. Plain HTTP (local dev) cannot use it. */
export function sessionCookieName(secure = secureCookies()) {
  return secure ? "__Host-planner_session" : "planner_session";
}

export const FLOW_COOKIE = "planner_oauth_flow";
export const FLOW_COOKIE_PATH = "/api/auth";

export function readCookie(header: string | null, name: string) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim() || undefined;
  }
  return undefined;
}

export function cookieAttributes(options: { path: string; maxAgeSeconds: number }) {
  return `Path=${options.path}; Max-Age=${options.maxAgeSeconds}; HttpOnly; SameSite=Lax${secureCookies() ? "; Secure" : ""}`;
}
