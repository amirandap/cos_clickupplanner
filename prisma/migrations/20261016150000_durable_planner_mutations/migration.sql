CREATE TABLE "ScheduleOperation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "payloadHash" TEXT NOT NULL,
  "calendarEventId" TEXT NOT NULL,
  "calendarId" TEXT NOT NULL,
  "clickupTaskId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "startAt" DATETIME NOT NULL,
  "endAt" DATETIME NOT NULL,
  "savedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ScheduleOperation_calendarEventId_key" ON "ScheduleOperation"("calendarEventId");
CREATE TABLE "MutationLease" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "owner" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL
);
CREATE TABLE "TaskEventLinkConflict" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "clickupTaskId" TEXT NOT NULL,
  "calendarEventId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL,
  "clickupSyncPending" BOOLEAN NOT NULL,
  "dueSyncedStartAt" DATETIME,
  "commentedStartAt" DATETIME,
  "clickupSyncError" TEXT,
  "archivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "TaskEventLink" ADD COLUMN "commentAttemptedStartAt" DATETIME;

-- Prefer the link matching CalendarEvent's authoritative owner and break ties by
-- creation time and then ID. Preserve discarded rows before consolidation.
CREATE TEMP TABLE "CanonicalLink" AS
SELECT l."calendarEventId", (
  SELECT candidate."id" FROM "TaskEventLink" candidate
  LEFT JOIN "CalendarEvent" e ON e."id" = candidate."calendarEventId"
  WHERE candidate."calendarEventId" = l."calendarEventId"
  ORDER BY CASE WHEN candidate."clickupTaskId" = e."clickupTaskId" THEN 0 ELSE 1 END,
           candidate."createdAt", candidate."id"
  LIMIT 1
) AS "id"
FROM "TaskEventLink" l GROUP BY l."calendarEventId";
INSERT INTO "TaskEventLinkConflict" ("id", "clickupTaskId", "calendarEventId", "createdAt", "clickupSyncPending", "dueSyncedStartAt", "commentedStartAt", "clickupSyncError")
SELECT l."id", l."clickupTaskId", l."calendarEventId", l."createdAt", l."clickupSyncPending", l."dueSyncedStartAt", l."commentedStartAt", l."clickupSyncError"
FROM "TaskEventLink" l JOIN "CanonicalLink" c ON c."calendarEventId" = l."calendarEventId"
WHERE l."id" <> c."id";
UPDATE "TaskEventLink" SET "clickupSyncPending" = true
WHERE "id" IN (SELECT "id" FROM "CanonicalLink")
AND EXISTS (SELECT 1 FROM "TaskEventLink" pending WHERE pending."calendarEventId" = "TaskEventLink"."calendarEventId" AND pending."clickupSyncPending" = true);
DELETE FROM "TaskEventLink" WHERE "id" NOT IN (SELECT "id" FROM "CanonicalLink");
-- If only stale links existed, preserve them in the archive and align the
-- survivor with the authoritative owner, resetting task-specific checkpoints.
INSERT OR IGNORE INTO "TaskEventLinkConflict" ("id", "clickupTaskId", "calendarEventId", "createdAt", "clickupSyncPending", "dueSyncedStartAt", "commentedStartAt", "clickupSyncError")
SELECT l."id", l."clickupTaskId", l."calendarEventId", l."createdAt", l."clickupSyncPending", l."dueSyncedStartAt", l."commentedStartAt", l."clickupSyncError"
FROM "TaskEventLink" l JOIN "CalendarEvent" e ON e."id" = l."calendarEventId"
WHERE e."clickupTaskId" IS NOT NULL AND e."clickupTaskId" <> l."clickupTaskId";
UPDATE "TaskEventLink" SET
  "clickupTaskId" = (SELECT e."clickupTaskId" FROM "CalendarEvent" e WHERE e."id" = "TaskEventLink"."calendarEventId"),
  "clickupSyncPending" = true, "dueSyncedStartAt" = NULL, "commentedStartAt" = NULL
WHERE EXISTS (SELECT 1 FROM "CalendarEvent" e WHERE e."id" = "TaskEventLink"."calendarEventId" AND e."clickupTaskId" IS NOT NULL AND e."clickupTaskId" <> "TaskEventLink"."clickupTaskId");
DROP TABLE "CanonicalLink";
CREATE UNIQUE INDEX "TaskEventLink_calendarEventId_key" ON "TaskEventLink"("calendarEventId");
