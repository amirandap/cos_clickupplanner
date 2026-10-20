-- AlterTable
ALTER TABLE "TaskEventLinkConflict" ADD COLUMN "userId" TEXT;

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "googleSub" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" DATETIME
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "maxExpiresAt" DATETIME NOT NULL,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OAuthFlow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "nonce" TEXT,
    "codeVerifier" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OAuthFlow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserCredential" (
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "expiresAt" DATETIME,
    "scheme" TEXT NOT NULL DEFAULT 'raw',
    "scopes" TEXT,
    "revokedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("userId", "provider"),
    CONSTRAINT "UserCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserSettings" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "calendarId" TEXT NOT NULL DEFAULT 'primary',
    "listIds" TEXT NOT NULL DEFAULT '',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "clickupUserId" TEXT,
    "clickupUsername" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserTask" (
    "userId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "archivedAt" DATETIME,

    PRIMARY KEY ("userId", "taskId"),
    CONSTRAINT "UserTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserTask_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ClickUpTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "windowStart" DATETIME NOT NULL,
    "count" INTEGER NOT NULL
);


-- Existing single-user data is attached to one placeholder user. The first
-- eligible login claims it (see README). Fresh databases get no placeholder.
INSERT INTO "User" ("id", "googleSub", "email", "name")
SELECT 'legacy-single-user', 'pending:legacy-single-user', 'pending@legacy.invalid', 'Usuario existente (pendiente)'
WHERE EXISTS (SELECT 1 FROM "ClickUpTask") OR EXISTS (SELECT 1 FROM "CalendarEvent") OR EXISTS (SELECT 1 FROM "TaskEventLink")
  OR EXISTS (SELECT 1 FROM "SyncState") OR EXISTS (SELECT 1 FROM "ScheduleOperation") OR EXISTS (SELECT 1 FROM "OAuthCredential");

INSERT INTO "UserSettings" ("userId", "updatedAt")
SELECT "id", CURRENT_TIMESTAMP FROM "User" WHERE "id" = 'legacy-single-user';

UPDATE "TaskEventLinkConflict" SET "userId" = 'legacy-single-user' WHERE EXISTS (SELECT 1 FROM "User" WHERE "id" = 'legacy-single-user');

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CalendarEvent" (
    "userId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startAt" DATETIME NOT NULL,
    "endAt" DATETIME NOT NULL,
    "clickupTaskId" TEXT,
    "rawJson" JSONB,
    "remoteUpdated" DATETIME,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("userId", "id"),
    CONSTRAINT "CalendarEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_CalendarEvent" ("userId", "calendarId", "clickupTaskId", "endAt", "id", "rawJson", "remoteUpdated", "startAt", "syncedAt", "title") SELECT 'legacy-single-user', "calendarId", "clickupTaskId", "endAt", "id", "rawJson", "remoteUpdated", "startAt", "syncedAt", "title" FROM "CalendarEvent";
DROP TABLE "CalendarEvent";
ALTER TABLE "new_CalendarEvent" RENAME TO "CalendarEvent";
CREATE INDEX "CalendarEvent_userId_clickupTaskId_idx" ON "CalendarEvent"("userId", "clickupTaskId");
CREATE INDEX "CalendarEvent_userId_startAt_endAt_idx" ON "CalendarEvent"("userId", "startAt", "endAt");
CREATE TABLE "new_ClickUpTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "status" TEXT,
    "priority" TEXT,
    "dueDate" DATETIME,
    "estimateMin" INTEGER,
    "url" TEXT,
    "listId" TEXT,
    "rawJson" JSONB,
    "remoteUpdated" DATETIME,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_ClickUpTask" ("dueDate", "estimateMin", "id", "listId", "priority", "rawJson", "remoteUpdated", "status", "syncedAt", "title", "url") SELECT "dueDate", "estimateMin", "id", "listId", "priority", "rawJson", "remoteUpdated", "status", "syncedAt", "title", "url" FROM "ClickUpTask";
DROP TABLE "ClickUpTask";
ALTER TABLE "new_ClickUpTask" RENAME TO "ClickUpTask";
CREATE INDEX "ClickUpTask_remoteUpdated_idx" ON "ClickUpTask"("remoteUpdated");
CREATE TABLE "new_ScheduleOperation" (
    "userId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "calendarEventId" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "clickupTaskId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startAt" DATETIME NOT NULL,
    "endAt" DATETIME NOT NULL,
    "savedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("userId", "id"),
    CONSTRAINT "ScheduleOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ScheduleOperation" ("userId", "calendarEventId", "calendarId", "clickupTaskId", "createdAt", "endAt", "id", "payloadHash", "savedAt", "startAt", "title") SELECT 'legacy-single-user', "calendarEventId", "calendarId", "clickupTaskId", "createdAt", "endAt", "id", "payloadHash", "savedAt", "startAt", "title" FROM "ScheduleOperation";
DROP TABLE "ScheduleOperation";
ALTER TABLE "new_ScheduleOperation" RENAME TO "ScheduleOperation";
CREATE UNIQUE INDEX "ScheduleOperation_userId_calendarEventId_key" ON "ScheduleOperation"("userId", "calendarEventId");
CREATE TABLE "new_SyncState" (
    "userId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "cursor" TEXT,
    "lastSyncAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("userId", "id"),
    CONSTRAINT "SyncState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SyncState" ("userId", "cursor", "id", "lastSyncAt", "source", "updatedAt") SELECT 'legacy-single-user', "cursor", "id", "lastSyncAt", "source", "updatedAt" FROM "SyncState";
DROP TABLE "SyncState";
ALTER TABLE "new_SyncState" RENAME TO "SyncState";
CREATE TABLE "new_TaskEventLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "clickupTaskId" TEXT NOT NULL,
    "calendarEventId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clickupSyncPending" BOOLEAN NOT NULL DEFAULT false,
    "dueSyncedStartAt" DATETIME,
    "commentedStartAt" DATETIME,
    "commentAttemptedStartAt" DATETIME,
    "clickupSyncError" TEXT,
    CONSTRAINT "TaskEventLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_TaskEventLink" ("userId", "calendarEventId", "clickupSyncError", "clickupSyncPending", "clickupTaskId", "commentAttemptedStartAt", "commentedStartAt", "createdAt", "dueSyncedStartAt", "id") SELECT 'legacy-single-user', "calendarEventId", "clickupSyncError", "clickupSyncPending", "clickupTaskId", "commentAttemptedStartAt", "commentedStartAt", "createdAt", "dueSyncedStartAt", "id" FROM "TaskEventLink";
DROP TABLE "TaskEventLink";
ALTER TABLE "new_TaskEventLink" RENAME TO "TaskEventLink";
CREATE UNIQUE INDEX "TaskEventLink_userId_calendarEventId_key" ON "TaskEventLink"("userId", "calendarEventId");
CREATE UNIQUE INDEX "TaskEventLink_userId_clickupTaskId_calendarEventId_key" ON "TaskEventLink"("userId", "clickupTaskId", "calendarEventId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "OAuthFlow_expiresAt_idx" ON "OAuthFlow"("expiresAt");

-- CreateIndex
CREATE INDEX "UserTask_taskId_idx" ON "UserTask"("taskId");

-- Every cached task stays visible to the legacy user.
INSERT INTO "UserTask" ("userId", "taskId")
SELECT 'legacy-single-user', "id" FROM "ClickUpTask" WHERE EXISTS (SELECT 1 FROM "User" WHERE "id" = 'legacy-single-user');
