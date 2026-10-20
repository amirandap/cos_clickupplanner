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

Abre `http://127.0.0.1:3000`. El archivo de ejemplo usa datos mock y una base en `prisma/dev.db`, excluida de Git. Arrastra una tarea sobre un espacio libre para crear un bloque o sobre un evento para vincularla. También puedes usar el botón **Agendar** de la tarea para elegir una fecha o vincular un evento con el teclado. Reiniciar la aplicación conserva las modificaciones en SQLite.

## Cuentas reales

Configura `USE_MOCK_DATA=false`, `APP_URL`, `APP_TIMEZONE`, `DATABASE_URL`, `CLICKUP_LIST_IDS`, `GOOGLE_CALENDAR_ID`, `PLANNER_AUTH_USERNAME`, `PLANNER_AUTH_PASSWORD` y las credenciales de ClickUp y Google en un gestor de secretos o en un `.env` local. El navegador solicita usuario y contraseña mediante HTTP Basic. En modo real, la instancia bloquea el acceso si falta esta configuración; para acceso remoto usa HTTPS. El modo mock permite una demostración sin credenciales y filtra los datos reales de la caché. Consulta [.env.example](.env.example) para los nombres. Las URLs de retorno OAuth son `${APP_URL}/api/auth/clickup/callback` y `${APP_URL}/api/auth/google/callback`.

ClickUp admite `CLICKUP_TOKEN` o `CLICKUP_CLIENT_ID` y `CLICKUP_CLIENT_SECRET`. Google usa `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y opcionalmente `GOOGLE_REFRESH_TOKEN` para la conexión inicial por configuración. Al conectar mediante OAuth, Google debe entregar un refresh token nuevo; la app nunca reutiliza el de otra conexión. Tras configurar las cuentas, reinicia la app y sincroniza. Los tokens OAuth obtenidos por la app permanecen en SQLite; protege la base de datos y haz copias de seguridad.

Las tareas se agrupan por estado y pueden filtrarse por asignado. ClickUp usa listados completos y revalida individualmente las tareas ausentes antes de retirarlas de la caché. Google usa cursores guardados en `SyncState`; un cursor vencido se recupera con una instantánea completa que reconcilia solamente el calendario configurado. Los datos remotos conservan `rawJson`, `remoteUpdated` y `syncedAt`. Las modificaciones externas de horario se propagan a ClickUp al sincronizar. Las llamadas externas tienen límite de tiempo y validación de respuesta.

Las recurrencias diarias, semanales, mensuales y anuales se expanden desde SQLite para el rango visible, respetando zona horaria, cambios de horario, excepciones y cancelaciones. Las reglas subhorarias, listas de múltiples horas/minutos/segundos y expansiones excesivas se rechazan explícitamente. Los eventos recurrentes se muestran en consulta; sus cambios se realizan desde Google Calendar para evitar modificar una serie completa por accidente.

Al crear un bloque, Google Calendar guarda `extendedProperties.private.source=planner` y `clickupTaskId`. La relación también queda en `TaskEventLink`. La app actualiza el vencimiento de ClickUp y añade un comentario con la hora prevista. Si falla ClickUp después de guardar el bloque, devuelve éxito parcial con un aviso y conserva el vínculo para sincronizar. Un comentario con respuesta incierta no se reenvía automáticamente; queda señalado para revisar en ClickUp. Los rechazos definitivos permiten reintentar después de corregir la conexión. Para conservar una fecha límite diferente de la hora de trabajo, adapta esa política antes de usarla con tus tareas. La API pública de ClickUp no garantiza que este vínculo aparezca como asociación nativa en ClickUp Planner.

`POST /api/planner/events` requiere `Idempotency-Key` (8–128 caracteres). El cliente conserva las claves de intentos ambiguos durante recargas de la pestaña. La operación y el ID determinista de Google se guardan de forma durable, por lo que repetir una petición conserva el mismo bloque. Una clave no puede reutilizarse con otra tarea, horario o calendario. La contención temporal devuelve 423 y conserva la clave para reintentar. Los códigos 409/410 cierran ese intento; una acción posterior explícita genera otra clave. Un bloqueo compartido en SQLite serializa las mutaciones y la sincronización.

## Comprobaciones

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

Las pruebas de integración usan bases SQLite temporales con las migraciones reales y proveedores simulados; no modifican la base del desarrollador ni las cuentas remotas. La migración de unicidad de vínculos conserva los conflictos históricos en `TaskEventLinkConflict` antes de consolidarlos.

## Despliegue privado con PM2 y Doppler

`deploy/clickup-planner.service.template` es una plantilla de systemd. Sustituye sus marcadores por rutas, usuario y nombre de proyecto/configuración propios. El token de servicio de Doppler debe tener permiso de **solo lectura** y vivir en un `EnvironmentFile` fuera del repositorio, accesible únicamente por root. `doppler run` inyecta las variables al iniciar `pm2-runtime`. `deploy/ecosystem.config.cjs` usa `PLANNER_APP_ROOT` para localizar el build standalone.

Para un servidor que actualiza desde Git, clona este repositorio en un directorio de código separado del release activo. Antes de cada despliegue, haz backup consistente de SQLite, ejecuta `git pull --ff-only`, `npm ci`, `npx prisma migrate deploy` y `npm run build` con las variables de Doppler. Copia el resultado standalone a un release nuevo, cambia el enlace del release activo y reinicia el servicio. Mantén la base SQLite fuera de los releases. Comprueba la respuesta HTTP y el estado de PM2 antes de retirar el release anterior.

Despliegue automático: cada push a `main` ejecuta `.github/workflows/deploy.yml` (lint, typecheck y tests en GitHub; luego SSH como `github-deploy` con una clave restringida en `authorized_keys` a `sudo /opt/cos_clickupplanner/source/deploy/deploy.sh`, permitido por `/etc/sudoers.d/github-deploy-cos-clickupplanner`). `deploy/deploy.sh` hace backup de SQLite, `npm ci`, `prisma migrate deploy`, build, release nuevo, conmutación del enlace, reinicio y health check, con rollback automático si falla. Secrets del repo: `SSH_HOST`, `SSH_USERNAME`, `SSH_KEY`, `SSH_KNOWN_HOSTS`.

Para acceso solo por Tailscale, publica en DNS un registro A **sin proxy** que apunte a la IP Tailscale del servidor y haz que el proxy web escuche únicamente en esa IP. Configura TLS por desafío DNS. El registro DNS es público, pero la IP Tailscale solo es alcanzable desde el tailnet autorizado.

## Licencia

MIT. Consulta [LICENSE](LICENSE).
