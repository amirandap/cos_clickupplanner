import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { record, requestJson } from "@/lib/providers/http";
import { sameSecret } from "@/lib/crypto/secrets";

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const CLOCK_SKEW_SECONDS = 60;
const JWKS_TTL_MS = 3600_000;
const JWKS_MIN_REFRESH_MS = 60_000;

export class IdTokenError extends Error {
  constructor(public readonly reason: string) {
    super(`id_token inválido (${reason})`);
  }
}

type Jwk = JsonWebKey & { kid?: string };
let cache: { keys: Jwk[]; fetchedAt: number } | null = null;

async function googleKeys(forceRefresh: boolean, now: number) {
  const stale = !cache || now - cache.fetchedAt > JWKS_TTL_MS;
  const mayRefresh = !cache || now - cache.fetchedAt >= JWKS_MIN_REFRESH_MS;
  if (stale || (forceRefresh && mayRefresh)) {
    const body = await requestJson("Google OAuth", GOOGLE_JWKS_URL, {}, { retrySafe: true });
    if (!record(body) || !Array.isArray(body.keys)) throw new IdTokenError("jwks");
    cache = { keys: body.keys.filter((key): key is Jwk => record(key)), fetchedAt: now };
  }
  return cache?.keys ?? [];
}

export function resetGoogleKeyCache() {
  cache = null;
}

function decodeJson(part: string) {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return record(value) ? value : null;
  } catch { return null; }
}

export type GoogleIdentity = { sub: string; email: string; name: string | null };

/**
 * Verifies signature (RS256 against Google's JWKS), iss, aud, exp/iat, nonce
 * and email_verified. `sub` is the only stable identity, never the email.
 */
export async function verifyGoogleIdToken(idToken: string, expected: { clientId: string; nonce: string }, now = Date.now()): Promise<GoogleIdentity> {
  if (typeof idToken !== "string" || idToken.length > 8192) throw new IdTokenError("formato");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new IdTokenError("formato");
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  if (!header || !claims) throw new IdTokenError("formato");
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new IdTokenError("algoritmo");

  let key = (await googleKeys(false, now)).find((candidate) => candidate.kid === header.kid);
  if (!key) key = (await googleKeys(true, now)).find((candidate) => candidate.kid === header.kid);
  if (!key || key.kty !== "RSA") throw new IdTokenError("clave desconocida");
  let valid = false;
  try { valid = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url")); }
  catch { valid = false; }
  if (!valid) throw new IdTokenError("firma");

  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.has(claims.iss)) throw new IdTokenError("iss");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.clientId) || (audiences.length > 1 && claims.azp !== expected.clientId)) throw new IdTokenError("aud");
  const seconds = Math.floor(now / 1000);
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS <= seconds) throw new IdTokenError("exp");
  if (typeof claims.iat !== "number" || claims.iat - CLOCK_SKEW_SECONDS > seconds) throw new IdTokenError("iat");
  if (typeof claims.nonce !== "string" || !expected.nonce || !sameSecret(claims.nonce, expected.nonce)) throw new IdTokenError("nonce");
  if (claims.email_verified !== true && claims.email_verified !== "true") throw new IdTokenError("email_verified");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw new IdTokenError("sub");
  if (typeof claims.email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(claims.email) || claims.email.length > 320) throw new IdTokenError("email");
  return { sub: claims.sub, email: claims.email.toLowerCase(), name: typeof claims.name === "string" ? claims.name.slice(0, 200) : null };
}

export function emailDomain(email: string) {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}
