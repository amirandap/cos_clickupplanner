/**
 * One-off, idempotent step after `prisma migrate deploy` of the multiuser migration.
 *
 * The migration attached all pre-existing rows to the placeholder user
 * `legacy-single-user`. This script moves the old global configuration (env vars)
 * into that user's UserSettings and re-stores the plaintext OAuthCredential rows
 * (plus CLICKUP_TOKEN / GOOGLE_REFRESH_TOKEN, if still set) as encrypted
 * UserCredential rows. The first eligible login (BOOTSTRAP_ADMIN_EMAIL, or the
 * first person to sign in) then claims the placeholder and inherits everything.
 *
 * Usage (needs DATABASE_URL and TOKEN_ENCRYPTION_KEY, plus the OLD env vars):
 *   npx tsx prisma/migrate-single-user.ts
 *
 * Secrets are never printed. Back up the SQLite file first.
 */
import { PrismaClient } from "@prisma/client";
import { encryptToken } from "../src/lib/crypto/tokens";

const LEGACY_USER_ID = "legacy-single-user";
type Env = Record<string, string | undefined>;
type Report = { legacyUser: boolean; claimed: boolean; settingsFilled: string[]; credentialsMoved: string[]; legacyRowsDeleted: number };

function credentialData(userId: string, provider: string, access: string | null, refresh: string | null, extra: { expiresAt?: Date | null; scheme?: string }) {
  return {
    accessTokenEnc: access ? encryptToken(access, { userId, provider, field: "access" }) : null,
    refreshTokenEnc: refresh ? encryptToken(refresh, { userId, provider, field: "refresh" }) : null,
    expiresAt: extra.expiresAt ?? null, scheme: extra.scheme ?? "raw", revokedAt: null,
  };
}

export async function migrateSingleUser(db: PrismaClient, env: Env = process.env): Promise<Report> {
  const report: Report = { legacyUser: false, claimed: false, settingsFilled: [], credentialsMoved: [], legacyRowsDeleted: 0 };
  const user = await db.user.findUnique({ where: { id: LEGACY_USER_ID } });
  if (!user) return report; // Fresh database, or nothing to migrate.
  report.legacyUser = true;
  report.claimed = !user.googleSub.startsWith("pending:");

  // 1. Global config -> UserSettings. Only fields still at their default are filled, so a re-run never undoes the user's edits.
  const settings = await db.userSettings.upsert({ where: { userId: user.id }, update: {}, create: { userId: user.id } });
  const patch: Record<string, string> = {};
  const wanted: [string, string | undefined, string][] = [
    ["calendarId", env.GOOGLE_CALENDAR_ID?.trim(), "primary"],
    ["listIds", env.CLICKUP_LIST_IDS?.trim(), ""],
    ["timezone", env.APP_TIMEZONE?.trim(), "UTC"],
    ["clickupUserId", env.CLICKUP_DEFAULT_ASSIGNEE_ID?.trim(), ""],
  ];
  for (const [field, value, fallback] of wanted) {
    const current = (settings as Record<string, unknown>)[field];
    if (value && (current === null || current === fallback || current === undefined)) { patch[field] = value; report.settingsFilled.push(field); }
  }
  if (Object.keys(patch).length) await db.userSettings.update({ where: { userId: user.id }, data: patch });

  // 2. Plaintext credentials -> encrypted per-user credentials.
  const existing = new Set((await db.userCredential.findMany({ where: { userId: user.id }, select: { provider: true } })).map((row) => row.provider));
  const legacy = await db.legacyOAuthCredential.findMany();
  const google = legacy.find((row) => row.provider === "google");
  const clickup = legacy.find((row) => row.provider === "clickup");

  const googleRefresh = google?.refreshToken ?? env.GOOGLE_REFRESH_TOKEN?.trim() ?? null;
  if (googleRefresh && !existing.has("google_calendar")) {
    // The stored access token is only kept while the refresh token is also present. It is refreshed on first use anyway.
    await db.userCredential.create({ data: { userId: user.id, provider: "google_calendar", ...credentialData(user.id, "google_calendar", google?.accessToken ?? null, googleRefresh, { expiresAt: google?.expiresAt }) } });
    report.credentialsMoved.push("google_calendar");
  }
  const personal = env.CLICKUP_TOKEN?.trim();
  if ((personal || clickup) && !existing.has("clickup")) {
    const bearer = personal?.startsWith("Bearer ");
    const token = personal ? (bearer ? personal.slice(7) : personal) : clickup!.accessToken;
    await db.userCredential.create({ data: { userId: user.id, provider: "clickup", ...credentialData(user.id, "clickup", token, null, { scheme: personal && !bearer ? "raw" : "bearer" }) } });
    report.credentialsMoved.push("clickup");
  }

  // 3. Only now are the plaintext rows removed.
  const deleted = await db.legacyOAuthCredential.deleteMany({});
  report.legacyRowsDeleted = deleted.count;
  return report;
}

if (require.main === module) {
  const db = new PrismaClient();
  migrateSingleUser(db)
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (report.legacyUser && !report.claimed) console.log("El usuario existente se asignará al primer inicio de sesión elegible (BOOTSTRAP_ADMIN_EMAIL si está definido).");
    })
    .catch((error: unknown) => { console.error("Migración fallida:", error instanceof Error ? error.message : error); process.exitCode = 1; })
    .finally(() => db.$disconnect());
}
