# Kontener backupu

Codzienny `pg_dump` do wolumenu + cotygodniowa zaszyfrowana kopia na prywatny czat Telegrama.

## Wpięcie w docker-compose.yml

Dopisz usługę i wolumen do istniejącego pliku:

```yaml
services:
  backup:
    build: ./docker/backup
    container_name: courier-backup
    restart: unless-stopped
    depends_on:
      - postgres
    environment:
      POSTGRES_HOST: postgres          # nazwa usługi bazy w tym compose
      POSTGRES_PORT: 5432
      POSTGRES_USER: postgres
      POSTGRES_DB: courierdb
      PGPASSWORD: ${POSTGRES_PASSWORD}
      # Harmonogram (UTC lub TZ kontenera — tu Europe/Warsaw)
      BACKUP_CRON: "30 3 * * *"        # codzienny zrzut lokalny
      BACKUP_SEND_CRON: "0 4 * * 0"    # niedzielna wysyłka na Telegram
      BACKUP_KEEP_DAYS: 14
      BACKUP_ON_START: "true"
      # Szyfrowanie — BEZ tego kopie lecą na Telegram otwartym tekstem
      BACKUP_PASSPHRASE: ${BACKUP_PASSPHRASE}
      # Wysyłka
      BOT_TOKEN: ${BOT_TOKEN}
      BACKUP_CHAT_ID: ${BACKUP_CHAT_ID}
    volumes:
      - backups:/backups

volumes:
  backups:
```

### Kopie na dysku hosta zamiast w wolumenie

Podmień wolumen na bind mount — przydatne, gdy katalog ma być widoczny
dla Home Assistant OS albo synchronizowany na zewnątrz:

```yaml
    volumes:
      - /mnt/data/glovobot-backups:/backups
```

## Konfiguracja

Do `.env`:

```
POSTGRES_PASSWORD=...
BACKUP_PASSPHRASE=długie-losowe-hasło-trzymane-POZA-serwerem
BACKUP_CHAT_ID=5066453902
```

`BACKUP_CHAT_ID` to zwykle Twoje własne `telegram_id` — bot wyśle plik
na prywatny czat z Tobą. Musisz mieć z nim rozpoczętą rozmowę (`/start`).

**Hasło szyfrujące trzymaj gdzie indziej niż serwer.** Kopia zaszyfrowana
hasłem leżącym obok niej nie chroni przed niczym poza przypadkowym wyciekiem
samego pliku z Telegrama.

## Uruchomienie

```bash
docker compose up -d --build backup
docker compose logs -f backup
```

Ręczny zrzut i ręczna wysyłka:

```bash
docker compose exec backup /usr/local/bin/backup.sh
docker compose exec backup /usr/local/bin/backup.sh --send
```

Lista kopii:

```bash
docker compose exec backup ls -lh /backups
```

## Odtworzenie z kopii

```bash
# 1. Wyciągnij plik z wolumenu (albo pobierz z Telegrama)
docker compose cp backup:/backups/courierdb-2026-08-16_0330.sql.gz.gpg .

# 2. Odszyfruj
gpg --batch --decrypt --passphrase "$BACKUP_PASSPHRASE" \
    --output courierdb.sql.gz courierdb-2026-08-16_0330.sql.gz.gpg

# 3. Wgraj (dump ma --clean --if-exists, więc nadpisze istniejące tabele)
docker compose stop bot
gunzip -c courierdb.sql.gz | docker compose exec -T postgres psql -U postgres -d courierdb
docker compose start bot
```

## ⚠️ Błąd naprawiony 17.08.2026 — cron NIGDY nie robił zrzutu

`entrypoint.sh` budował `/etc/backup.env` przez `sed 's/^/export /'`, bez
cudzysłowów wokół wartości. Wystarczyło, że któraś zmienna ma spację —
a `BACKUP_CRON=30 3 * * *` ma cztery:

```
export BACKUP_CRON=30 3 * * *
```

Powłoka czytała to jako „wyeksportuj `BACKUP_CRON`, a potem zmienne o nazwach
`3`, `*`, `*`, `*`" i przerywała na `export: 3: bad variable name`. Zadanie
crona wyglądało tak:

```
30 3 * * * . /etc/backup.env && /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1
```

Źródłowanie padało, `&&` zwierało, **`backup.sh` nigdy się nie uruchamiał**.

Dlaczego nikt tego nie zauważył:

1. **Zrzut startowy działał**, bo `entrypoint.sh` woła `backup.sh` wprost, ze
   środowiskiem kontenera — bez źródłowania tego pliku. Kopie w wolumenie
   powstawały przy każdym starcie kontenera, więc katalog nie był pusty.
2. **Błąd był niewidoczny.** Przekierowanie `>> /proc/1/fd/1` obejmowało tylko
   `backup.sh`, więc komunikat ze źródłowania szedł na stderr crond-a — a ten,
   uruchamiany bez `-L`, loguje do sysloga, czyli w kontenerze donikąd.

Trzy poprawki: wartości w apostrofach, klamry wokół całego polecenia crona
(`{ … } >> /proc/1/fd/1 2>&1`), oraz `crond -L /proc/1/fd/1`. Do tego
kontener **nie wstaje**, gdy `/etc/backup.env` nie da się źródłować — lepiej
głośna awaria niż backup, który tylko udaje, że działa.

## Zabezpieczenia w skrypcie

- **Zrzut mniejszy niż 1 KB przerywa proces** z kodem błędu — pusty plik
  nadpisujący dobrą kopię to najczęstszy sposób na utratę backupu.
  Próg zmienisz przez `BACKUP_MIN_BYTES`.
- **Rotacja usuwa dopiero po udanym zapisie** nowej kopii, nie przed.
- **Plik powyżej 50 MB nie jest wysyłany** (limit `sendDocument` dla botów) —
  zamiast tego przychodzi powiadomienie tekstowe, a kopia zostaje w wolumenie.
- **Nieudana wysyłka kończy się kodem błędu**, więc widać ją w `docker compose logs`.
- `pg_dump` ma `--clean --if-exists --no-owner`, więc odtworzenie działa
  na niepustej bazie i na innym użytkowniku niż oryginalny.

## Weryfikacja, że backup naprawdę działa

**Backup, którego nigdy nie przywracano, jest tylko przypuszczeniem.**

Jedno polecenie — odszyfrowanie, sprawdzenie sumy kontrolnej archiwum,
wgranie do bazy tymczasowej, porównanie liczby wierszy z produkcją
i posprzątanie po sobie:

```bash
docker compose exec -T backup /usr/local/bin/test-odtworzenia.sh
```

Konkretna kopia zamiast najnowszej:

```bash
docker compose exec -T backup /usr/local/bin/test-odtworzenia.sh /backups/courierdb-2026-08-16_1457.sql.gz.gpg
```

Skrypt **nie dotyka bazy produkcyjnej** — czyta z niej tylko liczby wierszy,
a wszystko odtwarza w bazie `restore_test`, kasowanej na końcu (także wtedy,
gdy coś padnie po drodze).

### Werdykt

- **Kopia mniejsza niż produkcja to norma** — powstała wcześniej, a od tego
  czasu doszły wpisy.
- **Pusta tabela, która na produkcji ma dane** → kod błędu. Zrzut nie objął
  wszystkiego.
- **Kopia większa niż produkcja** → ostrzeżenie. Backup jest sprawny, ale ktoś
  skasował dane z produkcji.
- **Tabela z `-`** → nie było jej jeszcze w chwili robienia kopii. Przy kopii
  sprzed migracji to normalne i wręcz przydatne: pokazuje, z którego momentu
  ona jest.

### ⚠️ Czego ten skrypt NIE sprawdza

**Czy hasło z menedżera haseł jest tym samym hasłem.** Domyślnie używa
`BACKUP_PASSPHRASE` z kontenera, a prawdziwe odtworzenie to scenariusz,
w którym serwera już nie ma i zostaje wyłącznie kopia hasła poza nim.
Żeby sprawdzić to naprawdę, podaj hasło ręcznie:

```bash
docker compose exec -T backup sh -c 'BACKUP_PASSPHRASE="wklej-z-menedzera" /usr/local/bin/test-odtworzenia.sh'
```

**Czy cotygodniowa wysyłka na Telegram działa** — to osobna ścieżka
(`backup.sh --send`) i osobny test.

> Skrypt jest w obrazie, więc po jego dodaniu albo zmianie trzeba przebudować
> kontener: `docker compose up -d --build backup`.
