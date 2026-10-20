#!/usr/bin/env bash
# Auto-deploy: si origin/main avanzó, construye un release nuevo, migra, conmuta y reinicia.
# Se ejecuta como root (timer de systemd). Rollback automático si falla el health check.
set -euo pipefail

SOURCE_DIR="${DAYMARK_SOURCE:-/opt/daymark/source}"
RELEASES_DIR="${DAYMARK_RELEASES:-/opt/daymark/releases}"
CURRENT_LINK="${DAYMARK_CURRENT:-/opt/daymark/current}"
STATE_DIR="${DAYMARK_STATE:-/var/lib/daymark}"
DB_FILE="$STATE_DIR/app.db"
BACKUP_DIR="$STATE_DIR/backups"
SERVICE="${DAYMARK_SERVICE:-daymark}"
APP_USER="${DAYMARK_USER:-daymark}"
HEALTH_URL="${DAYMARK_HEALTH_URL:-http://127.0.0.1:3117/}"
DOPPLER_AUTH="${DAYMARK_DOPPLER_AUTH:-/etc/daymark/doppler-auth.env}"
DOPPLER_PROJECT="${DAYMARK_DOPPLER_PROJECT:-amp}"
DOPPLER_CONFIG="${DAYMARK_DOPPLER_CONFIG:-prd_clickupplanner}"
KEEP_RELEASES=4

log() { printf '%s daymark-deploy: %s\n' "$(date -u +%FT%TZ)" "$*"; }

main() {
exec 9>/var/lock/daymark-deploy.lock
flock -n 9 || { log "otro despliegue en curso"; exit 0; }

cd "$SOURCE_DIR"
git fetch --quiet origin main
local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse origin/main)
if [ "$local_sha" = "$remote_sha" ] && [ -e "$CURRENT_LINK/.deployed-sha" ] \
  && [ "$(cat "$CURRENT_LINK/.deployed-sha")" = "$remote_sha" ]; then
  exit 0
fi

log "desplegando ${local_sha:0:7} -> ${remote_sha:0:7}"
git merge --ff-only origin/main

# Variables de Doppler solo dentro del proceso hijo; nunca se imprimen.
set -a; . "$DOPPLER_AUTH"; set +a
run_with_secrets() { doppler run --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" -- "$@"; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BACKUP_DIR"
sqlite3 "$DB_FILE" ".backup '$BACKUP_DIR/pre-deploy-$stamp.db'"
chown "$APP_USER:$APP_USER" "$BACKUP_DIR/pre-deploy-$stamp.db"

npm ci --no-audit --no-fund
run_with_secrets npx prisma migrate deploy
run_with_secrets npm run build

release="$RELEASES_DIR/$stamp/runtime"
mkdir -p "$release/.next"
cp -a .next/standalone/. "$release/"
cp -a .next/static "$release/.next/static"
cp -a public "$release/public"
mkdir -p -m 700 "$release/.next/cache"
echo "$remote_sha" > "$release/.deployed-sha"
chown -R "$APP_USER:$APP_USER" "$RELEASES_DIR/$stamp"

previous=$(readlink -f "$CURRENT_LINK")
echo "$previous" > "$(dirname "$CURRENT_LINK")/previous-runtime.path"
ln -sfn "$release" "$CURRENT_LINK.next" && mv -T "$CURRENT_LINK.next" "$CURRENT_LINK"
systemctl restart "$SERVICE"

healthy=0
for _ in $(seq 1 30); do
  sleep 2
  code=$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || true)
  # 200 sin credenciales (mock) o 401 del Basic Auth: ambos prueban que la app responde.
  if [ "$code" = "200" ] || [ "$code" = "401" ]; then healthy=1; break; fi
done

if [ "$healthy" != 1 ]; then
  log "health check falló; rollback a $previous"
  ln -sfn "$previous" "$CURRENT_LINK.next" && mv -T "$CURRENT_LINK.next" "$CURRENT_LINK"
  systemctl restart "$SERVICE"
  exit 1
fi

log "OK ${remote_sha:0:7} en $release"
ls -1dt "$RELEASES_DIR"/*/ | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf
}

# Todo el cuerpo vive en main() para que bash lo lea completo antes de que git actualice este archivo.
main "$@"
