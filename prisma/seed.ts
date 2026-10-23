import { PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";

const db = new PrismaClient();

function exampleDate(daysFromToday: number, hour: number, minute = 0) {
  return DateTime.now().setZone(process.env.APP_TIMEZONE || "UTC").startOf("day").plus({ days: daysFromToday, hours: hour, minutes: minute }).toJSDate();
}

const MOCK_USER = "mock-user";

/** Synthetic data only. Everything hangs off the demo user used by USE_MOCK_DATA outside production. */
async function main() {
  await db.user.upsert({
    where: { id: MOCK_USER }, update: {},
    create: { id: MOCK_USER, googleSub: "mock:mock-user", email: "mock@planner.invalid", name: "Usuario de demostración" },
  });
  await db.userSettings.upsert({
    where: { userId: MOCK_USER }, update: {},
    create: { userId: MOCK_USER, calendarId: "mock-calendar", listIds: "mock-list", timezone: process.env.APP_TIMEZONE || "UTC" },
  });
  const tasks = [
    { id: "mock-101", title: "Revisar propuesta de producto", status: "to do", priority: "high", estimateMin: 60, dueDate: exampleDate(0, 18) },
    { id: "mock-102", title: "Preparar reunión semanal", status: "in progress", priority: "urgent", estimateMin: 45, dueDate: exampleDate(1, 12) },
    { id: "mock-103", title: "Responder seguimiento de clientes", status: "to do", priority: "normal", estimateMin: 30, dueDate: exampleDate(0, 17) },
    { id: "mock-104", title: "Organizar notas del proyecto", status: "to do", priority: "low", estimateMin: null, dueDate: null },
    { id: "mock-105", title: "Validar diseño del dashboard", status: "to do", priority: "high", estimateMin: 90, dueDate: exampleDate(2, 16) },
    { id: "mock-106", title: "Planificar prioridades de la semana", status: "to do", priority: "normal", estimateMin: 30, dueDate: null },
  ];
  for (const task of tasks) {
    await db.clickUpTask.upsert({
      where: { id: task.id },
      update: {},
      create: { ...task, url: `https://app.clickup.com/t/${task.id}`, listId: "mock-list", rawJson: { source: "mock", ...task, dueDate: task.dueDate?.toISOString() } },
    });
  }
  for (const task of tasks) {
    await db.userTask.upsert({
      where: { userId_taskId: { userId: MOCK_USER, taskId: task.id } }, update: {}, create: { userId: MOCK_USER, taskId: task.id },
    });
  }
  const event = await db.calendarEvent.upsert({
    where: { userId_id: { userId: MOCK_USER, id: "mock-event-1" } }, update: { calendarId: "mock-calendar" },
    create: {
      userId: MOCK_USER, id: "mock-event-1", calendarId: "mock-calendar", title: "Preparar reunión semanal",
      startAt: exampleDate(0, 10), endAt: exampleDate(0, 10, 45),
      clickupTaskId: "mock-102",
      rawJson: { extendedProperties: { private: { source: "planner", clickupTaskId: "mock-102" } } },
    },
  });
  await db.taskEventLink.upsert({
    where: { userId_clickupTaskId_calendarEventId: { userId: MOCK_USER, clickupTaskId: "mock-102", calendarEventId: event.id } },
    update: {}, create: { userId: MOCK_USER, clickupTaskId: "mock-102", calendarEventId: event.id },
  });
  await db.syncState.upsert({
    where: { userId_id: { userId: MOCK_USER, id: "mock" } }, update: {},
    create: { userId: MOCK_USER, id: "mock", source: "mock", lastSyncAt: new Date() },
  });
}

main().finally(() => db.$disconnect());
