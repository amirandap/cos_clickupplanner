/** Configuration problems are operator errors: no `status`, so apiFailure never echoes them. */
export class ConfigError extends Error {}

export function appUrl() {
  const value = process.env.APP_URL?.trim();
  if (!value) throw new ConfigError("Falta APP_URL");
  let url: URL;
  try { url = new URL(value); } catch { throw new ConfigError("APP_URL no es una URL válida"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConfigError("APP_URL debe usar http o https");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function appOrigin() {
  return new URL(appUrl()).origin;
}

export function isSecureApp() {
  return appUrl().startsWith("https:");
}

/** The mock bypass can never be active in a production build, whatever the env says. */
export function mockBypassEnabled() {
  return process.env.USE_MOCK_DATA === "true" && process.env.NODE_ENV !== "production";
}

export function googleClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new ConfigError("Falta GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET");
  return { clientId, clientSecret };
}

/** Optional login restriction. Empty means any verified Google account may sign in. */
export function allowedDomain() {
  const value = process.env.AUTH_ALLOWED_DOMAIN?.trim().replace(/^@/, "").toLowerCase();
  return value || null;
}

export function bootstrapAdminEmail() {
  return process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() || null;
}

export function defaultTimezone() {
  return process.env.APP_TIMEZONE?.trim() || "UTC";
}
