# cos_clickupplanner

Planificador personal con tareas de ClickUp, tiempo de Google Calendar y caché local SQLite. La interfaz lee de SQLite; las llamadas a servicios externos ocurren en el servidor.

## Inicio rápido

Requiere Node.js 20 o superior.

```bash
npm ci
cp .env.example .env
npx prisma migrate deploy
npm run db:seed
npm run dev
```

Abre `http://127.0.0.1:3000`. El archivo de ejemplo usa datos mock y una base en `prisma/dev.db`, excluida de Git. Arrastra una tarea sobre un espacio libre para crear un bloque o sobre un evento para vincularla. Reiniciar la aplicación conserva las modificaciones en SQLite.

## Cuentas reales

Configura `USE_MOCK_DATA=false`, `APP_URL`, `APP_TIMEZONE`, `DATABASE_URL`, `CLICKUP_LIST_IDS`, `GOOGLE_CALENDAR_ID` y las credenciales de ClickUp y Google en un gestor de secretos o en un `.env` local. Consulta [.env.example](.env.example) para los nombres. Las URLs de retorno OAuth son `${APP_URL}/api/auth/clickup/callback` y `${APP_URL}/api/auth/google/callback`.

ClickUp admite `CLICKUP_TOKEN` o `CLICKUP_CLIENT_ID` y `CLICKUP_CLIENT_SECRET`. Google usa `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y opcionalmente `GOOGLE_REFRESH_TOKEN`. Tras configurar las cuentas, reinicia la app y sincroniza. Los tokens OAuth obtenidos por la app permanecen en SQLite; protege la base de datos y haz copias de seguridad. No expongas una instancia con credenciales personales a Internet sin autenticación adicional.

Las tareas se agrupan por estado y pueden filtrarse por asignado. La primera sincronización lee las listas y el calendario configurados; las posteriores usan los cursores guardados en `SyncState`. Los datos remotos conservan `rawJson`, `remoteUpdated` y `syncedAt`. La app confirma el estado remoto antes de eliminar registros locales.

Al crear un bloque, Google Calendar guarda `extendedProperties.private.source=planner` y `clickupTaskId`. La relación también queda en `TaskEventLink`. La app actualiza el vencimiento de ClickUp y añade un comentario con la hora prevista. Si falla la actualización de ClickUp, conserva el vínculo y reintenta al sincronizar. Para conservar una fecha límite diferente de la hora de trabajo, adapta esa política antes de usarla con tus tareas. La API pública de ClickUp no garantiza que este vínculo aparezca como asociación nativa en ClickUp Planner.

## Comprobaciones

```bash
npm run lint
npm run typecheck
npm run build
```

## Despliegue privado con PM2 y Doppler

`deploy/clickup-planner.service.template` es una plantilla de systemd. Sustituye sus marcadores por rutas, usuario y nombre de proyecto/configuración propios. El token de servicio de Doppler debe tener permiso de **solo lectura** y vivir en un `EnvironmentFile` fuera del repositorio, accesible únicamente por root. `doppler run` inyecta las variables al iniciar `pm2-runtime`. `deploy/ecosystem.config.cjs` usa `PLANNER_APP_ROOT` para localizar el build standalone.

Para un servidor que actualiza desde Git, clona este repositorio en un directorio de código separado del release activo. Antes de cada despliegue, haz backup consistente de SQLite, ejecuta `git pull --ff-only`, `npm ci`, `npx prisma migrate deploy` y `npm run build` con las variables de Doppler. Copia el resultado standalone a un release nuevo, cambia el enlace del release activo y reinicia el servicio. Mantén la base SQLite fuera de los releases. Comprueba la respuesta HTTP y el estado de PM2 antes de retirar el release anterior.

Para acceso solo por Tailscale, publica en DNS un registro A **sin proxy** que apunte a la IP Tailscale del servidor y haz que el proxy web escuche únicamente en esa IP. Configura TLS por desafío DNS. El registro DNS es público, pero la IP Tailscale solo es alcanzable desde el tailnet autorizado.

## Licencia

MIT. Consulta [LICENSE](LICENSE).
