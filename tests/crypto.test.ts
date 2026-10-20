import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { randomBytes } from "node:crypto";
import { configureTestEnvironment, createTestDatabase, createTestUser, loadModule } from "./helpers";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });
const tokens = () => loadModule<typeof import("../src/lib/crypto/tokens")>("src/lib/crypto/tokens.ts");
const aad = { userId: "user-a", provider: "clickup", field: "access" };

test("tokens round-trip and the blob never contains the plaintext", () => {
  configureTestEnvironment();
  const blob = tokens().encryptToken("pk_super_secret_value", aad);
  assert.match(blob, /^v1\.1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(blob.includes("pk_super_secret_value"), false);
  assert.equal(tokens().decryptToken(blob, aad), "pk_super_secret_value");
  assert.notEqual(tokens().encryptToken("pk_super_secret_value", aad), blob, "a random IV makes every blob different");
});

test("a blob is bound to its user, provider and field through the AAD", () => {
  configureTestEnvironment();
  const blob = tokens().encryptToken("secret", aad);
  for (const wrong of [{ ...aad, userId: "user-b" }, { ...aad, provider: "google_calendar" }, { ...aad, field: "refresh" }]) {
    assert.throws(() => tokens().decryptToken(blob, wrong), /descifrar/);
  }
});

test("tampering with any part of the blob is detected", () => {
  configureTestEnvironment();
  const parts = tokens().encryptToken("secret", aad).split(".");
  for (const index of [2, 3, 4]) {
    const copy = [...parts];
    const bytes = Buffer.from(copy[index], "base64url");
    bytes[0] ^= 1;
    copy[index] = bytes.toString("base64url");
    assert.throws(() => tokens().decryptToken(copy.join("."), aad));
  }
  assert.throws(() => tokens().decryptToken("garbage", aad));
});

test("missing or malformed keys fail closed with a configuration error", () => {
  configureTestEnvironment();
  delete process.env.TOKEN_ENCRYPTION_KEY;
  assert.throws(() => tokens().encryptToken("x", aad), /TOKEN_ENCRYPTION_KEY/);
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(16).toString("base64");
  assert.throws(() => tokens().encryptToken("x", aad), /32 bytes/);
  process.env.TOKEN_ENCRYPTION_KEY = "not base64 !!";
  assert.throws(() => tokens().encryptToken("x", aad), /32 bytes/);
});

test("rotation: old key versions still decrypt and are flagged for re-encryption", () => {
  configureTestEnvironment();
  const oldKey = process.env.TOKEN_ENCRYPTION_KEY!;
  const blob = tokens().encryptToken("secret", aad);
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.TOKEN_ENCRYPTION_KEY_VERSION = "2";
  assert.throws(() => tokens().decryptToken(blob, aad), /clave desconocida/);
  process.env.TOKEN_ENCRYPTION_KEYS_OLD = `1:${oldKey}`;
  assert.equal(tokens().decryptToken(blob, aad), "secret");
  assert.equal(tokens().needsReencryption(blob), true);
  assert.equal(tokens().needsReencryption(tokens().encryptToken("secret", aad)), false);
  assert.match(tokens().encryptToken("x", aad), /^v1\.2\./);
});

test("credentials are stored encrypted and read back for their owner only", async () => {
  configureTestEnvironment();
  const f = await createTestDatabase();
  try {
    await createTestUser(f.db, "user-a"); await createTestUser(f.db, "user-b");
    const store = loadModule<typeof import("../src/lib/auth/credentials")>("src/lib/auth/credentials.ts", { "@/lib/db/client": { db: f.db } });
    await store.saveCredential("user-a", "clickup", { accessToken: "pk_a_secret" });
    await store.saveCredential("user-a", "google_calendar", { accessToken: "ya29.access", refreshToken: "1//refresh", expiresAt: new Date(Date.now() + 3600_000) });
    const rows = await f.db.userCredential.findMany();
    assert.equal(rows.length, 2);
    assert.equal(JSON.stringify(rows).includes("pk_a_secret") || JSON.stringify(rows).includes("1//refresh") || JSON.stringify(rows).includes("ya29"), false);
    assert.equal((await store.getCredential("user-a", "clickup"))?.accessToken, "pk_a_secret");
    assert.equal(await store.getCredential("user-b", "clickup"), null);
    // Copying A's ciphertext into B's row must not yield A's token for B.
    await f.db.userCredential.create({ data: { userId: "user-b", provider: "clickup", accessTokenEnc: rows.find((row) => row.provider === "clickup")!.accessTokenEnc } });
    await assert.rejects(store.getCredential("user-b", "clickup"), /descifrar/);
  } finally { await f.cleanup(); }
});

test("rotate-token-key re-encrypts every credential with the current key", async () => {
  configureTestEnvironment();
  const f = await createTestDatabase();
  try {
    await createTestUser(f.db, "user-a");
    const oldKey = process.env.TOKEN_ENCRYPTION_KEY!;
    const store = loadModule<typeof import("../src/lib/auth/credentials")>("src/lib/auth/credentials.ts", { "@/lib/db/client": { db: f.db } });
    await store.saveCredential("user-a", "google_calendar", { accessToken: "access", refreshToken: "refresh" });
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.TOKEN_ENCRYPTION_KEY_VERSION = "2";
    process.env.TOKEN_ENCRYPTION_KEYS_OLD = `1:${oldKey}`;
    const script = loadModule<typeof import("../prisma/rotate-token-key")>("prisma/rotate-token-key.ts");
    assert.deepEqual(await script.rotateTokenKey(f.db), { total: 1, rotated: 1 });
    const row = await f.db.userCredential.findUniqueOrThrow({ where: { userId_provider: { userId: "user-a", provider: "google_calendar" } } });
    assert.match(row.accessTokenEnc!, /^v1\.2\./);
    assert.match(row.refreshTokenEnc!, /^v1\.2\./);
    delete process.env.TOKEN_ENCRYPTION_KEYS_OLD; // the old key is no longer needed
    assert.equal((await store.getCredential("user-a", "google_calendar"))?.refreshToken, "refresh");
    assert.deepEqual(await script.rotateTokenKey(f.db), { total: 1, rotated: 0 });
  } finally { await f.cleanup(); }
});
