import { db } from "@/lib/db/client";
import { defaultTimezone } from "@/lib/config/env";
import { MOCK_CALENDAR_ID, MOCK_LIST_ID, parseListIds, type UserContext } from "@/lib/planner/config";

export async function loadUserContext(userId: string): Promise<UserContext> {
  const settings = await db.userSettings.upsert({
    where: { userId }, update: {}, create: { userId, timezone: defaultTimezone() },
  });
  const mock = process.env.USE_MOCK_DATA === "true";
  return {
    userId, mock, timezone: settings.timezone, clickupUserId: settings.clickupUserId,
    calendarId: mock ? MOCK_CALENDAR_ID : settings.calendarId,
    listIds: mock ? [MOCK_LIST_ID] : parseListIds(settings.listIds),
  };
}
