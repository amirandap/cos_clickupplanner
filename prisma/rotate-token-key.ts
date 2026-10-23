/**
 * Re-encrypts every stored credential with the current TOKEN_ENCRYPTION_KEY.
 * Run it after changing the key: the previous key must still be listed in
 * TOKEN_ENCRYPTION_KEYS_OLD so it can be decrypted. Usage:
 *   npx tsx prisma/rotate-token-key.ts
 */
import { PrismaClient } from "@prisma/client";
import { decryptToken, encryptToken, needsReencryption } from "../src/lib/crypto/tokens";

export async function rotateTokenKey(db: PrismaClient) {
  const rows = await db.userCredential.findMany();
  let rotated = 0;
  for (const row of rows) {
    const data: { accessTokenEnc?: string; refreshTokenEnc?: string } = {};
    for (const [column, field] of [["accessTokenEnc", "access"], ["refreshTokenEnc", "refresh"]] as const) {
      const blob = row[column];
      if (!blob || !needsReencryption(blob)) continue;
      const aad = { userId: row.userId, provider: row.provider, field };
      data[column] = encryptToken(decryptToken(blob, aad), aad);
    }
    if (Object.keys(data).length) {
      await db.userCredential.update({ where: { userId_provider: { userId: row.userId, provider: row.provider } }, data });
      rotated++;
    }
  }
  return { total: rows.length, rotated };
}

if (require.main === module) {
  const db = new PrismaClient();
  rotateTokenKey(db)
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error: unknown) => { console.error("Rotación fallida:", error instanceof Error ? error.message : error); process.exitCode = 1; })
    .finally(() => db.$disconnect());
}
