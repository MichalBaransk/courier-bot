#!/usr/bin/env bash
# Nakłada patch przysłany w czacie. Uruchamiaj przez: npm run patch -- <plik>
set -euo pipefail

PATCH="${1:-}"

if [ -z "$PATCH" ]; then
  echo "Użycie: npm run patch -- /mnt/c/Users/micha/Downloads/nazwa.patch"
  exit 1
fi

if [ ! -f "$PATCH" ]; then
  echo "❌ Nie ma takiego pliku: $PATCH"
  echo "   Sprawdź: ls /mnt/c/Users/*/Downloads/*.patch"
  exit 1
fi

# Plik przeszedł przez Windowsa, więc mógł dostać końce linii CRLF.
# Pracujemy na kopii, żeby nie ruszać oryginału w Pobranych.
ROBOCZY="$(mktemp)"
trap 'rm -f "$ROBOCZY"' EXIT
sed 's/\r$//' "$PATCH" > "$ROBOCZY"

echo "🔎 Sprawdzam, czy patch wejdzie…"

if git apply --check "$ROBOCZY" 2>/dev/null; then
  git apply "$ROBOCZY"
  echo "✅ Nałożony."
  git status --short
  echo
  echo "Następny krok:  npm run sprawdz"
  exit 0
fi

# Najczęstszy przypadek: patch już jest nałożony (np. uruchomiony drugi raz).
if git apply --reverse --check "$ROBOCZY" 2>/dev/null; then
  echo "ℹ️  Ten patch JEST JUŻ nałożony — nie ma nic do zrobienia."
  git status --short
  exit 0
fi

echo "❌ Patch nie pasuje do obecnego stanu repozytorium."
echo
echo "Najczęstsze przyczyny:"
echo "  • masz niezacommitowane zmiany  → git stash"
echo "  • stoisz na innym commicie      → git log --oneline -3"
echo
echo "Pokaż mi wynik 'git log --oneline -3' i zrobię patch na Twój commit."
exit 1
