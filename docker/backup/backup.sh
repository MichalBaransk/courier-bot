#!/bin/sh
# Zrzut bazy -> gzip -> szyfrowanie AES256 -> katalog /backups
# Opcjonalnie wysyłka na prywatny czat Telegrama.
#
# Wołane z crona (patrz entrypoint.sh) albo ręcznie:
#   docker compose exec backup /usr/local/bin/backup.sh
#   docker compose exec backup /usr/local/bin/backup.sh --send

set -eu

SEND_TO_TELEGRAM=0
[ "${1:-}" = "--send" ] && SEND_TO_TELEGRAM=1

: "${POSTGRES_HOST:?brak POSTGRES_HOST}"
: "${POSTGRES_USER:?brak POSTGRES_USER}"
: "${POSTGRES_DB:?brak POSTGRES_DB}"
: "${PGPASSWORD:?brak PGPASSWORD}"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date +%Y-%m-%d_%H%M)"
BASENAME="${POSTGRES_DB}-${STAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

log() { echo "[backup $(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# --- Zrzut ------------------------------------------------------------------
# --clean --if-exists sprawia, że dump da się wgrać na niepustą bazę.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log "zrzucam ${POSTGRES_DB} z ${POSTGRES_HOST}…"
pg_dump \
  --host="$POSTGRES_HOST" \
  --port="${POSTGRES_PORT:-5432}" \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --clean --if-exists --no-owner --no-privileges \
  | gzip -9 > "$TMP/$BASENAME"

RAW_SIZE="$(du -h "$TMP/$BASENAME" | cut -f1)"

# Pusty albo podejrzanie mały zrzut to sygnał, że coś poszło nie tak.
MIN_BYTES="${BACKUP_MIN_BYTES:-1024}"
ACTUAL_BYTES="$(stat -c %s "$TMP/$BASENAME")"
if [ "$ACTUAL_BYTES" -lt "$MIN_BYTES" ]; then
  log "BŁĄD: zrzut ma tylko ${ACTUAL_BYTES} B (minimum ${MIN_BYTES} B) — przerywam."
  exit 1
fi

# --- Szyfrowanie ------------------------------------------------------------
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  OUTPUT="$BACKUP_DIR/${BASENAME}.gpg"
  gpg --batch --yes --quiet \
      --symmetric --cipher-algo AES256 \
      --passphrase "$BACKUP_PASSPHRASE" \
      --output "$OUTPUT" "$TMP/$BASENAME"
  log "zapisano ${OUTPUT} (${RAW_SIZE} przed szyfrowaniem)"
else
  OUTPUT="$BACKUP_DIR/$BASENAME"
  mv "$TMP/$BASENAME" "$OUTPUT"
  log "UWAGA: brak BACKUP_PASSPHRASE — kopia NIE jest zaszyfrowana."
  log "zapisano ${OUTPUT} (${RAW_SIZE})"
fi

# --- Rotacja ----------------------------------------------------------------
DELETED="$(find "$BACKUP_DIR" -name "${POSTGRES_DB}-*.sql.gz*" -type f -mtime "+${KEEP_DAYS}" -print -delete | wc -l)"
[ "$DELETED" -gt 0 ] && log "usunięto ${DELETED} kopii starszych niż ${KEEP_DAYS} dni"

# --- Wysyłka na Telegram ----------------------------------------------------
if [ "$SEND_TO_TELEGRAM" = "1" ]; then
  if [ -z "${BOT_TOKEN:-}" ] || [ -z "${BACKUP_CHAT_ID:-}" ]; then
    log "pomijam wysyłkę: brak BOT_TOKEN lub BACKUP_CHAT_ID"
    exit 0
  fi

  SIZE_BYTES="$(stat -c %s "$OUTPUT")"
  LIMIT=$((50 * 1024 * 1024)) # limit sendDocument dla botów
  if [ "$SIZE_BYTES" -gt "$LIMIT" ]; then
    log "kopia ma $((SIZE_BYTES / 1024 / 1024)) MB — przekracza limit 50 MB Telegrama, nie wysyłam"
    curl -sS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -d chat_id="$BACKUP_CHAT_ID" \
      -d text="⚠️ Kopia bazy ($(basename "$OUTPUT")) ma $((SIZE_BYTES / 1024 / 1024)) MB i nie zmieściła się w limicie Telegrama. Leży w wolumenie backupów." \
      > /dev/null
    exit 0
  fi

  CAPTION="🗄️ Kopia bazy ${POSTGRES_DB}
📅 ${STAMP}
📦 $(du -h "$OUTPUT" | cut -f1)"
  [ -n "${BACKUP_PASSPHRASE:-}" ] && CAPTION="${CAPTION}
🔐 AES256 — do odczytu potrzebne hasło"

  log "wysyłam na czat ${BACKUP_CHAT_ID}…"
  RESPONSE="$(curl -sS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendDocument" \
    -F chat_id="$BACKUP_CHAT_ID" \
    -F document=@"$OUTPUT" \
    -F caption="$CAPTION")"

  if echo "$RESPONSE" | grep -q '"ok":true'; then
    log "wysłano"
  else
    log "BŁĄD wysyłki: $RESPONSE"
    exit 1
  fi
fi

log "gotowe"
