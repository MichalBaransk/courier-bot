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
# `git pull` MUSI być tutaj, a nie tylko w skrypcie serwerowym.
#
# Jajko i kura: `wdroz-serwer.sh` trafia na serwer dopiero przez `git pull`,
# więc dopóki tego pulla nie zrobimy stąd, nie ma czego uruchomić i wychodzi
# `sh: can't open 'scripts/wdroz-serwer.sh'`.
#
# Ten sam `git pull` jest jeszcze raz w środku skryptu — celowo. Dzięki temu
# działa też uruchomiony ręcznie na serwerze, a drugie wywołanie to no-op.
ssh -t "$SERWER" "cd '$KATALOG_SERWERA' && git pull --ff-only && sh scripts/wdroz-serwer.sh"

echo
echo "🎉 Gotowe. Sprawdź jeszcze bota w Telegramie."
