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

Abre `http://127.0.0.1:3000`. El archivo de ejemplo usa datos mock (sin login, solo fuera de producción) y una base en `prisma/dev.db`, excluida de Git. Arrastra una tarea sobre un espacio libre para crear un bloque o sobre un evento para vincularla. También puedes usar el botón **Agendar** de la tarea para elegir una fecha o vincular un evento con el teclado. Reiniciar la aplicación conserva las modificaciones en SQLite.

## Multiusuario

Cada persona entra con su cuenta de Google. La aplicación guarda **por usuario**: credenciales (cifradas), ajustes (`calendarId`, `listIds`, zona horaria), eventos de calendario, vínculos tarea-evento, operaciones de agendamiento, cursores de sincronización y bloqueos. Las tareas de ClickUp se guardan en una caché compartida, pero cada usuario solo ve las que **su propio token** de ClickUp devolvió (y que están en sus listas o asignadas a su `clickupUserId`). Ningún token de un usuario se usa para otro y un recurso ajeno responde 404, igual que uno inexistente.

### Variables de entorno

| Variable | Obligatoria | Uso |
| --- | --- | --- |
| `APP_URL` | sí | Origen público (`https://planner.ejemplo.com`). Define las URL de retorno OAuth, el flag `Secure`/prefijo `__Host-` de las cookies y la comprobación `Origin` anti-CSRF. |
| `DATABASE_URL` | sí | Base SQLite. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | sí | Un único cliente OAuth de Google para toda la app. |
| `TOKEN_ENCRYPTION_KEY` | sí | 32 bytes en base64 (`openssl rand -base64 32`). Cifra con AES-256-GCM todos los tokens guardados. |
| `TOKEN_ENCRYPTION_KEY_VERSION` | no | Entero de la clave actual (por defecto `1`). |
| `TOKEN_ENCRYPTION_KEYS_OLD` | no | Claves anteriores `version:base64,...`, solo para descifrar durante una rotación. |
| `AUTH_ALLOWED_DOMAIN` | no | Vacío = sin restricción en la app (Google, con el cliente *Internal*, ya limita quién entra). Si se define, solo entran correos de ese dominio. |
| `BOOTSTRAP_ADMIN_EMAIL` | no | Quién hereda los datos del antiguo usuario único. Vacío = la primera persona que inicie sesión. |
| `APP_TIMEZONE` | no | Zona horaria inicial de usuarios nuevos (cada uno la cambia en Ajustes). |
| `USE_MOCK_DATA` | no | `true` activa datos de demostración y **omite el login solo si `NODE_ENV` no es `production`**. |

Ya no existen `PLANNER_AUTH_USERNAME/PASSWORD`, `CLICKUP_TOKEN`, `CLICKUP_LIST_IDS`, `CLICKUP_DEFAULT_ASSIGNEE_ID`, `CLICKUP_CLIENT_ID/SECRET`, `GOOGLE_CALENDAR_ID` ni `GOOGLE_REFRESH_TOKEN`. Solo se leen una vez, en `prisma/migrate-single-user.ts`, para trasladar la configuración antigua.

### Cliente OAuth de Google

1. En Google Cloud crea (o reutiliza) un proyecto y configura la pantalla de consentimiento con tipo de usuario **Internal**. Así solo cuentas de tu organización de Workspace pueden autorizar.
2. Credenciales, crear **ID de cliente OAuth**, tipo *Aplicación web*, y añade estas URI de redirección autorizadas (con tu `APP_URL`):
   - `${APP_URL}/api/auth/login/google/callback` (inicio de sesión: `openid email profile`)
   - `${APP_URL}/api/auth/google/callback` (conexión de Calendar: `calendar.events`, `access_type=offline`, `prompt=consent`)
3. Habilita la API de Google Calendar en el proyecto y pon `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en el gestor de secretos.

El acceso son dos pasos separados. En `/login` solo se pide identidad. El `id_token` se valida en el servidor (firma RS256 contra el JWKS de Google, `iss`, `aud`, `exp`, `nonce`, `email_verified`) y la identidad es el `sub`. Después, en **Ajustes** el usuario pulsa *Conectar Google Calendar*, que pide el permiso de Calendar y guarda el refresh token cifrado. `state`, `nonce` y PKCE se guardan en el servidor atados a una cookie del navegador que inició el flujo (y, para Calendar, a la sesión). Si Google devuelve `invalid_grant`, la credencial se marca revocada y la app pide reconectar.

En **Ajustes** cada usuario pega su token personal de ClickUp. Se valida con `GET /user` y de ahí se toma su `clickupUserId`. Un 401 posterior marca el token como inválido.

Las sesiones son cookies opacas (`__Host-planner_session` sobre HTTPS): en la base solo se guarda el hash, con `HttpOnly`, `Secure`, `SameSite=Lax`, caducidad por inactividad de 7 días renovable y tope absoluto de 30 días. Las peticiones que modifican datos exigen `Origin` igual al de `APP_URL` (o `Sec-Fetch-Site: same-origin`). `POST /api/sync` admite 10 peticiones por minuto y usuario.

### Migración desde la versión de usuario único (producción)

1. Haz un backup consistente de la base SQLite.
2. Crea el cliente OAuth y define en el gestor de secretos `APP_URL`, `GOOGLE_CLIENT_ID/SECRET`, `TOKEN_ENCRYPTION_KEY` (y `BOOTSTRAP_ADMIN_EMAIL` si no quieres que herede la primera persona). **Deja temporalmente las variables antiguas** (`CLICKUP_LIST_IDS`, `GOOGLE_CALENDAR_ID`, `CLICKUP_TOKEN`...) hasta el paso 4.
3. `npx prisma migrate deploy`. La migración `20261020120000_multiuser` recrea las tablas con `userId`, asigna todo lo existente a un usuario provisional `legacy-single-user` y le da visibilidad sobre las tareas en caché. No borra `OAuthCredential`.
4. `npx tsx prisma/migrate-single-user.ts` (con `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY` y las variables antiguas). Mueve la configuración global a los ajustes de ese usuario, cifra los tokens antiguos como credenciales por usuario y vacía `OAuthCredential`. Es idempotente y no imprime secretos. Ejecútalo antes de que nadie entre, o justo después: el usuario provisional lo reclama el primer inicio de sesión elegible y el script sigue encontrándolo por su id.
5. Reinicia la app. La primera persona en entrar (o `BOOTSTRAP_ADMIN_EMAIL`) hereda los datos. El resto crea su usuario vacío y conecta sus cuentas en Ajustes.
6. Quita las variables antiguas del gestor de secretos. Una migración posterior puede eliminar la tabla `OAuthCredential`.

El despliegue automático (`deploy/deploy.sh`) ya ejecuta `prisma migrate deploy`. Define las variables nuevas **antes** de integrar esta rama en `main`: sin `APP_URL`, `GOOGLE_CLIENT_*` o `TOKEN_ENCRYPTION_KEY` la instancia no permite iniciar sesión.

### Rotar `TOKEN_ENCRYPTION_KEY`

1. Genera la nueva: `openssl rand -base64 32`.
2. Define `TOKEN_ENCRYPTION_KEY=<nueva>`, `TOKEN_ENCRYPTION_KEY_VERSION=<n+1>` y `TOKEN_ENCRYPTION_KEYS_OLD=<n>:<clave anterior>` (separa varias con comas).
3. Reinicia la app (ya cifra con la nueva y descifra con ambas) y ejecuta `npx tsx prisma/rotate-token-key.ts`, que reescribe cada credencial con la clave actual.
4. Comprueba que devuelve `rotated` igual al total esperado y retira `TOKEN_ENCRYPTION_KEYS_OLD`.

Si se pierde la clave, los tokens guardados son irrecuperables: cada usuario debe reconectar Google Calendar y volver a pegar su token de ClickUp.

## Cuentas reales

Configura `USE_MOCK_DATA=false` y las variables de la tabla anterior en un gestor de secretos o en un `.env` local. Consulta [.env.example](.env.example) para los nombres. Para acceso remoto usa HTTPS: con `APP_URL` en `https://` las cookies usan `Secure` y el prefijo `__Host-`. Los tokens de cada usuario permanecen cifrados en SQLite, pero protege igualmente la base de datos y la clave, y haz copias de seguridad.

Las tareas se agrupan por estado y pueden filtrarse por asignado. ClickUp usa listados completos con el token del usuario y revalida individualmente las tareas ausentes antes de retirarlas de la caché. Google usa cursores guardados en `SyncState`; un cursor vencido se recupera con una instantánea completa que reconcilia solamente el calendario configurado. Los datos remotos conservan `rawJson`, `remoteUpdated` y `syncedAt`. Las modificaciones externas de horario se propagan a ClickUp al sincronizar. Las llamadas externas tienen límite de tiempo y validación de respuesta.

Las recurrencias diarias, semanales, mensuales y anuales se expanden desde SQLite para el rango visible, respetando zona horaria, cambios de horario, excepciones y cancelaciones. Las reglas subhorarias, listas de múltiples horas/minutos/segundos y expansiones excesivas se rechazan explícitamente. Los eventos recurrentes se muestran en consulta; sus cambios se realizan desde Google Calendar para evitar modificar una serie completa por accidente.

Al crear un bloque, Google Calendar guarda `extendedProperties.private.source=planner` y `clickupTaskId`. La relación también queda en `TaskEventLink`. La app actualiza el vencimiento de ClickUp y añade un comentario con la hora prevista. Si falla ClickUp después de guardar el bloque, devuelve éxito parcial con un aviso y conserva el vínculo para sincronizar. Un comentario con respuesta incierta no se reenvía automáticamente; queda señalado para revisar en ClickUp. Los rechazos definitivos permiten reintentar después de corregir la conexión. Para conservar una fecha límite diferente de la hora de trabajo, adapta esa política antes de usarla con tus tareas. La API pública de ClickUp no garantiza que este vínculo aparezca como asociación nativa en ClickUp Planner.

`POST /api/planner/events` requiere `Idempotency-Key` (8–128 caracteres). El cliente conserva las claves de intentos ambiguos durante recargas de la pestaña. La operación y el ID determinista de Google se guardan de forma durable, por lo que repetir una petición conserva el mismo bloque. Una clave no puede reutilizarse con otra tarea, horario o calendario. La contención temporal devuelve 423 y conserva la clave para reintentar. Los códigos 409/410 cierran ese intento; una acción posterior explícita genera otra clave. Un bloqueo en SQLite por usuario serializa sus mutaciones y su sincronización.

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

Despliegue automático: `deploy/deploy.sh` compara `origin/main` con el release activo; si hay cambios hace backup de SQLite, `npm ci`, `prisma migrate deploy`, build, release nuevo, conmutación del enlace, reinicio y health check (rollback automático si falla). `deploy/daymark-deploy.timer` lo ejecuta cada 2 minutos. Instalación: copia `daymark-deploy.service` y `.timer` a `/etc/systemd/system/` y ejecuta `systemctl enable --now daymark-deploy.timer`. Bitácora: `journalctl -u daymark-deploy`.

Para acceso solo por Tailscale, publica en DNS un registro A **sin proxy** que apunte a la IP Tailscale del servidor y haz que el proxy web escuche únicamente en esa IP. Configura TLS por desafío DNS. El registro DNS es público, pero la IP Tailscale solo es alcanzable desde el tailnet autorizado.

## Licencia

MIT. Consulta [LICENSE](LICENSE).
