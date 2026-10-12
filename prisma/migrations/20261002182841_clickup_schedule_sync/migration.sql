-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TaskEventLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clickupTaskId" TEXT NOT NULL,
    "calendarEventId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clickupSyncPending" BOOLEAN NOT NULL DEFAULT false,
    "dueSyncedStartAt" DATETIME,
    "commentedStartAt" DATETIME,
    "clickupSyncError" TEXT
);
INSERT INTO "new_TaskEventLink" ("calendarEventId", "clickupTaskId", "createdAt", "id") SELECT "calendarEventId", "clickupTaskId", "createdAt", "id" FROM "TaskEventLink";
DROP TABLE "TaskEventLink";
ALTER TABLE "new_TaskEventLink" RENAME TO "TaskEventLink";
CREATE INDEX "TaskEventLink_calendarEventId_idx" ON "TaskEventLink"("calendarEventId");
CREATE UNIQUE INDEX "TaskEventLink_clickupTaskId_calendarEventId_key" ON "TaskEventLink"("clickupTaskId", "calendarEventId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
