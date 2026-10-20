import { db } from "@/lib/db/client";
import { decryptToken, encryptToken } from "@/lib/crypto/tokens";

export type CredentialProvider = "google_calendar" | "clickup";
export type StoredCredential = {
  accessToken: string | null; refreshToken: string | null; expiresAt: Date | null;
  scheme: string; scopes: string | null; revokedAt: Date | null;
};

const aad = (userId: string, provider: CredentialProvider, field: "access" | "refresh") => ({ userId, provider, field });

export async function saveCredential(userId: string, provider: CredentialProvider, value: {
  accessToken: string; refreshToken?: string | null; expiresAt?: Date | null; scheme?: string; scopes?: string | null;
}) {
  const data = {
    accessTokenEnc: encryptToken(value.accessToken, aad(userId, provider, "access")),
    refreshTokenEnc: value.refreshToken ? encryptToken(value.refreshToken, aad(userId, provider, "refresh")) : null,
    expiresAt: value.expiresAt ?? null, scheme: value.scheme ?? "raw", scopes: value.scopes ?? null, revokedAt: null,
  };
  await db.userCredential.upsert({ where: { userId_provider: { userId, provider } }, create: { userId, provider, ...data }, update: data });
}

export async function getCredential(userId: string, provider: CredentialProvider): Promise<StoredCredential | null> {
  const row = await db.userCredential.findUnique({ where: { userId_provider: { userId, provider } } });
  if (!row) return null;
  return {
    accessToken: row.accessTokenEnc ? decryptToken(row.accessTokenEnc, aad(userId, provider, "access")) : null,
    refreshToken: row.refreshTokenEnc ? decryptToken(row.refreshTokenEnc, aad(userId, provider, "refresh")) : null,
    expiresAt: row.expiresAt, scheme: row.scheme, scopes: row.scopes, revokedAt: row.revokedAt,
  };
}

/** The tokens are wiped: a revoked credential is never replayed against the provider. */
export async function markRevoked(userId: string, provider: CredentialProvider, now = new Date()) {
  await db.userCredential.updateMany({ where: { userId, provider }, data: { revokedAt: now, accessTokenEnc: null, refreshTokenEnc: null, expiresAt: null } });
}

export async function deleteCredential(userId: string, provider: CredentialProvider) {
  await db.userCredential.deleteMany({ where: { userId, provider } });
}

export type ConnectionState = "connected" | "revoked" | "none";

export async function connectionStates(userId: string) {
  const rows = await db.userCredential.findMany({ where: { userId }, select: { provider: true, revokedAt: true, accessTokenEnc: true, refreshTokenEnc: true } });
  const state = (provider: CredentialProvider): ConnectionState => {
    const row = rows.find((item) => item.provider === provider);
    if (!row) return "none";
    return row.revokedAt || (!row.accessTokenEnc && !row.refreshTokenEnc) ? "revoked" : "connected";
  };
  return { googleCalendar: state("google_calendar"), clickup: state("clickup") };
}
