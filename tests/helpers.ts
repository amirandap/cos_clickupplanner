import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";
import ts from "typescript";

const root = process.cwd();

/** Execute production modules with external boundaries supplied by each test. */
export function loadModule<T>(
  file: string,
  dependencies: Record<string, unknown> = {},
): T {
  const filename = path.resolve(root, file);
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
  const nativeRequire = createRequire(filename);
  const requireDependency = (name: string): unknown => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    if (name.startsWith("@/")) {
      throw new Error(`Test must supply application dependency: ${name}`);
    }
    return nativeRequire(name);
  };
  const evaluate = new Function("require", "module", "exports", code);
  evaluate(requireDependency, moduleRecord, moduleRecord.exports);
  return moduleRecord.exports as T;
}

/** Every integration test receives its own database; the developer DB is never used. */
export async function createTestDatabase() {
  const directory = await mkdtemp(path.join(tmpdir(), "planner-test-"));
  const databaseUrl = `file:${path.join(directory, "test.db")}`;
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const migrationRoot = path.join(root, "prisma/migrations");
    const entries = await readdir(migrationRoot, { withFileTypes: true });
    for (const entry of entries.filter((value) => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const sql = await readFile(path.join(migrationRoot, entry.name, "migration.sql"), "utf8");
      for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean)) {
        await db.$executeRawUnsafe(statement);
      }
    }
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
