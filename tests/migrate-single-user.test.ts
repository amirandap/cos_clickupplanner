import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { applyMigrations, configureTestEnvironment, createTestDatabase, loadModule } from "./helpers";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });
const MULTIUSER = "20261020120000_multiuser";

/** A database exactly as the single-user release left it, with realistic rows. */
async function oldDatabase() {
  configureTestEnvironment();
  const database = await createTestDatabase({ migrations: (name) => name < MULTIUSER });
  const { db } = database;
  await db.$executeRawUnsafe(`INSERT INTO "ClickUpTask" ("id","title","status","listId","assignedToMe","rawJson") VALUES ('t1','Tarea uno','to do','900100',1,'{"assignees":[{"id":183}]}'), ('t2','Tarea dos','done','900100',0,NULL)`);
  await db.$executeRawUnsafe(`INSERT INTO "CalendarEvent" ("id","calendarId","title","startAt","endAt","clickupTaskId") VALUES ('e1','primary','Bloque',1760000000000,1760001800000,'t1'), ('e2','primary','Otro',1760100000000,1760101800000,NULL)`);
  await db.$executeRawUnsafe(`INSERT INTO "TaskEventLink" ("id","clickupTaskId","calendarEventId","clickupSyncPending") VALUES ('l1','t1','e1',1)`);
  await db.$executeRawUnsafe(`INSERT INTO "SyncState" ("id","source","cursor","updatedAt") VALUES ('google:primary','google','cursor-1',1760000000000), ('clickup','clickup',NULL,1760000000000)`);
  await db.$executeRawUnsafe(`INSERT INTO "ScheduleOperation" ("id","payloadHash","calendarEventId","calendarId","clickupTaskId","title","startAt","endAt") VALUES ('operation-0001','h','planner123','primary','t1','Bloque',1760000000000,1760001800000)`);
  await db.$executeRawUnsafe(`INSERT INTO "TaskEventLinkConflict" ("id","clickupTaskId","calendarEventId","createdAt","clickupSyncPending") VALUES ('c1','t1','e1',1760000000000,0)`);
  await db.$executeRawUnsafe(`INSERT INTO "OAuthCredential" ("provider","accessToken","refreshToken","expiresAt","updatedAt") VALUES ('google','plain-google-access','plain-google-refresh',1760000000000,1760000000000), ('clickup','plain-clickup-oauth',NULL,NULL,1760000000000)`);
  return database;
}

test("the multiuser migration keeps every old row and attaches it to the legacy user", async () => {
  const f = await oldDatabase();
  try {
    await applyMigrations(f.db, (name) => name === MULTIUSER);
    const legacy = await f.db.user.findUniqueOrThrow({ where: { id: "legacy-single-user" } });
    assert.match(legacy.googleSub, /^pending:/);
    assert.equal(await f.db.clickUpTask.count(), 2);
    assert.equal(await f.db.calendarEvent.count({ where: { userId: "legacy-single-user" } }), 2);
    assert.equal(await f.db.taskEventLink.count({ where: { userId: "legacy-single-user", clickupSyncPending: true } }), 1);
    assert.equal(await f.db.syncState.count({ where: { userId: "legacy-single-user" } }), 2);
    assert.equal(await f.db.scheduleOperation.count({ where: { userId: "legacy-single-user", id: "operation-0001" } }), 1);
    assert.equal((await f.db.taskEventLinkConflict.findUniqueOrThrow({ where: { id: "c1" } })).userId, "legacy-single-user");
    assert.deepEqual((await f.db.userTask.findMany({ orderBy: { taskId: "asc" } })).map((row) => [row.userId, row.taskId]), [["legacy-single-user", "t1"], ["legacy-single-user", "t2"]]);
    assert.ok(await f.db.userSettings.findUnique({ where: { userId: "legacy-single-user" } }));
    assert.equal((await f.db.calendarEvent.findUniqueOrThrow({ where: { userId_id: { userId: "legacy-single-user", id: "e1" } } })).clickupTaskId, "t1");
    assert.equal(await f.db.legacyOAuthCredential.count(), 2, "plaintext rows are left for the script to encrypt and delete");
  } finally { await f.cleanup(); }
});

test("migrate-single-user moves config and credentials, encrypted, and is idempotent", async () => {
  const f = await oldDatabase();
  try {
    await applyMigrations(f.db, (name) => name === MULTIUSER);
    const script = loadModule<typeof import("../prisma/migrate-single-user")>("prisma/migrate-single-user.ts");
    const env = { GOOGLE_CALENDAR_ID: "me@example.test", CLICKUP_LIST_IDS: "900100, 900200", APP_TIMEZONE: "America/Santo_Domingo", CLICKUP_DEFAULT_ASSIGNEE_ID: "183" };
    const report = await script.migrateSingleUser(f.db, env);
    assert.deepEqual(report, { legacyUser: true, claimed: false, settingsFilled: ["calendarId", "listIds", "timezone", "clickupUserId"], credentialsMoved: ["google_calendar", "clickup"], legacyRowsDeleted: 2 });
    const settings = await f.db.userSettings.findUniqueOrThrow({ where: { userId: "legacy-single-user" } });
    assert.deepEqual([settings.calendarId, settings.listIds, settings.timezone, settings.clickupUserId], ["me@example.test", "900100, 900200", "America/Santo_Domingo", "183"]);

    const store = loadModule<typeof import("../src/lib/auth/credentials")>("src/lib/auth/credentials.ts", { "@/lib/db/client": { db: f.db } });
    const google = await store.getCredential("legacy-single-user", "google_calendar");
    assert.deepEqual([google?.accessToken, google?.refreshToken], ["plain-google-access", "plain-google-refresh"]);
    const clickup = await store.getCredential("legacy-single-user", "clickup");
    assert.deepEqual([clickup?.accessToken, clickup?.scheme], ["plain-clickup-oauth", "bearer"]);
    const stored = JSON.stringify(await f.db.userCredential.findMany());
    for (const secret of ["plain-google-access", "plain-google-refresh", "plain-clickup-oauth"]) assert.equal(stored.includes(secret), false, secret);
    assert.equal(await f.db.legacyOAuthCredential.count(), 0);

    // The user edits a setting; running the script again must not undo it.
    await f.db.userSettings.update({ where: { userId: "legacy-single-user" }, data: { timezone: "Europe/Madrid" } });
    const again = await script.migrateSingleUser(f.db, env);
    assert.deepEqual([again.credentialsMoved, again.legacyRowsDeleted], [[], 0]);
    assert.equal((await f.db.userSettings.findUniqueOrThrow({ where: { userId: "legacy-single-user" } })).timezone, "Europe/Madrid");
    assert.equal(await f.db.userCredential.count(), 2);
  } finally { await f.cleanup(); }
});

test("a CLICKUP_TOKEN from the environment is stored as a personal token", async () => {
  const f = await oldDatabase();
  try {
    await applyMigrations(f.db, (name) => name === MULTIUSER);
    const script = loadModule<typeof import("../prisma/migrate-single-user")>("prisma/migrate-single-user.ts");
    await script.migrateSingleUser(f.db, { CLICKUP_TOKEN: "pk_183_ENVTOKEN" });
    const store = loadModule<typeof import("../src/lib/auth/credentials")>("src/lib/auth/credentials.ts", { "@/lib/db/client": { db: f.db } });
    const clickup = await store.getCredential("legacy-single-user", "clickup");
    assert.deepEqual([clickup?.accessToken, clickup?.scheme], ["pk_183_ENVTOKEN", "raw"]);
  } finally { await f.cleanup(); }
});

test("a fresh database gets no legacy user and the script does nothing", async () => {
  configureTestEnvironment();
  const f = await createTestDatabase();
  try {
    assert.equal(await f.db.user.count(), 0);
    const script = loadModule<typeof import("../prisma/migrate-single-user")>("prisma/migrate-single-user.ts");
    assert.equal((await script.migrateSingleUser(f.db, {})).legacyUser, false);
  } finally { await f.cleanup(); }
});

test("the script refuses to run without an encryption key and leaves plaintext untouched", async () => {
  const f = await oldDatabase();
  try {
    await applyMigrations(f.db, (name) => name === MULTIUSER);
    delete process.env.TOKEN_ENCRYPTION_KEY;
    const script = loadModule<typeof import("../prisma/migrate-single-user")>("prisma/migrate-single-user.ts");
    await assert.rejects(script.migrateSingleUser(f.db, {}), /TOKEN_ENCRYPTION_KEY/);
    assert.equal(await f.db.legacyOAuthCredential.count(), 2);
    assert.equal(await f.db.userCredential.count(), 0);
  } finally { await f.cleanup(); }
});
