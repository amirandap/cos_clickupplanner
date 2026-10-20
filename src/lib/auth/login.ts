import { db } from "@/lib/db/client";
import { allowedDomain, bootstrapAdminEmail } from "@/lib/config/env";
import { emailDomain, type GoogleIdentity } from "@/lib/auth/id-token";

export const LEGACY_USER_ID = "legacy-single-user";
export const LEGACY_SUB_PREFIX = "pending:";

export class DomainNotAllowedError extends Error {}

export function assertDomainAllowed(email: string) {
  const domain = allowedDomain();
  if (domain && emailDomain(email) !== domain) throw new DomainNotAllowedError("Dominio no permitido");
}

/**
 * Finds the user by Google `sub`. The first eligible login claims the user that
 * holds the pre-multiuser data (BOOTSTRAP_ADMIN_EMAIL, when set, decides who is
 * eligible). The claim is a conditional update, so concurrent logins cannot both win.
 */
export async function userForIdentity(identity: GoogleIdentity, now = new Date()) {
  const existing = await db.user.findUnique({ where: { googleSub: identity.sub } });
  if (existing) {
    return db.user.update({ where: { id: existing.id }, data: { email: identity.email, name: identity.name, lastLoginAt: now } });
  }
  const legacy = await db.user.findUnique({ where: { id: LEGACY_USER_ID } });
  const admin = bootstrapAdminEmail();
  if (legacy?.googleSub.startsWith(LEGACY_SUB_PREFIX) && (!admin || admin === identity.email)) {
    const claimed = await db.user.updateMany({
      where: { id: LEGACY_USER_ID, googleSub: legacy.googleSub },
      data: { googleSub: identity.sub, email: identity.email, name: identity.name, lastLoginAt: now },
    });
    if (claimed.count === 1) return db.user.findUniqueOrThrow({ where: { id: LEGACY_USER_ID } });
  }
  return db.user.create({ data: { googleSub: identity.sub, email: identity.email, name: identity.name, lastLoginAt: now, settings: { create: {} } } });
}
