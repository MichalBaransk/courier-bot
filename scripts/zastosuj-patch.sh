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

# --- Czy to na pewno TO repozytorium? ---------------------------------------
#
# Sprawdzane PRZED `git apply`, nie po nieudanej probie. Powod jest konkretny:
# patch skladajacy sie z samych NOWYCH plikow nie ma kontekstu do dopasowania,
# wiec `git apply --check` przechodzi w KAZDYM repozytorium. Kontrola po
# nieudanym nalozeniu nigdy by sie dla niego nie uruchomila — i wlasnie tak
# testy dat z aplikacji wyladowaly w repozytorium bota.
#
# Znacznik `# repo: <nazwa>` siedzi w naglowku patcha. `git apply` ignoruje
# wszystko przed pierwszym `diff --git`, wiec ta linia nic nie kosztuje.
NAZWA="$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json 2>/dev/null | head -1)"
REPO_Z_PATCHA="$(sed -n 's/^# repo:[[:space:]]*//p' "$ROBOCZY" | head -1 || true)"

if [ -n "$REPO_Z_PATCHA" ] && [ -n "$NAZWA" ] && [ "$REPO_Z_PATCHA" != "$NAZWA" ]; then
  echo "❌ Ten patch jest do INNEGO REPOZYTORIUM — nie ruszam niczego."
  echo
  echo "   Patch deklaruje: $REPO_Z_PATCHA"
  echo "   A Ty jesteś w:   $NAZWA  ($(pwd))"
  echo
  echo "   telegram-bot  → cd ~/projekty/telegram-bot   (repo courier-bot)"
  echo "   courier-app   → cd ~/projekty/courier-app    (repo courier-mobile-app)"
  exit 1
fi

if [ -z "$REPO_Z_PATCHA" ]; then
  echo "ℹ️  Patch bez nagłówka '# repo:' — nie mogę potwierdzić repozytorium."
fi

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

# --- Diagnoza: złe repozytorium czy zły commit? ------------------------------
#
# To rozróżnienie kosztowało jedną rundę. Patch serwerowy nałożony w repo
# aplikacji dawał komunikat „stoisz na innym commicie" i sugerował `git stash`,
# bo skrypt nie miał pojęcia, że jest w niewłaściwym katalogu.
#
# Sprawdzenie jest proste: patch modyfikujący istniejące pliki musi trafić na
# CHOĆ JEDEN plik, który tutaj istnieje. Zero trafień przy patchu na kilka
# plików znaczy praktycznie zawsze złe repozytorium.
PLIKI="$(grep -oE '^diff --git a/[^ ]+' "$ROBOCZY" | sed 's|^diff --git a/||' | sort -u || true)"

ILE=0
TRAFIONE=0
while IFS= read -r F; do
  [ -n "$F" ] || continue
  ILE=$((ILE + 1))
  [ -e "$F" ] && TRAFIONE=$((TRAFIONE + 1))
done <<EOF
$PLIKI
EOF

echo
if [ "$ILE" -gt 1 ] && [ "$TRAFIONE" -eq 0 ]; then
  echo "❌ Ten patch jest do INNEGO REPOZYTORIUM."
  echo
  echo "   Jesteś w:  ${NAZWA:-?}  ($(pwd))"
  echo "   Patch rusza $ILE plików i ANI JEDEN z nich tu nie istnieje:"
  echo "$PLIKI" | head -5 | sed 's/^/     /'
  [ "$ILE" -gt 5 ] && echo "     … i $((ILE - 5)) więcej"
  echo
  echo "   telegram-bot  → cd ~/projekty/telegram-bot   (repo courier-bot)"
  echo "   courier-app   → cd ~/projekty/courier-app    (repo courier-mobile-app)"
  exit 1
fi

echo "❌ Patch nie pasuje do obecnego stanu repozytorium."
if [ -n "$REPO_Z_PATCHA" ]; then
  echo "   (repo się zgadza: $NAZWA — patch też deklaruje $REPO_Z_PATCHA)"
else
  echo "   (jesteś w: ${NAZWA:-?}, $TRAFIONE z $ILE plików patcha tu istnieje)"
  echo "   Patch nie ma nagłówka '# repo:', więc nie mam pewności co do repozytorium."
fi
echo
echo "Patch rusza te pliki:"
echo "$PLIKI" | sed 's/^/  /'
echo
echo "Najczęstsze przyczyny:"
echo "  • masz niezacommitowane zmiany  → git stash"
echo "  • stoisz na innym commicie      → git log --oneline -3"
echo
echo "Pokaż mi wynik 'git log --oneline -3' i zrobię patch na Twój commit."
exit 1
