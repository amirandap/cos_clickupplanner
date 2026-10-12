-- CreateTable
CREATE TABLE "ClickUpTask" (
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

-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "calendarId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startAt" DATETIME NOT NULL,
    "endAt" DATETIME NOT NULL,
    "clickupTaskId" TEXT,
    "rawJson" JSONB,
    "remoteUpdated" DATETIME,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TaskEventLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clickupTaskId" TEXT NOT NULL,
    "calendarEventId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SyncState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "cursor" TEXT,
    "lastSyncAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OAuthCredential" (
    "provider" TEXT NOT NULL PRIMARY KEY,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ClickUpTask_remoteUpdated_idx" ON "ClickUpTask"("remoteUpdated");

-- CreateIndex
CREATE INDEX "CalendarEvent_clickupTaskId_idx" ON "CalendarEvent"("clickupTaskId");

-- CreateIndex
CREATE INDEX "CalendarEvent_startAt_endAt_idx" ON "CalendarEvent"("startAt", "endAt");

-- CreateIndex
CREATE INDEX "TaskEventLink_calendarEventId_idx" ON "TaskEventLink"("calendarEventId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskEventLink_clickupTaskId_calendarEventId_key" ON "TaskEventLink"("clickupTaskId", "calendarEventId");
