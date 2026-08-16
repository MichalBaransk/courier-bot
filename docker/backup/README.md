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

Raz na jakiś czas warto odtworzyć kopię do bazy testowej — backup, którego
nigdy nie przywracano, jest tylko przypuszczeniem:

```bash
docker compose exec postgres createdb -U postgres restore_test
gunzip -c courierdb.sql.gz | docker compose exec -T postgres psql -U postgres -d restore_test
docker compose exec -T postgres psql -U postgres -d restore_test -c "
SELECT 'wallet_transactions' AS t, count(*) FROM wallet_transactions
UNION ALL SELECT 'daily_records', count(*) FROM daily_records;"
docker compose exec postgres dropdb -U postgres restore_test
```
