# Wdrażanie — ściąga

Trzy polecenia. Wszystkie uruchamiasz **w WSL**, w `~/projekty/telegram-bot`.

```bash
cd ~/projekty/telegram-bot
```

---

## 1. Nałóż patch przysłany w czacie

```bash
npm run patch -- /mnt/c/Users/micha/Downloads/nazwa-pliku.patch
```

Skrypt sam naprawia końce linii z Windowsa i sam rozpoznaje, że patch jest **już nałożony** (wtedy tylko o tym mówi, zamiast sypać błędami).

Nie pamiętasz nazwy pliku:

```bash
ls /mnt/c/Users/*/Downloads/*.patch
```

---

## 2. Sprawdź, czy nic się nie zepsuło

```bash
npm run sprawdz
```

To `typecheck` i testy razem. **Musi być zielone**, zanim cokolwiek pójdzie dalej.

---

## 3. Wdróż

```bash
npm run wdroz
```

Robi po kolei: typecheck → testy → commit → push → SSH na serwer → `git pull` → przebudowa kontenera → log startowy → smoke test API.

Zatrzyma się na pierwszym błędzie, więc **na serwer nie trafi kod, który nie przeszedł testów**.

Własny opis commita:

```bash
npm run wdroz "obsluga tekstu"
```

### Zapyta o hasło do SSH

Poczekaj na pytanie i dopiero wtedy pisz. Wklejenie czegokolwiek wcześniej kończy się tym, że tekst zostaje zjedzony jako odpowiedź na pytanie (§12f) — to najczęstsza wpadka w tym projekcie.

Żeby przestało pytać, raz wgraj klucz:

```bash
ssh-copy-id root@192.168.1.50
```

Klucze na serwerze siedzą w `~/.ssh`, które prowadzi do trwałego `/data`, więc przeżyją restart dodatku.

---

## Coś poszło nie tak

| objaw | co zrobić |
|---|---|
| `patch does not apply` | `git log --oneline -3` i wyślij mi wynik |
| `already applied` | nic, patch jest na miejscu |
| typecheck na czerwono | **nie wdrażaj**, wyślij mi treść błędu |
| `no configuration file provided` | jesteś w złym katalogu — `cd /share/courier-bot` |
| `📱 API: WYŁĄCZONE` w logu | brak `API_TOKEN` w `.env` **na serwerze** (ten plik nie jest w gicie) |
| bot milczy po wdrożeniu | `docker compose --profile webhook logs --tail=40 bot` |

---

## Cofnięcie ostatniego wdrożenia

Na serwerze:

```bash
cd /share/courier-bot
git reset --hard HEAD~1
docker compose --profile webhook up -d --build bot
```

Webhooka to nie kasuje, więc wiadomości z czasu przestoju nie giną — Telegram trzyma je do 24 h.
