#!/bin/sh
# Uruchamiany NA SERWERZE (Home Assistant OS), w /share/courier-bot.
# Zwykle wywoływany zdalnie przez scripts/wdroz.sh — ręcznie nie musisz go pamiętać.
#
# Świadomie /bin/sh, nie bash: dodatek SSH w HA to Alpine.
set -eu

cd "$(dirname "$0")/.."
echo "📂 $(pwd)"

# `docker-compose` bywa ulotny po restarcie dodatku (§3a) — dokładamy, gdy zniknął.
if ! docker compose version >/dev/null 2>&1; then
  echo "📦 Brak docker compose — instaluję…"
  apk add --no-cache docker-cli-compose
fi

echo "⬇️  Pobieram zmiany…"
git pull --ff-only

echo "🔨 Przebudowuję kontener bota…"
docker compose --profile webhook up -d --build bot

echo "⏳ Czekam na start…"
sleep 6

echo
echo "📜 Log startowy:"
docker compose --profile webhook logs --tail=20 bot

# --- Smoke test API ---------------------------------------------------------
# Wartości bierzemy z .env, bo ten plik nie jest w gicie i tylko on je zna.
TOKEN="$(grep '^API_TOKEN=' .env | cut -d= -f2- || true)"
DOMENA="$(grep '^WEBHOOK_DOMAIN=' .env | cut -d= -f2- | sed 's#^https\?://##; s#/*$##' || true)"

echo
if [ -z "$TOKEN" ] || [ -z "$DOMENA" ]; then
  echo "⚠️  Pomijam smoke test — brak API_TOKEN albo WEBHOOK_DOMAIN w .env"
  exit 0
fi

echo "🩺 Smoke test https://$DOMENA/api/v1/"

Z_TOKENEM="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "https://$DOMENA/api/v1/info")"
BEZ_TOKENA="$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMENA/api/v1/saldo")"

echo "   z tokenem  → $Z_TOKENEM   (oczekiwane 200)"
echo "   bez tokena → $BEZ_TOKENA   (oczekiwane 401)"

if [ "$Z_TOKENEM" = "200" ] && [ "$BEZ_TOKENA" = "401" ]; then
  echo "✅ API odpowiada poprawnie."
else
  echo "❌ API zachowuje się inaczej niż powinno — sprawdź log wyżej."
  exit 1
fi
