#!/usr/bin/env bash
# Pełne wdrożenie z WSL na serwer, jednym poleceniem: npm run wdroz
#
# Kolejność jest celowa: nic nie leci na serwer, dopóki typy i testy nie są zielone.
set -euo pipefail

SERWER="${SERWER:-root@192.168.1.50}"
KATALOG_SERWERA="${KATALOG_SERWERA:-/share/courier-bot}"
OPIS="${1:-wdrozenie $(date +%F' '%H:%M)}"

echo "🔍 1/5  Sprawdzam typy…"
npm run typecheck

echo
echo "🧪 2/5  Uruchamiam testy…"
npm test

echo
if [ -z "$(git status --porcelain)" ]; then
  echo "📦 3/5  Brak zmian do zacommitowania — pomijam."
else
  echo "📦 3/5  Commituję:"
  git status --short
  git add -A
  git commit -m "$OPIS"
fi

echo
echo "⬆️  4/5  Wypycham na GitHuba…"
git push

echo
echo "🚀 5/5  Wdrażam na serwerze ($SERWER)…"
echo "     (za chwilę zapyta o hasło — POCZEKAJ na pytanie, nie wpisuj nic wcześniej)"
echo
ssh -t "$SERWER" "cd '$KATALOG_SERWERA' && sh scripts/wdroz-serwer.sh"

echo
echo "🎉 Gotowe. Sprawdź jeszcze bota w Telegramie."
