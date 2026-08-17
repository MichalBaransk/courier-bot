#!/bin/sh
# Test odtworzenia backupu — sprawdza, czy kopia da sie ODSZYFROWAC i WGRAC.
#
#   docker compose exec -T backup /usr/local/bin/test-odtworzenia.sh
#   docker compose exec -T backup /usr/local/bin/test-odtworzenia.sh /backups/courierdb-2026-08-16_1457.sql.gz.gpg
#
# Backup, ktorego nigdy nie przywracano, jest tylko przypuszczeniem. Ten skrypt
# zamienia wielolinijkowa procedure z README w jedno polecenie, zeby nie bylo
# wymowki, zeby jej nie uruchomic.
#
# CZEGO TEN SKRYPT NIE SPRAWDZA:
#  - czy haslo z menedzera hasel jest tym samym haslem co `BACKUP_PASSPHRASE`
#    w `.env` — uzywa tego z kontenera, a prawdziwe odtworzenie to scenariusz,
#    w ktorym serwera juz nie ma. Zeby to sprawdzic, podaj haslo recznie:
#       BACKUP_PASSPHRASE='...' /usr/local/bin/test-odtworzenia.sh
#  - czy cotygodniowa wysylka na Telegram dziala (osobno: backup.sh --send).
#
# BEZPIECZENSTWO: nie dotyka bazy produkcyjnej. Wszystko ladzie w tymczasowej
# bazie, ktora jest kasowana na koncu — takze wtedy, gdy cos padnie po drodze.

set -eu

: "${POSTGRES_HOST:?brak POSTGRES_HOST}"
: "${POSTGRES_USER:?brak POSTGRES_USER}"
: "${POSTGRES_DB:?brak POSTGRES_DB}"
: "${PGPASSWORD:?brak PGPASSWORD}"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
TESTOWA="${RESTORE_TEST_DB:-restore_test}"

log() { echo "[test-odtworzenia] $*"; }
psql_do() { psql -h "$POSTGRES_HOST" -p "${POSTGRES_PORT:-5432}" -U "$POSTGRES_USER" "$@"; }

# --- Wybor pliku ------------------------------------------------------------
PLIK="${1:-}"
if [ -z "$PLIK" ]; then
  PLIK="$(ls -1t "$BACKUP_DIR"/*.gpg "$BACKUP_DIR"/*.sql.gz 2>/dev/null | head -1 || true)"
fi

if [ -z "$PLIK" ] || [ ! -f "$PLIK" ]; then
  log "BLAD: nie znalazlem zadnej kopii w ${BACKUP_DIR}."
  exit 1
fi

log "kopia: $PLIK"

ROBOCZY="$(mktemp -d)"
# Sprzatanie ZAWSZE, takze po bledzie — inaczej `restore_test` zostaje
# w klastrze i przy kolejnym uruchomieniu `createdb` sie wywala.
sprzatnij() {
  rm -rf "$ROBOCZY"
  psql_do -d postgres -q -c "DROP DATABASE IF EXISTS ${TESTOWA}" >/dev/null 2>&1 || true
}
trap sprzatnij EXIT
ARCHIWUM="$ROBOCZY/kopia.sql.gz"

# --- 1. Odszyfrowanie -------------------------------------------------------
# To jest wlasciwy test. Reszta tylko potwierdza, ze odszyfrowana tresc ma sens.
case "$PLIK" in
  *.gpg)
    : "${BACKUP_PASSPHRASE:?kopia jest zaszyfrowana, a nie ma BACKUP_PASSPHRASE}"
    log "odszyfrowuje…"
    gpg --batch --quiet --decrypt --passphrase "$BACKUP_PASSPHRASE" \
        --output "$ARCHIWUM" "$PLIK"
    ;;
  *)
    log "UWAGA: kopia nie jest zaszyfrowana"
    cp "$PLIK" "$ARCHIWUM"
    ;;
esac

# --- 2. Calosc archiwum -----------------------------------------------------
# Haslo moze pasowac, a plik i tak byc uciety — gzip trzyma sume kontrolna.
log "sprawdzam sume kontrolna archiwum…"
gunzip -t "$ARCHIWUM"

ROZMIAR="$(stat -c %s "$ARCHIWUM")"
log "odszyfrowane i cale ($(du -h "$ARCHIWUM" | cut -f1), ${ROZMIAR} B)"

# --- 3. Odtworzenie do bazy tymczasowej -------------------------------------
log "tworze baze ${TESTOWA}…"
psql_do -d postgres -q -c "DROP DATABASE IF EXISTS ${TESTOWA}"
psql_do -d postgres -q -c "CREATE DATABASE ${TESTOWA}"

log "wgrywam zrzut…"
gunzip -c "$ARCHIWUM" | psql_do -d "$TESTOWA" -q -v ON_ERROR_STOP=0 >/dev/null

# --- 4. Porownanie liczby wierszy -------------------------------------------
TABELE="users daily_records fuel_receipts cash_tips wallet_transactions course_offers earning_targets"

echo
printf '%-22s %10s %10s\n' 'tabela' 'kopia' 'produkcja'
printf '%-22s %10s %10s\n' '----------------------' '----------' '----------'

PUSTE=0
WIECEJ=0
for T in $TABELE; do
  # Tabela moze nie istniec w kopii starszej niz migracja, ktora ja dodala.
  K="$(psql_do -d "$TESTOWA" -tAc "SELECT count(*) FROM ${T}" 2>/dev/null || echo '-')"
  P="$(psql_do -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM ${T}" 2>/dev/null || echo '-')"
  printf '%-22s %10s %10s\n' "$T" "$K" "$P"

  [ "$K" = "0" ] && [ "$P" != "0" ] && PUSTE=$((PUSTE + 1))
  if [ "$K" != "-" ] && [ "$P" != "-" ] && [ "$K" -gt "$P" ] 2>/dev/null; then
    WIECEJ=$((WIECEJ + 1))
  fi
done
echo

# --- 5. Werdykt -------------------------------------------------------------
#
# Kopia MNIEJSZA od produkcji to norma — powstala wczesniej, a od tego czasu
# doszly wpisy. Alarm to co innego: pusta tabela, ktora na produkcji ma dane
# (zrzut nie objal wszystkiego), albo kopia WIEKSZA od produkcji (ktos skasowal
# dane z produkcji i o tym nie wie).
if [ "$PUSTE" -gt 0 ]; then
  log "BLAD: ${PUSTE} tabel(a) jest w kopii PUSTA, choc na produkcji ma dane."
  exit 1
fi

if [ "$WIECEJ" -gt 0 ]; then
  log "UWAGA: ${WIECEJ} tabel(a) ma w kopii WIECEJ wierszy niz na produkcji."
  log "Kopia jest sprawna, ale ktos skasowal dane z produkcji — sprawdz, czy celowo."
fi

log "OK — kopia jest czytelna, kompletna i da sie ja wgrac."
log "Baza ${TESTOWA} zostala skasowana."
