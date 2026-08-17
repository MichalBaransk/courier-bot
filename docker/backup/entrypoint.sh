#!/bin/sh
# Buduje crontab ze zmiennych srodowiskowych i oddaje sterowanie crondowi.
set -eu

DAILY_CRON="${BACKUP_CRON:-30 3 * * *}"        # codziennie 03:30
WEEKLY_CRON="${BACKUP_SEND_CRON:-0 4 * * 0}"   # niedziela 04:00 — wysylka na Telegram

# Crond nie dziedziczy srodowiska kontenera, wiec zrzucamy je do pliku
# i ladujemy w kazdym zadaniu.
#
# ⚠️ WARTOSCI MUSZA BYC W APOSTROFACH. Poprzednia wersja robila zwykle
# `sed 's/^/export /'`, przez co `BACKUP_CRON=30 3 * * *` stawalo sie linia
# `export BACKUP_CRON=30 3 * * *`. Powloka czytala to jako „wyeksportuj
# BACKUP_CRON, a potem zmienne o nazwach 3, *, *, *" i wywalala sie na
# `export: 3: bad variable name`. Efekt: `. /etc/backup.env && backup.sh`
# przerywalo sie na pierwszym czlonie, `&&` zwieralo, a zrzut Z CRONA NIGDY
# SIE NIE WYKONYWAL. Zrzut startowy dzialal, bo `entrypoint.sh` wola
# `backup.sh` wprost, ze srodowiskiem kontenera, bez zrodlowania tego pliku.
#
# Dlatego wartosc idzie w apostrofy, a apostrof w srodku jest escapowany
# wzorem '\'' — dziala tez dla hasel ze spacja, dolarem i cudzyslowem.
env | grep -E '^(POSTGRES_|PG|BACKUP_|BOT_TOKEN)' | while IFS='=' read -r NAZWA WARTOSC; do
  printf "export %s='%s'\n" "$NAZWA" "$(printf '%s' "$WARTOSC" | sed "s/'/'\\\\''/g")"
done > /etc/backup.env
chmod 600 /etc/backup.env

# Blad w tym pliku zabija WYLACZNIE zadania crona i robi to po cichu — przez
# ponad dobe nikt sie nie zorientowal. Lepiej nie wstac wcale niz udawac,
# ze backup dziala.
if ! sh -c '. /etc/backup.env' 2>/dev/null; then
  echo "[backup] BLAD KRYTYCZNY: /etc/backup.env nie daje sie zrodlowac."
  echo "[backup] Zadania crona nie mialyby szans sie wykonac. Przerywam."
  sh -c '. /etc/backup.env' || true
  exit 1
fi

# Klamry wokol CALEGO polecenia, nie tylko wokol `backup.sh`.
#
# Bez nich przekierowanie na `/proc/1/fd/1` obejmowalo wylacznie `backup.sh`,
# wiec blad zrodlowania `/etc/backup.env` szedl na stderr crond-a — a ten,
# uruchomiony bez `-L`, loguje do sysloga, ktory w kontenerze prowadzi
# donikad. Awaria byla wiec nie tylko cicha, ale i niewidoczna w
# `docker compose logs`.
cat > /etc/crontabs/root <<EOF
${DAILY_CRON} { . /etc/backup.env && /usr/local/bin/backup.sh; } >> /proc/1/fd/1 2>&1
${WEEKLY_CRON} { . /etc/backup.env && /usr/local/bin/backup.sh --send; } >> /proc/1/fd/1 2>&1
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

# `-L /proc/1/fd/1` kieruje log crond-a na stdout kontenera. Bez tego trafia
# do sysloga, czyli w kontenerze donikad — i nie widac nawet tego, ze zadanie
# w ogole zostalo odpalone.
exec crond -f -l 8 -L /proc/1/fd/1
