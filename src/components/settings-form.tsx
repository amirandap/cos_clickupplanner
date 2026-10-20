"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { goToLogin } from "@/components/planner/client";

type Connection = "connected" | "revoked" | "none";
export type SettingsView = {
  email: string; name: string | null; mockMode: boolean; googleCalendar: Connection;
  clickup: { state: Connection; clickupUserId: string | null; username: string | null };
  settings: { calendarId: string; listIds: string[]; timezone: string };
};

const GOOGLE_RESULTS: Record<string, string> = {
  connected: "Google Calendar conectado.",
  denied: "Cancelaste la conexión con Google Calendar.",
  invalid_state: "La conexión caducó. Inténtalo de nuevo.",
  no_refresh: "Google no entregó acceso renovable. Inténtalo de nuevo y acepta el permiso.",
  missing_scope: "Falta el permiso de Calendar. Inténtalo de nuevo y marca todos los permisos.",
  failed: "No se pudo conectar con Google Calendar. Inténtalo de nuevo.",
};

async function call(url: string, method: string, body?: unknown): Promise<SettingsView> {
  const response = await fetch(url, { method, cache: "no-store", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const data: unknown = await response.json().catch(() => null);
  if (response.status === 401) goToLogin();
  if (!response.ok) throw new Error(data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "No se pudo guardar. Inténtalo de nuevo.");
  return data as SettingsView;
}

const label = (state: Connection) => state === "connected" ? "Conectado" : state === "revoked" ? "Requiere reconexión" : "Sin conectar";

export default function SettingsForm({ initial, googleResult }: { initial: SettingsView; googleResult: string | null }) {
  const [view, setView] = useState(initial);
  const [token, setToken] = useState("");
  const [calendarId, setCalendarId] = useState(initial.settings.calendarId);
  const [listIds, setListIds] = useState(initial.settings.listIds.join(", "));
  const [timezone, setTimezone] = useState(initial.settings.timezone);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(
    googleResult ? { text: GOOGLE_RESULTS[googleResult] ?? GOOGLE_RESULTS.failed, error: googleResult !== "connected" } : null);

  async function act(operation: () => Promise<SettingsView>, success: string, after?: () => void) {
    setBusy(true);
    setMessage(null);
    try { setView(await operation()); setMessage({ text: success, error: false }); after?.(); }
    catch (error) { setMessage({ text: error instanceof Error ? error.message : "No se pudo guardar.", error: true }); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-4 px-4 py-8">
    <div className="flex items-center justify-between">
      <h1 className="text-xl font-semibold">Ajustes</h1>
      <Link href="/" className="text-sm underline underline-offset-4">Volver al planner</Link>
    </div>
    {message && <p role={message.error ? "alert" : "status"} className={`rounded-lg px-3 py-2 text-sm ${message.error ? "bg-destructive/10 text-destructive" : "bg-muted"}`}>{message.text}</p>}

    <Card>
      <CardHeader><CardTitle>Cuenta de Google</CardTitle><CardDescription>Sesión iniciada como {view.email}</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
        <div className="flex items-center justify-between gap-3">
          <div><p className="text-sm font-medium">Google Calendar</p><p className="text-sm text-muted-foreground">{label(view.googleCalendar)}</p></div>
          <div className="flex gap-2">
            <a href="/api/auth/google" className="inline-flex h-8 items-center rounded-lg bg-primary px-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/80">
              {view.googleCalendar === "connected" ? "Volver a conectar" : view.googleCalendar === "revoked" ? "Reconectar Google Calendar" : "Conectar Google Calendar"}
            </a>
            {view.googleCalendar !== "none" && <Button variant="outline" disabled={busy} onClick={() => void act(() => call("/api/settings/google-calendar", "DELETE"), "Google Calendar desconectado.")}>Desconectar</Button>}
          </div>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle>Token de ClickUp</CardTitle>
        <CardDescription>Tu token personal (ClickUp, Ajustes, Apps). Se valida contra ClickUp y se guarda cifrado.</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
        <p className="text-sm text-muted-foreground">
          {label(view.clickup.state)}{view.clickup.state === "connected" && view.clickup.username ? ` como ${view.clickup.username} (id ${view.clickup.clickupUserId})` : ""}
        </p>
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void act(() => call("/api/settings/clickup", "PUT", { token }), "Token de ClickUp guardado.", () => setToken("")); }}>
          <Input type="password" autoComplete="off" placeholder="pk_..." aria-label="Token de ClickUp" value={token} onChange={(event) => setToken(event.target.value)} />
          <Button type="submit" disabled={busy || !token.trim()}>Guardar</Button>
          {view.clickup.state !== "none" && <Button type="button" variant="outline" disabled={busy} onClick={() => void act(() => call("/api/settings/clickup", "DELETE"), "Token de ClickUp eliminado.")}>Quitar</Button>}
        </form>
      </CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle>Preferencias</CardTitle><CardDescription>Qué calendario y qué listas de ClickUp se muestran. Tus tareas asignadas siempre aparecen.</CardDescription></CardHeader>
      <CardContent className="px-4">
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void act(() => call("/api/settings", "PUT", { calendarId, listIds, timezone }), "Ajustes guardados."); }}>
          <label className="flex flex-col gap-1 text-sm">ID del calendario (primary para el principal)
            <Input value={calendarId} onChange={(event) => setCalendarId(event.target.value)} /></label>
          <label className="flex flex-col gap-1 text-sm">IDs de listas de ClickUp (separados por coma)
            <Input value={listIds} onChange={(event) => setListIds(event.target.value)} /></label>
          <label className="flex flex-col gap-1 text-sm">Zona horaria (por ejemplo America/Santo_Domingo)
            <Input value={timezone} onChange={(event) => setTimezone(event.target.value)} /></label>
          <div><Button type="submit" disabled={busy}>Guardar ajustes</Button></div>
        </form>
      </CardContent>
    </Card>
  </main>;
}
