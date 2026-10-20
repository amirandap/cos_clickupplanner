import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";
import ts from "typescript";

const root = process.cwd();
const sourceRoot = path.join(root, "src");
const databaseModule = path.join(sourceRoot, "lib/db/client.ts");

type ModuleCache = Map<string, { exports: unknown }>;

function sourceFile(specifier: string, from: string) {
  const base = specifier.startsWith("@/") ? path.join(sourceRoot, specifier.slice(2))
    : specifier.startsWith(".") ? path.resolve(path.dirname(from), specifier) : null;
  if (!base) return null;
  return [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base].find((candidate) => {
    try { return candidate.endsWith(".ts") || candidate.endsWith(".tsx") ? statSync(candidate).isFile() : false; } catch { return false; }
  }) ?? null;
}

function evaluateModule(filename: string, dependencies: Record<string, unknown>, cache: ModuleCache) {
  const cached = cache.get(filename);
  if (cached) return cached.exports;
  const source = readFileSync(filename, "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const moduleRecord: { exports: unknown } = { exports: {} };
  cache.set(filename, moduleRecord);
  const nativeRequire = createRequire(filename);
  const requireDependency = (name: string): unknown => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    const file = sourceFile(name, filename);
    if (file) {
      // The database is the one boundary that must always be injected, so a test can never touch a real one.
      if (file === databaseModule) throw new Error(`Test must supply application dependency: ${name}`);
      return evaluateModule(file, dependencies, cache);
    }
    if (name.startsWith("@/")) throw new Error(`Test must supply application dependency: ${name}`);
    return nativeRequire(name);
  };
  const evaluate = new Function("require", "module", "exports", code);
  evaluate(requireDependency, moduleRecord, moduleRecord.exports);
  return moduleRecord.exports;
}

/**
 * Execute production modules with external boundaries supplied by each test.
 * Other application modules are loaded from source with the same overrides, so
 * an injected `@/lib/db/client` reaches the whole dependency tree.
 */
export function loadModule<T>(
  file: string,
  dependencies: Record<string, unknown> = {},
): T {
  return evaluateModule(path.resolve(root, file), dependencies, new Map()) as T;
}

/** Applies the real migration files, one statement at a time, in name order. */
export async function applyMigrations(db: PrismaClient, select: (name: string) => boolean = () => true) {
  const migrationRoot = path.join(root, "prisma/migrations");
  const entries = await readdir(migrationRoot, { withFileTypes: true });
  for (const entry of entries.filter((value) => value.isDirectory() && select(value.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const sql = await readFile(path.join(migrationRoot, entry.name, "migration.sql"), "utf8");
    for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean)) {
      await db.$executeRawUnsafe(statement);
    }
  }
}

/** Every integration test receives its own database; the developer DB is never used. */
export async function createTestDatabase(options: { migrations?: (name: string) => boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "planner-test-"));
  const databaseUrl = `file:${path.join(directory, "test.db")}`;
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await applyMigrations(db, options.migrations);
    return {
      db,
      databaseUrl,
      async cleanup() {
        await db.$disconnect();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await db.$disconnect();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/** Environment every multiuser test needs. Individual tests restore process.env in afterEach. */
export function configureTestEnvironment() {
  process.env.APP_URL = "https://planner.test";
  process.env.GOOGLE_CLIENT_ID = "google-test-client";
  process.env.GOOGLE_CLIENT_SECRET = "google-test-secret";
  process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  delete process.env.TOKEN_ENCRYPTION_KEY_VERSION;
  delete process.env.TOKEN_ENCRYPTION_KEYS_OLD;
  delete process.env.AUTH_ALLOWED_DOMAIN;
  delete process.env.BOOTSTRAP_ADMIN_EMAIL;
  process.env.USE_MOCK_DATA = "false";
}

export type TestContext = {
  userId: string; calendarId: string; listIds: string[]; timezone: string; clickupUserId: string | null; mock: boolean;
};

export async function createTestUser(db: PrismaClient, id: string, overrides: Partial<Omit<TestContext, "userId" | "mock">> = {}) {
  const ctx: TestContext = { userId: id, calendarId: "calendar-a", listIds: ["list-a"], timezone: "UTC", clickupUserId: null, mock: false, ...overrides };
  await db.user.create({ data: { id, googleSub: `sub-${id}`, email: `${id}@example.test`, name: id } });
  await db.userSettings.create({ data: { userId: id, calendarId: ctx.calendarId, listIds: ctx.listIds.join(","), timezone: ctx.timezone, clickupUserId: ctx.clickupUserId } });
  return ctx;
}

/** A cached task visible to the given users, as if each of their tokens had fetched it. */
export async function createTestTask(db: PrismaClient, id: string, listId: string | null, users: string[], extra: { title?: string; rawJson?: object } = {}) {
  await db.clickUpTask.create({ data: { id, listId, title: extra.title ?? id, ...(extra.rawJson ? { rawJson: extra.rawJson } : {}) } });
  for (const userId of users) await db.userTask.create({ data: { userId, taskId: id } });
}

/** An authenticated cookie header for a user (a real session row, as the login callback creates). */
export async function sessionCookieFor(db: PrismaClient, userId: string) {
  const session = loadModule<typeof import("../src/lib/auth/session")>("src/lib/auth/session.ts", { "@/lib/db/client": { db } });
  const { token } = await session.createSession(userId);
  const cookies = loadModule<typeof import("../src/lib/auth/cookies")>("src/lib/auth/cookies.ts");
  return `${cookies.sessionCookieName()}=${token}`;
}
