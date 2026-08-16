#!/bin/sh
# Buduje crontab ze zmiennych srodowiskowych i oddaje sterowanie crondowi.
set -eu

DAILY_CRON="${BACKUP_CRON:-30 3 * * *}"        # codziennie 03:30
WEEKLY_CRON="${BACKUP_SEND_CRON:-0 4 * * 0}"   # niedziela 04:00 — wysylka na Telegram

# Crond nie dziedziczy srodowiska kontenera, wiec zrzucamy je do pliku
# i ladujemy w kazdym zadaniu.
env | grep -E '^(POSTGRES_|PG|BACKUP_|BOT_TOKEN)' | sed 's/^/export /' > /etc/backup.env
chmod 600 /etc/backup.env

cat > /etc/crontabs/root <<EOF
${DAILY_CRON} . /etc/backup.env && /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1
${WEEKLY_CRON} . /etc/backup.env && /usr/local/bin/backup.sh --send >> /proc/1/fd/1 2>&1
EOF

echo "[backup] harmonogram:"
echo "[backup]   zrzut lokalny : ${DAILY_CRON}"
echo "[backup]   wysylka TG    : ${WEEKLY_CRON}"
echo "[backup]   retencja      : ${BACKUP_KEEP_DAYS:-14} dni"
[ -z "${BACKUP_PASSPHRASE:-}" ] && echo "[backup]   UWAGA: brak BACKUP_PASSPHRASE, kopie beda NIEzaszyfrowane"

# Zrzut od razu po starcie, zeby nie czekac do pierwszego wyzwolenia crona.
if [ "${BACKUP_ON_START:-true}" = "true" ]; then
  echo "[backup] wykonuje zrzut startowy…"
  /usr/local/bin/backup.sh || echo "[backup] zrzut startowy nieudany — crond i tak wystartuje"
fi

exec crond -f -l 8
