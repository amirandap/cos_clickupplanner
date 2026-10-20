import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ConfigError } from "@/lib/config/env";

// Format: v1.<keyVersion>.<iv>.<tag>.<ciphertext> (base64url parts).
// The additional authenticated data binds a ciphertext to its owner, provider
// and field, so a blob copied between rows or users fails to decrypt.
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const FORMAT = "v1";

export type TokenAad = { userId: string; provider: string; field: string };

type Keyring = { current: { version: number; key: Buffer }; byVersion: Map<number, Buffer> };

function parseKey(value: string, label: string) {
  const trimmed = value.trim();
  const key = /^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed) ? Buffer.from(trimmed, "base64") : Buffer.alloc(0);
  if (key.length !== KEY_BYTES) throw new ConfigError(`${label} debe ser una clave de 32 bytes en base64`);
  return key;
}

function parseVersion(value: string, label: string) {
  if (!/^\d{1,4}$/.test(value) || Number(value) < 1) throw new ConfigError(`${label} debe ser un entero positivo`);
  return Number(value);
}

/** TOKEN_ENCRYPTION_KEY signs new data. TOKEN_ENCRYPTION_KEYS_OLD ("1:<b64>,2:<b64>") only decrypts. */
export function keyring(): Keyring {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw?.trim()) throw new ConfigError("Falta TOKEN_ENCRYPTION_KEY");
  const version = parseVersion(process.env.TOKEN_ENCRYPTION_KEY_VERSION?.trim() || "1", "TOKEN_ENCRYPTION_KEY_VERSION");
  const current = { version, key: parseKey(raw, "TOKEN_ENCRYPTION_KEY") };
  const byVersion = new Map<number, Buffer>([[version, current.key]]);
  for (const entry of (process.env.TOKEN_ENCRYPTION_KEYS_OLD ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
    const separator = entry.indexOf(":");
    if (separator < 1) throw new ConfigError("TOKEN_ENCRYPTION_KEYS_OLD debe tener el formato versión:clave");
    const oldVersion = parseVersion(entry.slice(0, separator), "TOKEN_ENCRYPTION_KEYS_OLD");
    if (byVersion.has(oldVersion)) throw new ConfigError("TOKEN_ENCRYPTION_KEYS_OLD repite una versión de clave");
    byVersion.set(oldVersion, parseKey(entry.slice(separator + 1), "TOKEN_ENCRYPTION_KEYS_OLD"));
  }
  return { current, byVersion };
}

function aadBuffer(aad: TokenAad) {
  return Buffer.from(`${aad.userId}\u0000${aad.provider}\u0000${aad.field}`, "utf8");
}

export function encryptToken(plaintext: string, aad: TokenAad) {
  const { current } = keyring();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, current.key, iv);
  cipher.setAAD(aadBuffer(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [FORMAT, current.version, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function parseBlob(blob: string) {
  const parts = blob.split(".");
  if (parts.length !== 5 || parts[0] !== FORMAT || !/^\d{1,4}$/.test(parts[1])) throw new Error("Credencial cifrada inválida");
  return { version: Number(parts[1]), iv: Buffer.from(parts[2], "base64url"), tag: Buffer.from(parts[3], "base64url"), ciphertext: Buffer.from(parts[4], "base64url") };
}

/** Throws a generic error for tampering, wrong AAD or an unknown key version. */
export function decryptToken(blob: string, aad: TokenAad) {
  const parsed = parseBlob(blob);
  const key = keyring().byVersion.get(parsed.version);
  if (!key) throw new Error("Credencial cifrada con una clave desconocida");
  try {
    const decipher = createDecipheriv(ALGORITHM, key, parsed.iv);
    decipher.setAAD(aadBuffer(aad));
    decipher.setAuthTag(parsed.tag);
    return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("No se pudo descifrar la credencial");
  }
}

/** True when the blob was written with a key other than the current one. */
export function needsReencryption(blob: string) {
  return parseBlob(blob).version !== keyring().current.version;
}
