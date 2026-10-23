import { ProviderPayloadError, record } from "../providers/http";

function accessToken(value: unknown, provider: string) {
  if (!record(value) || typeof value.access_token !== "string" || !value.access_token.trim()
    || (value.refresh_token !== undefined && typeof value.refresh_token !== "string")) {
    throw new ProviderPayloadError(provider, "credencial");
  }
  return { accessToken: value.access_token, refreshToken: typeof value.refresh_token === "string" ? value.refresh_token : undefined };
}

export function validateGoogleToken(value: unknown, now = Date.now()) {
  const token = accessToken(value, "Google OAuth");
  if (!record(value) || typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0) {
    throw new ProviderPayloadError("Google OAuth", "vencimiento");
  }
  const expiresAt = new Date(now + value.expires_in * 1000);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now) {
    throw new ProviderPayloadError("Google OAuth", "vencimiento");
  }
  const scope = typeof value.scope === "string" ? value.scope : null;
  return { ...token, expiresAt, scope };
}
