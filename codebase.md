# GlovoBot — kod źródłowy

Plików: 36 · linii: 6222

## Struktura

```
package.json
tsconfig.json
docker-compose.yml
Dockerfile
.env.example
src/bot/cards.ts
src/bot/index.ts
src/bot/keyboards.ts
src/config.ts
src/db/index.ts
src/db/schema.ts
src/index.ts
src/scripts/import-sheets.ts
src/scripts/make-codebase.mjs
src/server.ts
src/services/finance.calc.test.ts
src/services/finance.calc.ts
src/services/finance.service.ts
src/services/gemini.service.ts
src/services/maps.service.ts
src/services/user.service.ts
src/utils/datetime.test.ts
src/utils/datetime.ts
src/utils/format.ts
src/utils/rate-limiter.test.ts
src/utils/rate-limiter.ts
docker/backup/backup.sh
docker/backup/Dockerfile
docker/backup/entrypoint.sh
docker/backup/README.md
drizzle/0001_rework.sql
.dockerignore
.gitignore
drizzle.config.ts
vitest.config.ts
ZMIANY.md
```

# Plik: package.json
```json
{
  "name": "telegram-bot",
  "version": "1.1.0",
  "description": "GlovoBot - asystent kuriera (Telegram + Gemini + Postgres)",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:push": "drizzle-kit push",
    "db:generate": "drizzle-kit generate",
    "db:studio": "drizzle-kit studio",
    "import:sheets": "tsx src/scripts/import-sheets.ts"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "type": "module",
  "dependencies": {
    "@google/genai": "^2.17.1",
    "csv-parse": "^7.0.2",
    "dotenv": "^17.4.2",
    "drizzle-orm": "^0.45.2",
    "pg": "^8.23.0",
    "telegraf": "^4.16.3",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^26.2.0",
    "@types/pg": "^8.21.0",
    "drizzle-kit": "^0.31.10",
    "tsx": "^4.23.12",
    "typescript": "^7.0.2",
    "vitest": "^4.1.10"
  }
}
```

# Plik: tsconfig.json
```json
{
  // Visit https://aka.ms/tsconfig to read more about this file
  "compilerOptions": {
    // File Layout
    "rootDir": "src",
    "outDir": "dist",

    // Environment Settings
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2022",

    // FIX (1.1): bez tych dwoch linii TypeScript nie widzi globalnych typow Node
    // (process, Buffer, console, fs, path) i wywala blad na kazdym ich uzyciu.
    // "types": [] wylaczalo @types/node mimo ze pakiet jest w devDependencies.
    "lib": ["esnext"],
    "types": ["node"],

    // Other Outputs
    "sourceMap": true,
    "declaration": true,
    "declarationMap": true,

    // Stricter Typechecking Options
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,

    // Recommended Options
    "strict": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "noUncheckedSideEffectImports": true,
    "moduleDetection": "force",
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src/**/*", "scripts/make-codebase.mjs"],
  "exclude": ["node_modules", "dist"]
}
```

# Plik: docker-compose.yml
```yaml
# Compose v2 ignoruje `version:` i ostrzega o nim przy każdym poleceniu — usunięte.

services:
  postgres:
    image: postgres:16-alpine
    container_name: courier-db
    restart: always
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-postgrespassword}
      POSTGRES_DB: ${POSTGRES_DB:-courierdb}
    ports:
      # ZMIANA: nasłuch tylko na pętli lokalnej. Wcześniej "5432:5432" oznaczało
      # 0.0.0.0 — baza była widoczna z internetu, jeśli serwer ma publiczne IP.
      # Bot i studio łączą się przez sieć Dockera, więc nic na tym nie tracą.
      - "127.0.0.1:5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ${POSTGRES_USER:-postgres} -d ${POSTGRES_DB:-courierdb}']
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    logging: &logging
      driver: json-file
      options:
        max-size: '10m'
        max-file: '3'

  bot:
    build: .
    image: courier-bot:latest
    container_name: courier-bot
    restart: always
    depends_on:
      postgres:
        # ZMIANA: samo `depends_on` czeka tylko na START kontenera, nie na
        # gotowość bazy. Przy restarcie serwera bot potrafił wystartować
        # sekundę za wcześnie i przywitać się błędem połączenia.
        condition: service_healthy
    env_file:
      - .env
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgrespassword}@postgres:5432/${POSTGRES_DB:-courierdb}
    # Zaden port nie wychodzi na hosta — tunel Cloudflare siega bota
    # po wewnetrznej sieci Dockera, pod adresem http://bot:8080.
    healthcheck:
      test:
        [
          'CMD-SHELL',
          'test -z "$$WEBHOOK_DOMAIN" || wget -qO- http://127.0.0.1:${WEBHOOK_PORT:-8080}/healthz > /dev/null',
        ]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    logging: *logging

  # Tunel Cloudflare: bot.baranskiha.ovh -> http://bot:8080
  # Token bierzesz z panelu Cloudflare Zero Trust przy tworzeniu tunelu.
  # Uruchamia sie tylko z profilem `webhook`, wiec lokalnie nie przeszkadza.
  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: courier-tunnel
    restart: always
    command: tunnel --no-autoupdate run --token ${CLOUDFLARE_TUNNEL_TOKEN}
    depends_on:
      bot:
        condition: service_started
    profiles: ['webhook']
    logging: *logging

  studio:
    # ZMIANA: ten sam obraz co bot, zamiast drugiego `build: .`.
    # Wcześniej każde `docker compose build` budowało identyczny obraz dwa razy.
    image: courier-bot:latest
    container_name: courier-studio
    restart: always
    command: npx drizzle-kit studio --host 0.0.0.0 --port 4983
    ports:
      # UWAGA: Drizzle Studio nie ma żadnego logowania — kto trafi na ten port,
      # ma pełny dostęp do bazy. Zostawiam na pętli lokalnej; jeśli wystawiasz
      # go przez reverse proxy działający na hoście, nadal zadziała.
      - "127.0.0.1:4983:4983"
    depends_on:
      postgres:
        condition: service_healthy
      bot:
        condition: service_started
    env_file:
      - .env
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgrespassword}@postgres:5432/${POSTGRES_DB:-courierdb}
    logging: *logging

  backup:
    build: ./docker/backup
    container_name: courier-backup
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      POSTGRES_HOST: postgres
      POSTGRES_PORT: 5432
      POSTGRES_USER: ${POSTGRES_USER:-postgres}
      POSTGRES_DB: ${POSTGRES_DB:-courierdb}
      PGPASSWORD: ${POSTGRES_PASSWORD:-postgrespassword}
      BACKUP_CRON: '30 3 * * *' # codziennie 03:30 — zrzut lokalny
      BACKUP_SEND_CRON: '0 4 * * 0' # niedziela 04:00 — wysyłka na Telegram
      BACKUP_KEEP_DAYS: 14
      BACKUP_ON_START: 'true'
      BACKUP_PASSPHRASE: ${BACKUP_PASSPHRASE}
      BOT_TOKEN: ${BOT_TOKEN}
      BACKUP_CHAT_ID: ${BACKUP_CHAT_ID}
    volumes:
      - backups:/backups
    logging: *logging

volumes:
  pgdata:
  backups:
```

# Plik: Dockerfile
```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ENV NODE_ENV=production
CMD ["npx", "tsx", "src/index.ts"]
```

# Plik: .env.example
```ini
# Telegram
BOT_TOKEN=

# Lista telegram_id z dostępem do bota (przecinkami). Puste = bot otwarty dla wszystkich.
ALLOWED_TELEGRAM_IDS=5066453902

# Postgres
DATABASE_URL=postgres://user:pass@host:5432/glovobot
# DATABASE_SSL=true    # tylko gdy baza wymaga TLS, a URL nie ma sslmode=require

# Gemini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.7-flash

# Google Maps (opcjonalne - bez tego dystans bierze się z aplikacji Glovo)
GOOGLE_MAPS_API_KEY=

# Import CSV
IMPORT_TELEGRAM_ID=5066453902

# --- Kolejka zapytań (ochrona przed 429) ---
GEMINI_CONCURRENCY=1
GEMINI_MIN_INTERVAL_MS=1200
GEMINI_MAX_RETRIES=4
MAPS_CONCURRENCY=4
MAPS_MIN_INTERVAL_MS=100

# --- Backup bazy ---
POSTGRES_PASSWORD=
BACKUP_PASSPHRASE=długie-losowe-hasło-trzymane-POZA-serwerem
BACKUP_CHAT_ID=5066453902
```

# Plik: src/bot/cards.ts
```typescript
import { CFG } from '../config.js';
import { b, code, i, joinLines, km, progressBar, zl, zlSigned, SEPARATOR } from '../utils/format.js';
import type {
  CourseOfferStats,
  DailySummary,
  PeriodSummary,
  TargetProgress,
} from '../services/finance.service.js';

/**
 * Wszystkie karty renderuja HTML (3.3). Kazda wartosc pochodzaca od uzytkownika
 * albo od modelu przechodzi przez `h()`.
 */

/** `⛽ Paliwo: 312.40 zł (48.20 L, śr. 6.48 zł/L)` */
function fuelLine(cost: number, liters: number, pricePerLiter: number | null): string {
  const details = [
    liters > 0 ? `${liters.toFixed(2)} L` : null,
    pricePerLiter != null ? `śr. ${pricePerLiter.toFixed(2)} zł/L` : null,
  ].filter((part): part is string => part !== null);

  return `⛽ ${b('Paliwo:')} ${b(zl(cost))}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
}

export function dailyCard(summary: DailySummary): string {
  return joinLines([
    `📅 ${b('Raport dzienny:')} ${code(summary.date)}`,
    '',
    `💰 ${b('Brutto:')} ${b(zl(summary.grossEarnings))}`,
    `💵 ${b(`Netto ze zleceń (${(CFG.NETTO_FACTOR * 100).toFixed(1)}%):`)} ${b(zl(summary.netEarnings))}`,
    `🪙 ${b('Napiwki gotówka:')} ${b(zlSigned(summary.cashTipsTotal))}`,
    `🏁 ${b('Zarobek łącznie netto:')} ${b(zl(summary.totalNetto))}`,
    summary.walletPayouts > 0 && `🏧 ${b('Wypłacone z portfela:')} ${b(`-${summary.walletPayouts.toFixed(2)} zł`)}`,
    `💳 ${b('Do przelewu:')} ${b(zl(summary.doPrzelewu))} ${i('(bez gotówki w kieszeni)')}`,
    '',
    summary.workHours > 0
      ? `⏱️ ${b('Czas pracy:')} ${code(`${summary.workFrom ?? '--:--'} - ${summary.workTo ?? '--:--'}`)} (${b(`${summary.workHours.toFixed(2)} h`)}) — stawka ${b(`${summary.hourlyRateNetto.toFixed(2)} zł/h`)}`
      : `⏱️ ${b('Czas pracy:')} ${i('brak pełnego wpisu')}`,
    summary.distanceKm != null
      ? `🚗 ${b('Dystans dnia:')} ${b(km(summary.distanceKm))}`
      : `🚗 ${b('Dystans dnia:')} ${i('brak wpisu')}`,
    '',
    summary.fuelCost > 0
      ? fuelLine(summary.fuelCost, summary.fuelLiters, summary.fuelPricePerLiter) +
        (summary.fuelReceiptCount > 1 ? ` ${i(`— ${summary.fuelReceiptCount} paragony`)}` : '')
      : `⛽ ${b('Paliwo:')} ${i('brak wpisu')}`,
  ]);
}

export function periodCard(
  title: string,
  summary: PeriodSummary,
  target: TargetProgress | null
): string {
  return joinLines([
    `📊 ${b(`${title} (${summary.startDate} – ${summary.endDate}):`)}`,
    '',
    `💰 ${b('Brutto:')} ${b(zl(summary.totalGross))}`,
    `💵 ${b('Netto ze zleceń:')} ${b(zl(summary.totalNettoEarnings))}`,
    `🪙 ${b('Napiwki gotówkowe:')} ${b(zlSigned(summary.totalCashTips))}`,
    `🏁 ${b('Zarobek łącznie netto:')} ${b(zl(summary.grandTotalNetto))}`,
    summary.totalWalletPayouts > 0 &&
      `🏧 ${b('Wypłacone z portfela:')} ${b(`-${summary.totalWalletPayouts.toFixed(2)} zł`)}`,
    `💳 ${b('Do przelewu:')} ${b(zl(summary.totalDoPrzelewu))}`,
    '',
    `⏱️ ${b('Godziny:')} ${b(`${summary.totalWorkHours.toFixed(2)} h`)} (śr. ${b(`${summary.avgHourlyRateNetto.toFixed(2)} zł netto/h`)})`,
    summary.totalDistanceKm > 0 && `🚗 ${b('Dystans:')} ${b(km(summary.totalDistanceKm))}`,
    summary.totalFuelCost > 0 && fuelLine(summary.totalFuelCost, summary.totalFuelLiters, summary.avgPricePerLiter),
    ...(target
      ? [
          '',
          SEPARATOR,
          `🎯 ${b('Cel:')} ${progressBar(target.progressPercent)} ${b(`${target.progressPercent.toFixed(1)}%`)}`,
          target.isCompleted
            ? `🏆 ${b('Cel osiągnięty!')} Nadwyżka ${b(zlSigned(target.currentNetto - target.targetAmount))}`
            : `⏳ Brakuje ${b(zl(target.remainingNetto))} (${b(`${target.dailyRequiredNetto.toFixed(2)} zł/dzień`)})`,
        ]
      : []),
  ]);
}

export function targetCard(progress: TargetProgress): string {
  const header = progress.periodType === 'MONTHLY' ? '🎯 <b>Miesięczny cel zarobkowy</b>' : '🎯 <b>Tygodniowy cel zarobkowy</b>';
  const bar = `${progressBar(progress.progressPercent)} ${b(`${progress.progressPercent.toFixed(1)}%`)}`;

  if (progress.isCompleted) {
    return joinLines([
      header,
      bar,
      '',
      `🏆 ${b('CEL OSIĄGNIĘTY!')}`,
      `💰 ${b('Zarobione netto:')} ${b(zl(progress.currentNetto))} / ${b(zl(progress.targetAmount))}`,
      `📈 ${b('Nadwyżka:')} ${b(zlSigned(progress.currentNetto - progress.targetAmount))}`,
    ]);
  }

  return joinLines([
    header,
    bar,
    '',
    `💰 ${b('Postęp:')} ${b(zl(progress.currentNetto))} z ${b(zl(progress.targetAmount))} netto`,
    `⏳ ${b('Brakuje:')} ${b(zl(progress.remainingNetto))}`,
    `📅 ${b('Pozostało dni:')} ${b(progress.daysRemaining)}`,
    '',
    `📊 ${b('Wymagane tempo:')}`,
    ` • Dziennie: ${b(`${progress.dailyRequiredNetto.toFixed(2)} zł netto / dzień`)}`,
    ` • Czas pracy: ${b(`~${progress.estimatedHoursRemaining.toFixed(1)} h`)} (${progress.hoursPerDayRequired.toFixed(1)} h / dzień)`,
    progress.usedFallbackRate &&
      i(`Prognoza godzin liczona stawką zastępczą ${CFG.FALLBACK_HOURLY_RATE_NETTO.toFixed(2)} zł/h — brak własnej historii.`),
  ]);
}

export function startShiftCard(summary: DailySummary, balance: number, currentTime: string): string {
  return joinLines([
    `🚀 ${b('Rozpoczęcie zmiany')}`,
    `📅 ${b('Data:')} ${code(summary.date)}`,
    '',
    summary.workFrom
      ? `⏱️ ${b('Godzina wyjazdu:')} ${b(summary.workFrom)} ${i('(zapisano w bazie)')}`
      : `⏱️ ${b('Godzina wyjazdu:')} ${i(`nieustalona — teraz ${currentTime}`)}`,
    `💵 ${b('Portfel Glovo:')} ${b(zl(balance))}`,
    '',
    summary.workFrom ? i('Godzina wyjazdu jest zapisana.') : 'Wybierz godzinę startu poniżej:',
  ]);
}

export function endShiftCard(summary: DailySummary, balance: number, currentTime: string): string {
  return joinLines([
    `🏁 ${b('Zakończenie zmiany')}`,
    `📅 ${b('Data zmiany:')} ${code(summary.date)}`,
    '',
    `⏱️ ${b('Godziny pracy:')} ${code(`${summary.workFrom ?? '--:--'} - ${summary.workTo ?? '--:--'}`)} (${b(`${summary.workHours.toFixed(2)} h`)})`,
    `🚗 ${b('Dystans dnia:')} ${summary.distanceKm != null ? b(km(summary.distanceKm)) : i('brak')}`,
    `💰 ${b('Zarobek brutto:')} ${summary.grossEarnings > 0 ? b(zl(summary.grossEarnings)) : i('brak wpisu')}`,
    `💵 ${b('Zarobek łącznie netto:')} ${b(zl(summary.totalNetto))} (stawka ${b(`${summary.hourlyRateNetto.toFixed(2)} zł/h`)})`,
    `⛽ ${b('Paliwo dziś:')} ${
      summary.fuelCost > 0
        ? b(zl(summary.fuelCost)) + (summary.fuelReceiptCount > 1 ? ` ${i(`(${summary.fuelReceiptCount} paragony)`)}` : '')
        : i('brak wpisu')
    }`,
    `💼 ${b('Portfel Glovo:')} ${b(zl(balance))}`,
    '',
    summary.workTo ? i('Godzina zjazdu i rozliczenie są zapisane.') : i(`Ustaw godzinę zjazdu (teraz ${currentTime}) lub podaj dystans.`),
  ]);
}

export function offerStatsCard(stats: CourseOfferStats): string {
  const rate = (v: number | null) => (v == null ? i('brak') : b(`${v.toFixed(2)} zł/km`));

  return joinLines([
    `📊 ${b(`Statystyki ofert Glovo (${stats.date}):`)}`,
    '',
    `• ${b('Sprawdzonych zleceń:')} ${b(stats.totalOffers)}`,
    `• ✅ ${b(`Opłacalne (≥${CFG.MIN_STAWKA_NETTO_KM.toFixed(2)} zł/km):`)} ${b(stats.profitable)}`,
    `• ❌ ${b('Nieopłacalne:')} ${b(stats.unprofitable)}`,
    '',
    `📌 ${b('Decyzje kuriera:')}`,
    ` • 🟢 Zaakceptowane: ${b(stats.accepted)}`,
    ` • 🔴 Odrzucone: ${b(stats.rejected)}`,
    ` • ⚪ Bez decyzji: ${b(stats.pending)}`,
    '',
    // FIX (5.4): dwie metryki obok siebie, bo mowia o czym innym.
    `📈 ${b('Średnia z ofert:')} ${rate(stats.avgNetRatePerKm)} ${i('— jakie oferty przychodzą')}`,
    `⚖️ ${b('Średnia ważona:')} ${rate(stats.weightedNetRatePerKm)} ${i('— ile realnie wychodzi na km')}`,
    `🥇 ${b('Najlepsza:')} ${rate(stats.bestNetRate)}  |  🥉 ${b('Najgorsza:')} ${rate(stats.worstNetRate)}`,
    '',
    `🛣️ ${b('Łączny dystans ofert:')} ${b(km(stats.totalDistanceKm))}`,
    `💰 ${b('Suma stawek brutto:')} ${b(zl(stats.totalGross))}`,
  ]);
}

export interface OfferCardData {
  isProfitable: boolean;
  grossAmount: number;
  netAmount: number;
  pickupAddress: string;
  deliveryAddress: string;
  /** Dystans deklarowany przez aplikacje Glovo. */
  appPickupKm: number | null;
  appDeliveryKm: number | null;
  appTotalKm: number | null;
  /** Niezalezna kontrola Google Maps. */
  mapsPickupKm: number | null;
  mapsDeliveryKm: number | null;
  mapsTotalKm: number | null;
  mapsReason: string | null;
  mapsDeliveryReason: string | null;
  mapsAgeMin: number;
  /** Dystans uzyty do stawki i jego zrodlo. */
  totalKm: number;
  rateBasis: 'APP' | 'MAPS' | 'NONE';
  netRatePerKm: number;
  status?: 'PENDING' | 'ACCEPTED' | 'REJECTED';
}

const STATUS_LINE: Record<'PENDING' | 'ACCEPTED' | 'REJECTED', string> = {
  PENDING: `🔘 <b>Status:</b> <i>oczekuje na decyzję</i>`,
  ACCEPTED: `🟢 <b>Status: ZAAKCEPTOWANO</b>`,
  REJECTED: `🔴 <b>Status: ODRZUCONO</b>`,
};

/**
 * FIX (3.6): karta oferty jest renderowana od zera przy kazdej zmianie statusu.
 * Stary kod probowal doklejac linie statusu filtrujac tekst po `'🔘 Status:'`,
 * co nigdy nie trafialo (faktyczna linia miala gwiazdki: `🔘 *Status:*`),
 * wiec karta konczyla z dwiema liniami statusu.
 */
const leg = (value: number | null, note?: string | null): string =>
  value != null ? b(km(value, 2)) : i(note ?? 'brak');

/**
 * Karta oferty z ROZDZIELONYMI zrodlami dystansu.
 *
 * Aplikacja Glovo podaje oba odcinki i liczy je od biezacej pozycji kuriera —
 * to jest podstawa stawki. Google Maps sluzy wylacznie za kontrole dojazdu;
 * odcinka do klienta zwykle nie policzy, bo oferta nie ujawnia jego adresu.
 */
export function offerCard(data: OfferCardData): string {
  const status = data.status ?? 'PENDING';

  // Rozbieznosc dojazdu ma sens tylko gdy sa obie liczby.
  const pickupDelta =
    data.appPickupKm != null && data.mapsPickupKm != null ? data.mapsPickupKm - data.appPickupKm : null;
  const divergent = pickupDelta != null && Math.abs(pickupDelta) >= CFG.DISTANCE_DIVERGENCE_KM;

  const basisLabel: Record<OfferCardData['rateBasis'], string> = {
    APP: 'z aplikacji Glovo',
    MAPS: 'z Google Maps',
    NONE: 'brak danych o dystansie',
  };

  return joinLines([
    data.isProfitable ? b('✅ KURS OPŁACALNY') : b('❌ KURS SŁABY / ODRZUĆ'),
    '',
    `💵 ${b('Stawka:')} ${b(`${data.grossAmount.toFixed(2)} zł brutto`)} ➔ ${b(`${data.netAmount.toFixed(2)} zł netto`)}`,
    `📍 ${b('Odbiór:')} ${code(data.pickupAddress)}`,
    `🏠 ${b('Dostawa:')} ${code(data.deliveryAddress)}`,
    '',
    `📱 ${b('Dystans z aplikacji Glovo:')}`,
    ` • Odbiór: ${leg(data.appPickupKm)}`,
    ` • Dostawa: ${leg(data.appDeliveryKm)}`,
    ` • ${b('Suma:')} ${leg(data.appTotalKm)}`,
    '',
    `🗺️ ${b('Kontrola Google Maps:')}`,
    data.mapsReason
      ? ` • ${i(data.mapsReason)}`
      : joinLines([
          ` • Odbiór: ${leg(data.mapsPickupKm)}` +
            (pickupDelta != null ? ` ${i(`(${pickupDelta > 0 ? '+' : ''}${pickupDelta.toFixed(2)} km)`)}` : ''),
          ` • Dostawa: ${leg(data.mapsDeliveryKm, data.mapsDeliveryReason)}`,
          data.mapsTotalKm != null ? ` • ${b('Suma:')} ${b(km(data.mapsTotalKm, 2))}` : '',
          data.mapsAgeMin > 0 ? ` • ${i(`pozycja GPS sprzed ${data.mapsAgeMin} min`)}` : '',
        ]),
    divergent &&
      ` ⚠️ ${i('Duża różnica na dojeździe — sprawdź, czy GPS jest aktualny (/lokalizacja).')}`,
    '',
    `📊 ${b('Stawka netto/km:')} ${b(`${data.netRatePerKm.toFixed(2)} zł/km`)} (min. ${CFG.MIN_STAWKA_NETTO_KM.toFixed(2)} zł)`,
    ` ${i(`liczona z ${data.totalKm.toFixed(2)} km — ${basisLabel[data.rateBasis]}`)}`,
    '',
    STATUS_LINE[status],
  ]);
}

export function helpCard(): string {
  return joinLines([
    `🤖 ${b('GlovoBot – Asystent Kuriera')}`,
    '',
    `🛵 ${b('Obsługa zmiany:')}`,
    ` • ${code('/wyjazd')} – start zmiany i zapis godziny.`,
    ` • ${code('/wyjazd 16:00 120')} – wyjazd z parametrami (godzina, stan portfela).`,
    ` • ${code('/koniec')} – zjazd i rozliczenie.`,
    ` • ${code('/koniec 23:15 54km 180')} – szybki zjazd (godzina, dystans, stan portfela).`,
    ` • ${code('/anuluj')} – przerwij oczekiwanie na wpis.`,
    '',
    `💰 ${b('Zarobek i koszty:')}`,
    ` • ${code('/brutto 438.60')} – zarobek brutto z aplikacji Glovo.`,
    ` • ${code('/paliwo 312.40 48.2')} – paragon: kwota, litry (opcjonalnie cena/L i data).`,
    ` • ${code('n 5.50')} – szybki napiwek gotówkowy.`,
    '',
    `📍 ${b('Lokalizacja:')}`,
    ` • ${code('/lokalizacja')} – wyślij GPS do weryfikacji tras (ważny 30 min).`,
    '',
    `🎯 ${b('Cele zarobkowe:')}`,
    ` • ${code('/cel 4500')} – cel miesięczny netto.`,
    ` • ${code('/cel tydzien 1200')} – cel tygodniowy netto.`,
    ` • ${code('/cele')} – postęp i wymagane tempo.`,
    '',
    `📊 ${b('Raporty i historia:')}`,
    ` • ${code('/dzis')} – podsumowanie dzisiejszej zmiany.`,
    ` • ${code('/dzien 2026-08-15')} – podsumowanie wybranego dnia.`,
    ` • ${code('/tydzien')} / ${code('/ptydzien')} – bieżący / poprzedni tydzień.`,
    ` • ${code('/miesiac')} – podsumowanie miesiąca.`,
    ` • ${code('/statystyki')} – statystyki ofert kursów.`,
    ` • ${code('/saldo')} – stan portfela Glovo (suma transakcji).`,
    '',
    `🎙️ ${b('Głos:')} tankowanie, dystans, godziny, zarobki, napiwki.`,
    `📸 ${b('Zdjęcia:')} zrzuty Portfela, paragony paliwowe, oferty zleceń — rozpoznaję automatycznie.`,
  ]);
}
```

# Plik: src/bot/index.ts
```typescript
import type { Context, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { CFG, isAllowedUser } from '../config.js';
import { financeService } from '../services/finance.service.js';
import { computeOfferRate } from '../services/finance.calc.js';
import { geminiService, geminiQueue } from '../services/gemini.service.js';
import { verifyOfferDistance } from '../services/maps.service.js';
import { ensureUser } from '../services/user.service.js';
import { isValidDateStr, monthRange, normalizeTime, nowTimeWarsaw, splitDate } from '../utils/datetime.js';
import { b, code, h, i, joinLines, zl, zlSigned, SEPARATOR } from '../utils/format.js';
import type { WalletTransactionItem } from '../services/gemini.service.js';
import {
  cancelInputKeyboard,
  endShiftKeyboard,
  locationRequestKeyboard,
  mainMenuKeyboard,
  offerDecisionKeyboard,
  offerDoneKeyboard,
  removeKeyboard,
  startShiftKeyboard,
  walletImportKeyboard,
} from './keyboards.js';
import {
  dailyCard,
  endShiftCard,
  helpCard,
  offerCard,
  offerStatsCard,
  periodCard,
  startShiftCard,
  targetCard,
} from './cards.js';

const HTML = { parse_mode: 'HTML' as const };

// --- Stan ulotny -------------------------------------------------------------

interface CourierLocation {
  latitude: number;
  longitude: number;
  updatedAt: number;
}

type AwaitedInput =
  | 'START_CUSTOM_TIME'
  | 'START_WALLET_BALANCE'
  | 'END_CUSTOM_TIME'
  | 'END_DISTANCE'
  | 'END_GROSS'
  | 'END_WALLET_BALANCE'
  | 'FUEL_MANUAL';

interface PendingInput {
  kind: AwaitedInput;
  expiresAt: number;
}

interface PendingWalletImport {
  transactions: WalletTransactionItem[];
  expiresAt: number;
}

const lastCourierLocation = new Map<string, CourierLocation>();
const awaitingInput = new Map<string, PendingInput>();
const pendingWalletImports = new Map<string, PendingWalletImport>();

/**
 * FIX (3.2): mapy nigdy nie byly sprzatane z wygaslych wpisow.
 * Przy dlugo dzialajacym procesie to powolny wyciek pamieci.
 *
 * UWAGA: to dalej stan w pamieci procesu — restart go kasuje. Przy jednym
 * uzytkowniku jest to akceptowalne; przy wiekszej skali te trzy mapy powinny
 * trafic do Postgresa albo Redisa.
 */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of awaitingInput) if (value.expiresAt <= now) awaitingInput.delete(key);
  for (const [key, value] of pendingWalletImports) if (value.expiresAt <= now) pendingWalletImports.delete(key);
  for (const [key, value] of lastCourierLocation) {
    if (now - value.updatedAt > CFG.LOCATION_MAX_AGE_MS) lastCourierLocation.delete(key);
  }
}, 60_000);
sweeper.unref();

function setAwaiting(tId: string, kind: AwaitedInput): void {
  awaitingInput.set(tId, { kind, expiresAt: Date.now() + CFG.AWAITING_INPUT_TTL_MS });
}

function takeAwaiting(tId: string): AwaitedInput | null {
  const pending = awaitingInput.get(tId);
  if (!pending) return null;
  if (pending.expiresAt <= Date.now()) {
    awaitingInput.delete(tId);
    return null;
  }
  return pending.kind;
}

function freshLocation(tId: string): CourierLocation | null {
  const loc = lastCourierLocation.get(tId);
  if (!loc) return null;
  return Date.now() - loc.updatedAt <= CFG.LOCATION_MAX_AGE_MS ? loc : null;
}

// --- Pomocnicze --------------------------------------------------------------

function parseAmount(raw: string): number | null {
  const cleaned = raw.trim().replace(',', '.').replace(/z[łl]/gi, '').replace(/\s/g, '');
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** `numeric` z Postgresa przychodzi jako string albo null. */
function dec(value: string | null): number | null {
  return value != null ? parseFloat(value) : null;
}

function parseDistance(raw: string): number | null {
  const cleaned = raw.trim().replace(',', '.').replace(/km/gi, '');
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) && value >= 0 && value < 2000 ? value : null;
}

interface FuelInput {
  date: string | null;
  totalCost: number;
  liters: number | null;
  pricePerLiter: number | null;
}

/**
 * Reczny wpis paragonu paliwowego z jednej linii.
 *
 * Akceptuje kolejno: kwota [litry] [cena/L], z opcjonalna data YYYY-MM-DD
 * w dowolnym miejscu. Przecinki dziesietne i jednostki sa ignorowane, wiec
 * "312,40 zl 48,2 L" znaczy to samo co "312.40 48.2".
 */
export function parseFuelInput(raw: string): FuelInput | string {
  let text = raw.trim();

  let date: string | null = null;
  const dateMatch = text.match(/\d{4}-\d{2}-\d{2}/);
  if (dateMatch) {
    if (!isValidDateStr(dateMatch[0])) return 'Nieprawidłowa data — użyj formatu RRRR-MM-DD.';
    date = dateMatch[0];
    text = text.replace(dateMatch[0], ' ');
  }

  const numbers = (text.replace(/,/g, '.').match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const [cost, liters, price] = numbers;

  if (cost == null || !(cost > 0)) return 'Nie znalazłem kwoty. Podaj np. `312.40` albo `312.40 48.2`.';
  if (cost > 5000) return `Kwota ${cost.toFixed(2)} zł wygląda na pomyłkę — sprawdź paragon.`;

  return {
    date,
    totalCost: cost,
    liters: liters != null && liters > 0 && liters <= 500 ? liters : null,
    pricePerLiter: price != null && price > 0 && price <= 50 ? price : null,
  };
}

/**
 * FIX (3.9): `CFG.MAX_*_BYTES` byly zadeklarowane i nigdy nieuzywane.
 * Plik byl pobierany w calosci do pamieci i kodowany base64 (+33%),
 * bez limitu i bez timeoutu.
 */
async function downloadTelegramFile(
  getLink: () => Promise<URL>,
  fileSize: number | undefined,
  maxBytes: number,
  label: string
): Promise<Buffer> {
  if (fileSize != null && fileSize > maxBytes) {
    throw new Error(
      `${label} ma ${(fileSize / 1024 / 1024).toFixed(1)} MB — limit to ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`
    );
  }

  const link = await getLink();
  const res = await fetch(link.href, { signal: AbortSignal.timeout(CFG.DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Nie udało się pobrać pliku z Telegrama (HTTP ${res.status}).`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`${label} przekracza limit ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`);
  }
  return buffer;
}

function fuelPromptText(): string {
  return joinLines([
    `⛽ ${b('Wpisz dane z paragonu w jednej linii:')}`,
    ` • sama kwota: ${code('312.40')}`,
    ` • kwota i litry: ${code('312.40 48.2')}`,
    ` • kwota, litry, cena/L: ${code('312.40 48.2 6.48')}`,
    '',
    i('Cenę za litr policzę sam, jeśli jej nie podasz. Możesz dopisać datę RRRR-MM-DD.'),
    i('Możesz też po prostu wysłać zdjęcie paragonu — odczytam je automatycznie.'),
  ]);
}

/** Wspolne potwierdzenie zapisu paliwa — dla wpisu recznego i dla OCR-a. */
async function fuelSavedText(tId: string, date: string, data: FuelInput): Promise<string> {
  const summary = await financeService.getDailySummary(tId, date);
  const computedPrice =
    data.pricePerLiter ?? (data.liters && data.liters > 0 ? data.totalCost / data.liters : null);

  return joinLines([
    `⛽ ${b('Zapisano tankowanie')}`,
    `📅 ${b('Data:')} ${code(date)}`,
    `💰 ${b('Kwota:')} ${b(zl(data.totalCost))}`,
    data.liters != null && `🛢️ ${b('Litry:')} ${b(`${data.liters.toFixed(2)} L`)}`,
    computedPrice != null &&
      `🏷️ ${b('Cena za litr:')} ${b(`${computedPrice.toFixed(2)} zł/L`)}` +
        (data.pricePerLiter == null ? ` ${i('(wyliczona)')}` : ''),
    summary.fuelReceiptCount > 1 &&
      `\n📊 ${i(`Tego dnia masz już ${summary.fuelReceiptCount} paragony — razem ${zl(summary.fuelCost)}.`)}`,
  ]);
}

async function shiftCardPayload(tId: string, date: string, mode: 'START' | 'END') {
  const [summary, wallet] = await Promise.all([
    financeService.getDailySummary(tId, date),
    financeService.getWalletBalance(tId),
  ]);
  const now = nowTimeWarsaw();

  return mode === 'START'
    ? { text: startShiftCard(summary, wallet.balance, now), keyboard: startShiftKeyboard(now, Boolean(summary.workFrom)) }
    : { text: endShiftCard(summary, wallet.balance, now), keyboard: endShiftKeyboard(now, Boolean(summary.workTo)) };
}

// --- Rejestracja handlerow ---------------------------------------------------

export function registerBotHandlers(bot: Telegraf): void {
  /**
   * FIX (3.8): wczesniej kazdy, kto znalazl bota, mogl wysylac zdjecia i glosowki,
   * palic limit Gemini i zapisywac smieci do bazy.
   * FIX (4.2): przy okazji upsert do tabeli `users`.
   */
  bot.use(async (ctx, next) => {
    if (!ctx.from) return;
    if (!isAllowedUser(ctx.from.id)) {
      console.warn(`[Auth] odrzucono telegram_id=${ctx.from.id} (@${ctx.from.username ?? '-'})`);
      return;
    }
    await ensureUser({
      id: ctx.from.id,
      username: ctx.from.username,
      first_name: ctx.from.first_name,
    });
    return next();
  });

  /**
   * FIX (3.1): komenda zawsze przerywa oczekiwanie na wpis.
   *
   * Poprzednio `bot.on(message('text'))` byl zarejestrowany PRZED komendami
   * `/dzis`, `/saldo`, `/cel` itd. Gdy `awaitingInput` bylo ustawione, wpisanie
   * `/dzis` dostawalo odpowiedz "Podaj liczbe kilometrow" i nigdy nie wolalo
   * `next()`. Uzytkownik zostawal uwieziony bez mozliwosci wyjscia.
   */
  bot.use(async (ctx, next) => {
    const msg = ctx.message;
    if (ctx.from && msg && 'text' in msg && msg.text.startsWith('/')) {
      awaitingInput.delete(String(ctx.from.id));
    }
    return next();
  });

  // === 1. Pomoc i menu =======================================================

  bot.command(['start', 'pomoc', 'help', 'menu'], async (ctx) => {
    await ctx.reply(helpCard(), { ...HTML, ...mainMenuKeyboard() });
  });

  /**
   * Diagnostyka dostarczania update'ow. Bez tego jedyne, co widac przy
   * zepsutym webhooku, to cisza — Telegram nie ma jak zglosic bledu botowi,
   * bo wlasnie do niego nie potrafi sie dobic.
   */
  bot.command('webhook', async (ctx) => {
    const info = await ctx.telegram.getWebhookInfo();

    await ctx.reply(
      joinLines([
        `🌐 ${b('Stan dostarczania')}`,
        '',
        info.url
          ? `${b('Tryb:')} webhook\n${b('Adres:')} ${code(info.url.replace(/\/tg\/[a-f0-9]+$/, '/tg/…'))}`
          : `${b('Tryb:')} long polling ${i('(webhook nieustawiony)')}`,
        `${b('Oczekujące update’y:')} ${info.pending_update_count}`,
        info.max_connections != null && `${b('Limit połączeń:')} ${info.max_connections}`,
        info.ip_address && `${b('IP Telegrama:')} ${code(info.ip_address)}`,
        info.has_custom_certificate ? `${b('Certyfikat:')} własny` : null,
        '',
        info.last_error_message
          ? joinLines([
              `⚠️ ${b('Ostatni błąd dostarczenia:')}`,
              code(info.last_error_message),
              info.last_error_date != null &&
                i(new Date(info.last_error_date * 1000).toLocaleString('pl-PL', { timeZone: CFG.TZ })),
            ])
          : `✅ ${i('Brak błędów dostarczania.')}`,
        info.last_synchronization_error_date != null &&
          i(
            `Ostatni problem z synchronizacją: ${new Date(
              info.last_synchronization_error_date * 1000
            ).toLocaleString('pl-PL', { timeZone: CFG.TZ })}`
          ),
      ]),
      HTML
    );
  });

  bot.command('anuluj', async (ctx) => {
    const had = awaitingInput.delete(String(ctx.from.id));
    pendingWalletImports.delete(String(ctx.from.id));
    await ctx.reply(had ? '✖️ Anulowano oczekiwanie na wpis.' : 'ℹ️ Nic nie oczekiwało na wpis.');
  });

  // === 2. Start zmiany =======================================================

  bot.command(['wyjazd', 'startzmiana', 'poczatek', 'start_zmiana'], async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/).slice(1);
    const date = financeService.getEffectiveDate();
    const tId = String(ctx.from.id);

    if (parts.length > 0) {
      let workFrom = nowTimeWarsaw();
      let walletBalance: number | null = null;

      for (const part of parts) {
        const time = normalizeTime(part);
        if (time) {
          workFrom = time;
          continue;
        }
        const amount = parseAmount(part);
        if (amount != null) walletBalance = amount;
      }

      const { hoursError } = await financeService.setShiftStart(tId, date, workFrom);

      let walletLine: string | null = null;
      if (walletBalance != null) {
        const { delta, balance } = await financeService.adjustWalletBalance(tId, date, walletBalance);
        walletLine = `💼 ${b('Portfel wyrównany do:')} ${b(zl(balance))} ${i(`(korekta ${zlSigned(delta)})`)}`;
      }

      await ctx.reply(
        joinLines([
          `🚀 ${b('Zmiana rozpoczęta!')}`,
          `📅 ${b('Data:')} ${code(date)}`,
          `⏱️ ${b('Godzina wyjazdu:')} ${b(workFrom)}`,
          walletLine,
          hoursError && `⚠️ ${i(hoursError)}`,
        ]),
        {
          ...HTML,
          ...(freshLocation(tId) ? removeKeyboard() : locationRequestKeyboard()),
        }
      );
      return;
    }

    const { text, keyboard } = await shiftCardPayload(tId, date, 'START');
    await ctx.reply(text, { ...HTML, ...keyboard });
  });

  bot.action('btn_quick_start_shift', async (ctx) => {
    await ctx.answerCbQuery();
    const { text, keyboard } = await shiftCardPayload(
      String(ctx.from.id),
      financeService.getEffectiveDate(),
      'START'
    );
    await ctx.reply(text, { ...HTML, ...keyboard });
  });

  bot.action(/^startshift_(start_now|custom_time|set_cash)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const action = ctx.match[1];
    const tId = String(ctx.from.id);
    const date = financeService.getEffectiveDate();

    if (action === 'start_now') {
      const { hoursError } = await financeService.setShiftStart(tId, date, nowTimeWarsaw());
      const { text, keyboard } = await shiftCardPayload(tId, date, 'START');
      await ctx.editMessageText(hoursError ? `${text}\n\n⚠️ ${i(hoursError)}` : text, { ...HTML, ...keyboard });
      return;
    }

    if (action === 'custom_time') {
      setAwaiting(tId, 'START_CUSTOM_TIME');
      await ctx.reply(`⏱️ ${b('Wpisz godzinę wyjazdu')} w formacie ${code('GG:MM')} (np. ${code('19:30')}):`, {
        ...HTML,
        ...cancelInputKeyboard(),
      });
      return;
    }

    setAwaiting(tId, 'START_WALLET_BALANCE');
    await ctx.reply(
      `💵 ${b('Wpisz stan portfela Glovo przed wyjazdem')} (np. ${code('150.00')}).\n${i('Różnica zapisze się jako korekta.')}`,
      { ...HTML, ...cancelInputKeyboard() }
    );
  });

  // === 3. Koniec zmiany ======================================================

  bot.command(['koniec', 'zjazd'], async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/).slice(1);
    const date = financeService.getEffectiveDate();
    const tId = String(ctx.from.id);

    if (parts.length > 0) {
      let workTo: string | null = null;
      let distanceKm: number | null = null;
      let walletBalance: number | null = null;

      for (const part of parts) {
        const time = normalizeTime(part);
        if (time) {
          workTo = time;
          continue;
        }
        if (/km$/i.test(part)) {
          distanceKm = parseDistance(part);
          continue;
        }
        // Pierwsza "goła" liczba to dystans, druga to stan portfela.
        const value = parseAmount(part);
        if (value == null) continue;
        if (distanceKm === null) distanceKm = value;
        else walletBalance = value;
      }

      const { summary, hoursError } = await financeService.setShiftEnd(tId, date, { workTo, distanceKm });

      let walletLine: string | null = null;
      if (walletBalance != null) {
        const { delta, balance } = await financeService.adjustWalletBalance(tId, date, walletBalance);
        walletLine = `💼 ${b('Portfel wyrównany do:')} ${b(zl(balance))} ${i(`(korekta ${zlSigned(delta)})`)}`;
      }

      await ctx.reply(
        joinLines([
          `🏁 ${b('Zmiana zamknięta!')}`,
          '',
          `📅 ${b('Data:')} ${code(summary.date)}`,
          summary.workFrom &&
            summary.workTo &&
            `⏱️ ${b('Godziny:')} ${code(`${summary.workFrom} - ${summary.workTo}`)} (${b(`${summary.workHours.toFixed(2)} h`)})`,
          summary.distanceKm != null && `🚗 ${b('Dystans dnia:')} ${b(`${summary.distanceKm.toFixed(1)} km`)}`,
          `💰 ${b('Zarobek brutto:')} ${b(zl(summary.grossEarnings))}`,
          `💵 ${b('Zarobek łącznie netto:')} ${b(zl(summary.totalNetto))} (stawka ${b(`${summary.hourlyRateNetto.toFixed(2)} zł/h`)})`,
          `🪙 ${b('Napiwki gotówka:')} ${b(zlSigned(summary.cashTipsTotal))}`,
          summary.walletPayouts > 0 && `🏧 ${b('Wypłacone z portfela:')} ${b(`-${summary.walletPayouts.toFixed(2)} zł`)}`,
          `💳 ${b('Do przelewu:')} ${b(zl(summary.doPrzelewu))}`,
          walletLine,
          hoursError && `⚠️ ${i(hoursError)}`,
        ]),
        HTML
      );
      return;
    }

    const { text, keyboard } = await shiftCardPayload(tId, date, 'END');
    await ctx.reply(text, { ...HTML, ...keyboard });
  });

  bot.action('btn_quick_end_shift', async (ctx) => {
    await ctx.answerCbQuery();
    const { text, keyboard } = await shiftCardPayload(String(ctx.from.id), financeService.getEffectiveDate(), 'END');
    await ctx.reply(text, { ...HTML, ...keyboard });
  });

  bot.action(/^endshift_(set_now|custom_time|set_dist|set_gross|add_fuel|set_cash)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const action = ctx.match[1];
    const tId = String(ctx.from.id);
    const date = financeService.getEffectiveDate();

    if (action === 'set_now') {
      const { hoursError } = await financeService.setShiftEnd(tId, date, { workTo: nowTimeWarsaw() });
      const { text, keyboard } = await shiftCardPayload(tId, date, 'END');
      await ctx.editMessageText(hoursError ? `${text}\n\n⚠️ ${i(hoursError)}` : text, { ...HTML, ...keyboard });
      return;
    }

    if (action === 'custom_time') {
      setAwaiting(tId, 'END_CUSTOM_TIME');
      await ctx.reply(`⏱️ ${b('Wpisz godzinę zjazdu')} w formacie ${code('GG:MM')} (np. ${code('23:30')}):`, {
        ...HTML,
        ...cancelInputKeyboard(),
      });
      return;
    }

    if (action === 'set_dist') {
      setAwaiting(tId, 'END_DISTANCE');
      await ctx.reply(
        `🚗 ${b('Wpisz dystans PRZEJECHANY dzisiaj')} w km (np. ${code('48')}).\n${i('To nie jest stan licznika pojazdu.')}`,
        { ...HTML, ...cancelInputKeyboard() }
      );
      return;
    }

    if (action === 'set_gross') {
      setAwaiting(tId, 'END_GROSS');
      await ctx.reply(
        joinLines([
          `💰 ${b('Wpisz zarobek BRUTTO z aplikacji Glovo')} (np. ${code('438.60')}).`,
          i(`Netto policzy się samo: ${(CFG.NETTO_FACTOR * 100).toFixed(1)}% kwoty brutto.`),
        ]),
        { ...HTML, ...cancelInputKeyboard() }
      );
      return;
    }

    if (action === 'add_fuel') {
      setAwaiting(tId, 'FUEL_MANUAL');
      await ctx.reply(fuelPromptText(), { ...HTML, ...cancelInputKeyboard() });
      return;
    }

    setAwaiting(tId, 'END_WALLET_BALANCE');
    await ctx.reply(
      `💵 ${b('Wpisz aktualny stan portfela z aplikacji Glovo')} (np. ${code('142.50')}).\n${i('Różnica zapisze się jako korekta.')}`,
      { ...HTML, ...cancelInputKeyboard() }
    );
  });

  bot.action('input_cancel', async (ctx) => {
    await ctx.answerCbQuery('Anulowano.');
    awaitingInput.delete(String(ctx.from.id));
    await ctx.editMessageText('✖️ Anulowano oczekiwanie na wpis.');
  });

  // === 3b. Zarobek brutto i paliwo — komendy skrótowe ========================

  bot.command(['brutto', 'zarobek'], async (ctx) => {
    const param = ctx.message.text.trim().split(/\s+/)[1];
    const tId = String(ctx.from.id);
    const date = financeService.getEffectiveDate();

    if (!param) {
      setAwaiting(tId, 'END_GROSS');
      await ctx.reply(`💰 ${b('Wpisz zarobek brutto')} (np. ${code('438.60')}):`, {
        ...HTML,
        ...cancelInputKeyboard(),
      });
      return;
    }

    const value = parseAmount(param);
    if (value == null || value < 0) {
      await ctx.reply(`❌ Nieprawidłowa kwota. Użyj np. ${code('/brutto 438.60')}.`, HTML);
      return;
    }

    await financeService.setGrossEarnings(tId, date, value);
    const summary = await financeService.getDailySummary(tId, date);
    await ctx.reply(
      joinLines([
        `✅ ${b('Zarobek brutto zapisany:')} ${b(zl(value))}`,
        `💵 ${b('Netto ze zleceń:')} ${b(zl(summary.netEarnings))}`,
        `🏁 ${b('Netto łącznie:')} ${b(zl(summary.totalNetto))}`,
      ]),
      HTML
    );
  });

  bot.command(['paliwo', 'tankowanie'], async (ctx) => {
    const rest = ctx.message.text.trim().split(/\s+/).slice(1).join(' ');
    const tId = String(ctx.from.id);

    if (!rest) {
      setAwaiting(tId, 'FUEL_MANUAL');
      await ctx.reply(fuelPromptText(), { ...HTML, ...cancelInputKeyboard() });
      return;
    }

    const parsed = parseFuelInput(rest);
    if (typeof parsed === 'string') {
      await ctx.reply(`❌ ${h(parsed)}`, HTML);
      return;
    }

    const fuelDate = parsed.date ?? financeService.getEffectiveDate();
    await financeService.saveFuelReceipt(tId, fuelDate, {
      totalCost: parsed.totalCost,
      liters: parsed.liters,
      pricePerLiter: parsed.pricePerLiter,
    });
    await ctx.reply(await fuelSavedText(tId, fuelDate, parsed), HTML);
  });

  // === 4. Lokalizacja ========================================================

  bot.command('lokalizacja', async (ctx) => {
    await ctx.reply(
      `📍 ${b('Kliknij przycisk poniżej')}, aby udostępnić lokalizację GPS. Będzie używana do weryfikacji tras ofert Glovo przez 30 minut.`,
      { ...HTML, ...locationRequestKeyboard() }
    );
  });

  bot.on(message('location'), async (ctx) => {
    const { latitude, longitude } = ctx.message.location;
    lastCourierLocation.set(String(ctx.from.id), { latitude, longitude, updatedAt: Date.now() });
    await ctx.reply('✅ Pozycja GPS zapisana. Weryfikacja tras Glovo aktywna na 30 minut.', removeKeyboard());
  });

  // === 5. Raporty ============================================================

  bot.command(['dzis', 'dzien'], async (ctx) => {
    const param = ctx.message.text.trim().split(/\s+/)[1];
    const date = isValidDateStr(param) ? param : financeService.getEffectiveDate();
    const summary = await financeService.getDailySummary(ctx.from.id, date);
    await ctx.reply(dailyCard(summary), HTML);
  });

  bot.action('btn_quick_today', async (ctx) => {
    await ctx.answerCbQuery();
    const summary = await financeService.getDailySummary(ctx.from.id, financeService.getEffectiveDate());
    await ctx.reply(dailyCard(summary), HTML);
  });

  bot.command(['tydzien', 'ptydzien'], async (ctx) => {
    const isPrevious = ctx.message.text.toLowerCase().includes('ptydzien');
    const { startDate, endDate } = financeService.getWeekRange(isPrevious ? -1 : 0);
    const summary = await financeService.getPeriodSummary(ctx.from.id, startDate, endDate);
    const target = isPrevious ? null : await financeService.getTargetProgress(ctx.from.id, 'WEEKLY');
    await ctx.reply(periodCard(isPrevious ? 'Poprzedni tydzień' : 'Bieżący tydzień', summary, target), HTML);
  });

  bot.command('miesiac', async (ctx) => {
    const param = ctx.message.text.trim().split(/\s+/)[1];
    const today = financeService.getEffectiveDate();

    let startDate: string;
    let endDate: string;

    if (param && /^\d{4}-\d{2}$/.test(param)) {
      const [yearStr, monthStr] = param.split('-');
      const year = Number(yearStr);
      const month = Number(monthStr);
      if (!Number.isInteger(year) || month < 1 || month > 12) {
        await ctx.reply(`❌ Nieprawidłowy miesiąc. Użyj np. ${code('/miesiac 2026-07')}.`, HTML);
        return;
      }
      ({ startDate, endDate } = monthRange(year, month));
    } else {
      const { year, month } = splitDate(today);
      startDate = monthRange(year, month).startDate;
      endDate = today; // biezacy miesiac liczymy do dzisiaj
    }

    const summary = await financeService.getPeriodSummary(ctx.from.id, startDate, endDate);
    const target = await financeService.getTargetProgress(ctx.from.id, 'MONTHLY');
    await ctx.reply(periodCard('Podsumowanie miesiąca', summary, target), HTML);
  });

  bot.command('statystyki', async (ctx) => {
    const param = ctx.message.text.trim().split(/\s+/)[1];
    const date = isValidDateStr(param) ? param : financeService.getEffectiveDate();
    const stats = await financeService.getCourseOfferStats(ctx.from.id, date);

    if (stats.totalOffers === 0) {
      await ctx.reply(`ℹ️ Brak zapisanych ofert kursów w dniu ${code(date)}.`, HTML);
      return;
    }
    await ctx.reply(offerStatsCard(stats), HTML);
  });

  // === 6. Saldo portfela =====================================================

  bot.command('saldo', async (ctx) => {
    const param = ctx.message.text.trim().split(/\s+/)[1];
    const tId = String(ctx.from.id);

    if (param) {
      const value = parseAmount(param);
      if (value == null) {
        await ctx.reply(`❌ Nieprawidłowa kwota. Użyj np. ${code('/saldo 127.50')}.`, HTML);
        return;
      }
      const { delta, balance } = await financeService.adjustWalletBalance(
        tId,
        financeService.getEffectiveDate(),
        value
      );
      await ctx.reply(
        joinLines([
          `💳 ${b('Saldo wyrównane do:')} ${b(zl(balance))}`,
          `📝 ${i(`Zapisano korektę ${zlSigned(delta)}, żeby saldo dalej wynikało wyłącznie z transakcji.`)}`,
        ]),
        HTML
      );
      return;
    }

    const wallet = await financeService.getWalletBalance(tId);
    await ctx.reply(
      joinLines([
        `💼 ${b('Saldo Portfela Glovo')}`,
        `💵 ${b('Aktualny stan:')} ${b(zl(wallet.balance))}`,
        '',
        wallet.transactionCount > 0
          ? i(`Suma ${wallet.transactionCount} transakcji, ostatnia z dnia ${wallet.lastDate}.`)
          : i('Brak transakcji — wyślij zrzut ekranu Portfela Glovo.'),
        '',
        `💡 Aby wyrównać saldo ręcznie: ${code('/saldo 127.50')}`,
      ]),
      HTML
    );
  });

  // === 7. Cele ===============================================================

  bot.command(['cel', 'target', 'cele'], async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/).slice(1);

    if (parts.length === 0) {
      await replyWithTargets(ctx);
      return;
    }

    let periodType: 'MONTHLY' | 'WEEKLY' = 'MONTHLY';
    let amountStr = parts[0];

    if (parts.length >= 2) {
      const sub = parts[0]?.toLowerCase() ?? '';
      if (['tydzien', 'tydzień', 'week', 'w'].includes(sub)) periodType = 'WEEKLY';
      amountStr = parts[1];
    }

    const amount = amountStr ? parseAmount(amountStr) : null;
    if (amount == null || amount <= 0) {
      await ctx.reply(`❌ Nieprawidłowa kwota. Użyj np. ${code('/cel 4000')} lub ${code('/cel tydzien 1200')}.`, HTML);
      return;
    }

    await financeService.setEarningTarget(ctx.from.id, periodType, amount);
    const progress = await financeService.getTargetProgress(ctx.from.id, periodType);
    if (progress) {
      await ctx.reply(`✅ ${b('Cel zapisany!')}\n\n${targetCard(progress)}`, HTML);
    }
  });

  bot.action('btn_quick_targets', async (ctx) => {
    await ctx.answerCbQuery();
    await replyWithTargets(ctx);
  });

  async function replyWithTargets(ctx: Context): Promise<void> {
    const id = ctx.from?.id;
    if (id == null) return;

    const [monthly, weekly] = await Promise.all([
      financeService.getTargetProgress(id, 'MONTHLY'),
      financeService.getTargetProgress(id, 'WEEKLY'),
    ]);

    if (!monthly && !weekly) {
      await ctx.reply(
        `🎯 ${b('Brak celów.')} Ustaw np. ${code('/cel 4500')} lub ${code('/cel tydzien 1200')}.`,
        HTML
      );
      return;
    }

    const cards = [monthly, weekly].filter((p): p is NonNullable<typeof p> => p !== null).map(targetCard);
    await ctx.reply(cards.join(`\n\n${SEPARATOR}\n\n`), HTML);
  }

  // === 8. Wpisy tekstowe (oczekiwanie na wartosc) ============================
  // Rejestrowane PO komendach — patrz FIX (3.1).

  bot.on(message('text'), async (ctx, next) => {
    const tId = String(ctx.from.id);
    const rawText = ctx.message.text.trim();
    const pending = takeAwaiting(tId);
    const date = financeService.getEffectiveDate();

    if (pending) {
      switch (pending) {
        case 'START_CUSTOM_TIME':
        case 'END_CUSTOM_TIME': {
          const time = normalizeTime(rawText);
          if (!time) {
            await ctx.reply(`❌ Błędny format godziny. Podaj np. ${code('19:30')} albo ${code('/anuluj')}.`, HTML);
            return;
          }
          awaitingInput.delete(tId);

          if (pending === 'START_CUSTOM_TIME') {
            const { hoursError } = await financeService.setShiftStart(tId, date, time);
            await ctx.reply(
              joinLines([`✅ ${b(`Godzina wyjazdu ${time} zapisana.`)}`, hoursError && `⚠️ ${i(hoursError)}`]),
              HTML
            );
          } else {
            const { summary, hoursError } = await financeService.setShiftEnd(tId, date, { workTo: time });
            await ctx.reply(
              joinLines([
                `✅ ${b(`Godzina zjazdu ${time} zapisana.`)} Czas pracy: ${b(`${summary.workHours.toFixed(2)} h`)}`,
                hoursError && `⚠️ ${i(hoursError)}`,
              ]),
              HTML
            );
          }
          return;
        }

        case 'END_DISTANCE': {
          const distance = parseDistance(rawText);
          if (distance == null) {
            await ctx.reply(`❌ Podaj liczbę kilometrów (np. ${code('52')}) albo ${code('/anuluj')}.`, HTML);
            return;
          }
          awaitingInput.delete(tId);
          await financeService.setDailyDistance(tId, date, distance);
          await ctx.reply(`✅ ${b(`Dystans dnia ${distance.toFixed(1)} km zapisany.`)}`, HTML);
          return;
        }

        case 'END_GROSS': {
          const value = parseAmount(rawText);
          if (value == null || value < 0) {
            await ctx.reply(`❌ Podaj kwotę brutto (np. ${code('438.60')}) albo ${code('/anuluj')}.`, HTML);
            return;
          }
          awaitingInput.delete(tId);
          await financeService.setGrossEarnings(tId, date, value);
          const summary = await financeService.getDailySummary(tId, date);
          await ctx.reply(
            joinLines([
              `✅ ${b('Zarobek brutto zapisany:')} ${b(zl(value))}`,
              `💵 ${b('Netto ze zleceń:')} ${b(zl(summary.netEarnings))}`,
              summary.workHours > 0 && `⏱️ ${b('Stawka:')} ${b(`${summary.hourlyRateNetto.toFixed(2)} zł netto/h`)}`,
            ]),
            HTML
          );
          return;
        }

        case 'FUEL_MANUAL': {
          const parsed = parseFuelInput(rawText);
          if (typeof parsed === 'string') {
            await ctx.reply(`❌ ${h(parsed)} Albo ${code('/anuluj')}.`, HTML);
            return;
          }
          awaitingInput.delete(tId);
          const fuelDate = parsed.date ?? date;
          await financeService.saveFuelReceipt(tId, fuelDate, {
            totalCost: parsed.totalCost,
            liters: parsed.liters,
            pricePerLiter: parsed.pricePerLiter,
          });
          await ctx.reply(await fuelSavedText(tId, fuelDate, parsed), HTML);
          return;
        }

        case 'START_WALLET_BALANCE':
        case 'END_WALLET_BALANCE': {
          const value = parseAmount(rawText);
          if (value == null) {
            await ctx.reply(`❌ Podaj poprawną kwotę (np. ${code('145.00')}) albo ${code('/anuluj')}.`, HTML);
            return;
          }
          awaitingInput.delete(tId);
          const { delta, balance } = await financeService.adjustWalletBalance(tId, date, value);
          await ctx.reply(
            joinLines([
              `✅ ${b('Portfel Glovo wyrównany do:')} ${b(zl(balance))}`,
              `📝 ${i(`Korekta ${zlSigned(delta)} zapisana jako transakcja.`)}`,
            ]),
            HTML
          );
          return;
        }
      }
    }

    // Potwierdzenie importu Portfela slowem "tak"/"nie".
    const importPending = pendingWalletImports.get(tId);
    if (importPending && Date.now() <= importPending.expiresAt) {
      const lower = rawText.toLowerCase();
      if (['tak', 't', 'zapisz', 'ok', 'yes', 'y'].includes(lower)) {
        pendingWalletImports.delete(tId);
        const result = await financeService.saveWalletTransactions(tId, importPending.transactions);
        await ctx.reply(
          joinLines([
            `✅ ${b(`Zapisano ${result.added} transakcji.`)}`,
            `📅 ${b('Dotknięte dni:')} ${code(result.dates.join(', '))}`,
            `💼 ${b('Saldo portfela:')} ${b(zl(result.balance))}`,
          ]),
          HTML
        );
        return;
      }
      if (['nie', 'n', 'anuluj'].includes(lower)) {
        pendingWalletImports.delete(tId);
        await ctx.reply('✖️ Anulowano import Portfela. Nic nie zostało zapisane.');
        return;
      }
    }

    return next();
  });

  // === 9. Szybkie napiwki ====================================================

  bot.hears(/^(?:n|np|napiwek)\s+(\d+(?:[.,]\d+)?)$/i, async (ctx) => {
    const amount = parseAmount(ctx.match[1] ?? '');
    if (amount == null || amount <= 0) return;

    const date = financeService.getEffectiveDate();
    await financeService.saveCashTip(ctx.from.id, date, amount);
    await ctx.reply(`💵 ${b('Dodano napiwek:')} ${b(zlSigned(amount))}\n📅 ${b('Data:')} ${code(date)}`, HTML);
  });

  // === 10. Oferty kursow — decyzje ==========================================

  bot.action(/^offer:(accept|reject):(\d+)$/, async (ctx) => {
    const accepted = ctx.match[1] === 'accept';
    const offerId = Number.parseInt(ctx.match[2] ?? '0', 10);

    // FIX (3.7): wynik byl ignorowany — bot potwierdzal zapis, ktorego nie bylo.
    const offer = await financeService.updateCourseOfferStatus(
      offerId,
      ctx.from.id,
      accepted ? 'ACCEPTED' : 'REJECTED'
    );

    if (!offer) {
      await ctx.answerCbQuery('Nie znaleziono tej oferty — status nie został zmieniony.', { show_alert: true });
      return;
    }

    await ctx.answerCbQuery(accepted ? 'Zaakceptowano' : 'Odrzucono');

    /**
     * FIX (3.6): karta jest przerysowywana z danych z bazy.
     * Stary kod filtrowal tekst wiadomosci po `'🔘 Status:'`, co nigdy nie
     * trafialo (linia miala gwiazdki), wiec karta konczyla z dwoma statusami.
     * Doklejanie do `message.text` i tak nie zadziala — Telegram zwraca tam
     * czysty tekst bez znacznikow formatowania.
     */
    await ctx.editMessageText(
      offerCard({
        isProfitable: offer.isProfitable,
        grossAmount: parseFloat(offer.grossAmount),
        netAmount: parseFloat(offer.netAmount),
        pickupAddress: offer.pickupAddress ?? '—',
        deliveryAddress: offer.deliveryAddress ?? '—',
        appPickupKm: dec(offer.appPickupKm),
        appDeliveryKm: dec(offer.appDeliveryKm),
        appTotalKm: dec(offer.appTotalKm),
        mapsPickupKm: dec(offer.mapsPickupKm),
        mapsDeliveryKm: dec(offer.mapsDeliveryKm),
        mapsTotalKm: dec(offer.mapsTotalKm),
        mapsReason: offer.mapsPickupKm ? null : 'brak danych z Google Maps',
        mapsDeliveryReason: 'oferta nie podaje adresu klienta',
        mapsAgeMin: 0,
        totalKm: parseFloat(offer.distanceTotalKm),
        rateBasis: offer.rateBasis === 'MAPS' ? 'MAPS' : offer.rateBasis === 'NONE' ? 'NONE' : 'APP',
        netRatePerKm: parseFloat(offer.netRatePerKm),
        status: accepted ? 'ACCEPTED' : 'REJECTED',
      }),
      { ...HTML, ...offerDoneKeyboard(accepted) }
    );
  });

  bot.action('offer_done', async (ctx) => {
    await ctx.answerCbQuery('Status tego zlecenia został już zarejestrowany.');
  });

  // === 11. Import Portfela — przyciski ======================================

  bot.action(/^wallet_(confirm|cancel)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const tId = String(ctx.from.id);
    const pending = pendingWalletImports.get(tId);

    if (!pending || Date.now() > pending.expiresAt) {
      pendingWalletImports.delete(tId);
      await ctx.editMessageText('⌛ Ta prośba o potwierdzenie wygasła. Wyślij zrzut ponownie.');
      return;
    }

    pendingWalletImports.delete(tId);

    if (ctx.match[1] === 'cancel') {
      await ctx.editMessageText('✖️ Anulowano import. Nic nie zmieniono.');
      return;
    }

    const result = await financeService.saveWalletTransactions(tId, pending.transactions);
    await ctx.editMessageText(
      joinLines([
        `✅ ${b(`Zapisano ${result.added} transakcji.`)}`,
        result.skipped > 0 && `⏭ ${b('Pominięte duplikaty:')} ${result.skipped}`,
        `📅 ${b('Zaktualizowane dni:')} ${code(result.dates.join(', '))}`,
        `💼 ${b('Saldo portfela:')} ${b(zl(result.balance))}`,
      ]),
      HTML
    );
  });

  // === 12. Voice-to-Data =====================================================

  bot.on([message('voice'), message('audio')], async (ctx) => {
    const voiceMsg = 'voice' in ctx.message ? ctx.message.voice : ctx.message.audio;
    if (!voiceMsg) return;

    const processing = await ctx.reply('🎙️ Przetwarzam notatkę głosową…');
    const editProcessing = (text: string) =>
      ctx.telegram.editMessageText(ctx.chat.id, processing.message_id, undefined, text, HTML);

    try {
      const audio = await downloadTelegramFile(
        () => ctx.telegram.getFileLink(voiceMsg.file_id),
        voiceMsg.file_size,
        CFG.MAX_AUDIO_BYTES,
        'Nagranie'
      );

      const mimeType = 'mime_type' in voiceMsg && voiceMsg.mime_type ? voiceMsg.mime_type : 'audio/ogg';
      const extracted = await geminiService.parseVoiceNote(audio, mimeType);

      if (extracted.action === 'DELETE' && extracted.deleteTarget) {
        const result = await financeService.handleVoiceDeletion(
          ctx.from.id,
          extracted.deleteTarget,
          extracted.targetDate
        );
        await editProcessing(
          joinLines([
            `🗣️ ${i(`„${extracted.transcription}”`)}`,
            '',
            `${result.success ? '🗑️' : '⚠️'} ${h(result.message)}`,
          ])
        );
        return;
      }

      const saved = await financeService.saveVoiceEvent(ctx.from.id, extracted);

      await editProcessing(
        joinLines([
          `🗣️ ${b('Transkrypcja:')} ${i(`„${extracted.transcription}”`)}`,
          `📅 ${b('Data wpisu:')} ${code(saved.date)}`,
          '',
          saved.hasFuel && `⛽ ${b('Zapisano tankowanie:')}`,
          saved.hasFuel && extracted.fuelTotalCost != null && ` • Koszt: ${b(zl(extracted.fuelTotalCost))}`,
          saved.hasFuel && extracted.fuelLiters != null && ` • Ilość: ${b(`${extracted.fuelLiters} L`)}`,
          saved.hasFuel &&
            extracted.fuelPricePerLiter != null &&
            ` • Cena: ${b(`${extracted.fuelPricePerLiter.toFixed(2)} zł/L`)}`,
          extracted.distanceKm != null && `🚗 ${b('Dystans dnia:')} ${b(`${extracted.distanceKm} km`)}`,
          extracted.grossEarnings != null && `💰 ${b('Zarobek brutto:')} ${b(zl(extracted.grossEarnings))}`,
          extracted.workFrom &&
            extracted.workTo &&
            `⏱️ ${b('Godziny:')} ${code(`${extracted.workFrom} - ${extracted.workTo}`)}`,
          extracted.cashTip != null && `💵 ${b('Napiwek gotówkowy:')} ${b(zlSigned(extracted.cashTip))}`,
          saved.hoursError && `⚠️ ${i(saved.hoursError)}`,
          !saved.hasDailyUpdate && !saved.hasTip && !saved.hasFuel && i('Nie rozpoznano żadnych danych do zapisania.'),
        ])
      );
    } catch (err) {
      console.error('[VoiceHandler]', err);
      await editProcessing(`❌ ${b('Błąd przetwarzania audio.')} ${h(err instanceof Error ? err.message : '')}`).catch(
        () => {}
      );
    }
  });

  // === 13. Vision — zdjecia ==================================================

  bot.on(message('photo'), async (ctx) => {
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;

    const caption = ctx.message.caption ?? '';

    // Przy albumie zdjec Telegram wysyla osobny update na kazde — warto pokazac,
    // ze reszta czeka w kolejce, zamiast zostawiac "Analizuję…" na minute.
    const queued = geminiQueue.pending + geminiQueue.running;
    const processing = await ctx.reply(
      queued > 0 ? `🔍 Analizuję obraz… ${i(`(w kolejce: ${queued})`)}` : '🔍 Analizuję obraz…',
      HTML
    );
    const editProcessing = (text: string, extra?: Record<string, unknown>) =>
      ctx.telegram.editMessageText(ctx.chat.id, processing.message_id, undefined, text, { ...HTML, ...extra });

    try {
      const image = await downloadTelegramFile(
        () => ctx.telegram.getFileLink(photo.file_id),
        photo.file_size,
        CFG.MAX_PHOTO_BYTES,
        'Zdjęcie'
      );

      const category = await geminiService.classifyImage(image, caption);
      const tId = String(ctx.from.id);

      // --- Portfel Glovo ---
      if (category === 'WALLET') {
        const currentYear = splitDate(financeService.getEffectiveDate()).year;
        const transactions = await geminiService.analyzeWalletScreenshot(image, currentYear);

        if (transactions.length === 0) {
          await editProcessing('⚠️ Nie rozpoznano żadnych pozycji w zrzucie Portfela.');
          return;
        }

        const preview = await financeService.previewWalletImport(tId, transactions);

        if (preview.newTransactions.length === 0) {
          await editProcessing(
            `ℹ️ Wszystkie ${transactions.length} transakcji z tego zrzutu są już w bazie (brak nowych).`
          );
          return;
        }

        pendingWalletImports.set(tId, {
          transactions: preview.newTransactions,
          expiresAt: Date.now() + CFG.WALLET_IMPORT_TTL_MS,
        });

        await editProcessing(
          joinLines([
            `📥 ${b('Rozpoznano transakcje Portfela Glovo:')}`,
            '',
            ...preview.newTransactions.map(
              (t) => `• ${code(`${t.date} ${t.time}`)} ${b(t.type)} ➔ ${b(zlSigned(t.amount))}`
            ),
            '',
            `➕ ${b('Nowe:')} ${preview.newTransactions.length} szt.  |  ⏭ ${b('Duplikaty:')} ${preview.existingCount}`,
            `💵 ${b('Wpływ na saldo:')} ${b(zlSigned(preview.totalAmountDelta))}`,
          ]),
          walletImportKeyboard()
        );
        return;
      }

      // --- Paragon paliwowy ---
      if (category === 'FUEL') {
        const receipt = await geminiService.extractFuelReceipt(image);
        const date = isValidDateStr(receipt.date) ? receipt.date : financeService.getEffectiveDate();

        await financeService.saveFuelReceipt(tId, date, {
          totalCost: receipt.totalCost,
          liters: receipt.liters,
          pricePerLiter: receipt.pricePerLiter,
        });

        // Ta sama tresc potwierdzenia co przy wpisie recznym.
        await editProcessing(
          `🧾 ${i('odczytano z paragonu')}\n` +
            (await fuelSavedText(tId, date, {
              date,
              totalCost: receipt.totalCost,
              liters: receipt.liters,
              pricePerLiter: receipt.pricePerLiter,
            }))
        );
        return;
      }

      // --- Oferta kursu ---
      const offer = await geminiService.analyzeCourseOffer(image);
      const userLoc = freshLocation(tId);

      const route = await verifyOfferDistance(
        userLoc ? { lat: userLoc.latitude, lng: userLoc.longitude, ts: userLoc.updatedAt } : null,
        offer.pickupAddress,
        offer.deliveryAddress
      );

      // Suma z aplikacji: oba odcinki widoczne na ekranie oferty.
      const appTotalKm =
        offer.appPickupKm != null && offer.appDeliveryKm != null
          ? Math.round((offer.appPickupKm + offer.appDeliveryKm) * 100) / 100
          : null;

      /**
       * Podstawa stawki: dystans z APLIKACJI, nie z Google Maps.
       *
       * Glovo liczy oba odcinki od biezacej pozycji kuriera i zna prawdziwy
       * adres klienta. Maps liczy od ostatniego wyslanego GPS-a, a odcinka
       * do klienta w ogole nie policzy, bo oferta go nie ujawnia. Wczesniej
       * bot dzielil kwote przez zmyslona liczbe i kazal odrzucac oplacalne kursy.
       */
      const rateBasis: 'APP' | 'MAPS' | 'NONE' =
        appTotalKm != null && appTotalKm > 0
          ? 'APP'
          : route.totalKm != null && route.totalKm > 0
            ? 'MAPS'
            : 'NONE';

      const totalKm = rateBasis === 'APP' ? appTotalKm! : rateBasis === 'MAPS' ? route.totalKm! : 0;

      const { netAmount, netRatePerKm, isProfitable } = computeOfferRate({
        grossAmount: offer.grossAmount,
        totalKm,
      });

      const offerId = await financeService.saveCourseOffer(tId, {
        grossAmount: offer.grossAmount,
        netAmount,
        appPickupKm: offer.appPickupKm,
        appDeliveryKm: offer.appDeliveryKm,
        appTotalKm,
        mapsPickupKm: route.pickupKm,
        mapsDeliveryKm: route.deliveryKm,
        mapsTotalKm: route.totalKm,
        distanceTotalKm: totalKm,
        rateBasis,
        netRatePerKm,
        isProfitable,
        pickupAddress: offer.pickupAddress,
        deliveryAddress: offer.deliveryAddress,
      });

      await editProcessing(
        offerCard({
          isProfitable,
          grossAmount: offer.grossAmount,
          netAmount,
          pickupAddress: offer.pickupAddress,
          deliveryAddress: offer.deliveryAddress,
          appPickupKm: offer.appPickupKm,
          appDeliveryKm: offer.appDeliveryKm,
          appTotalKm,
          mapsPickupKm: route.pickupKm,
          mapsDeliveryKm: route.deliveryKm,
          mapsTotalKm: route.totalKm,
          mapsReason: route.reason,
          mapsDeliveryReason: route.deliveryReason,
          mapsAgeMin: route.ageMin,
          totalKm,
          rateBasis,
          netRatePerKm,
          status: 'PENDING',
        }),
        offerDecisionKeyboard(offerId)
      );
    } catch (err) {
      console.error('[PhotoHandler]', err);
      await editProcessing(`❌ ${b('Błąd analizy obrazu.')} ${h(err instanceof Error ? err.message : '')}`).catch(
        () => {}
      );
    }
  });
}
```

# Plik: src/bot/keyboards.ts
```typescript
import { Markup } from 'telegraf';

/**
 * FIX (4.8): klawiatury byly budowane w kilku miejscach z kopiuj-wklej
 * (`/wyjazd` i `btn_quick_start_shift` mialy identyczny markup w dwoch kopiach).
 * Teraz jedno zrodlo prawdy.
 */

export const mainMenuKeyboard = () =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('🚀 Rozpocznij zmianę', 'btn_quick_start_shift'),
      Markup.button.callback('🏁 Zakończ zmianę', 'btn_quick_end_shift'),
    ],
    [
      Markup.button.callback('📊 Podsumowanie dziś', 'btn_quick_today'),
      Markup.button.callback('🎯 Moje cele', 'btn_quick_targets'),
    ],
  ]);

export const startShiftKeyboard = (currentTime: string, alreadySaved: boolean) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(
        alreadySaved ? `🔄 Nadpisz start (${currentTime})` : `⚡ Zapisz start teraz (${currentTime})`,
        'startshift_start_now'
      ),
    ],
    [
      Markup.button.callback('✏️ Wpisz inną godzinę', 'startshift_custom_time'),
      Markup.button.callback('💵 Ustaw kasetkę', 'startshift_set_cash'),
    ],
  ]);

export const endShiftKeyboard = (currentTime: string, alreadySaved: boolean) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(
        alreadySaved ? `🔄 Nadpisz zjazd (${currentTime})` : `⏱️ Zapisz zjazd teraz (${currentTime})`,
        'endshift_set_now'
      ),
    ],
    [
      Markup.button.callback('✏️ Inna godzina', 'endshift_custom_time'),
      Markup.button.callback('🚗 Dystans dnia', 'endshift_set_dist'),
    ],
    [
      Markup.button.callback('💰 Zarobek brutto', 'endshift_set_gross'),
      Markup.button.callback('⛽ Paliwo', 'endshift_add_fuel'),
    ],
    [Markup.button.callback('💵 Stan portfela Glovo', 'endshift_set_cash')],
  ]);

export const cancelInputKeyboard = () =>
  Markup.inlineKeyboard([[Markup.button.callback('✖️ Anuluj', 'input_cancel')]]);

export const walletImportKeyboard = () =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Zapisz transakcje', 'wallet_confirm'),
      Markup.button.callback('✖️ Anuluj', 'wallet_cancel'),
    ],
  ]);

export const offerDecisionKeyboard = (offerId: number) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Zaakceptowano', `offer:accept:${offerId}`),
      Markup.button.callback('❌ Odrzucono', `offer:reject:${offerId}`),
    ],
  ]);

export const offerDoneKeyboard = (accepted: boolean) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(accepted ? '✅ Zlecenie zaakceptowane' : '❌ Zlecenie odrzucone', 'offer_done')],
  ]);

export const locationRequestKeyboard = () =>
  Markup.keyboard([[Markup.button.locationRequest('📍 Wyślij moją pozycję GPS')]])
    .resize()
    .oneTime();

export const removeKeyboard = () => Markup.removeKeyboard();
```

# Plik: src/config.ts
```typescript
import 'dotenv/config';

function parseIdList(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return new Set<string>();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
}

export const CFG = {
  /** Strefa czasowa uzywana WSZEDZIE do wyznaczania dat i godzin. */
  TZ: 'Europe/Warsaw',

  /** 18,6% skladki i podatek (UoP >26 lat). Docelowo do zastapienia progami. */
  TAX_FACTOR: 0.186,
  /** 81,4% kwoty brutto -> netto. */
  NETTO_FACTOR: 0.814,

  /** Prog oplacalnosci kursu (zl netto / km calej trasy). */
  MIN_STAWKA_NETTO_KM: 2.0,

  /** Waznosc lokalizacji GPS do weryfikacji tras (30 min). */
  LOCATION_MAX_AGE_MS: 30 * 60 * 1000,
  /** Od jakiej roznicy miedzy aplikacja a Google Maps ostrzegac (km). */
  DISTANCE_DIVERGENCE_KM: 1.5,
  /** Jak dlugo czeka potwierdzenie importu Portfela. */
  WALLET_IMPORT_TTL_MS: 15 * 60 * 1000,
  /** Jak dlugo bot czeka na wpisanie wartosci z klawiatury. */
  AWAITING_INPUT_TTL_MS: 5 * 60 * 1000,

  /** Limity plikow przyjmowanych od Telegrama (sprawdzane PRZED pobraniem). */
  MAX_AUDIO_BYTES: 15 * 1024 * 1024,
  MAX_PHOTO_BYTES: 20 * 1024 * 1024,
  /** Timeout pobierania pliku z serwerow Telegrama. */
  DOWNLOAD_TIMEOUT_MS: 30 * 1000,

  /** Sanity-check dlugosci zmiany. Poza zakresem = blad wpisu, nie cicha korekta. */
  MIN_SHIFT_HOURS: 0.25,
  MAX_SHIFT_HOURS: 16,

  /** Stawka przyjmowana do prognoz, dopoki nie ma wlasnej historii godzin. */
  FALLBACK_HOURLY_RATE_NETTO: 35.0,

  /**
   * Domena webhooka (np. `bot.baranskiha.ovh`). Pusta = long polling.
   * Sam host, bez `https://` i bez sciezki.
   */
  WEBHOOK_DOMAIN: (process.env.WEBHOOK_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
  /** Port nasluchu w kontenerze. Nie jest wystawiany na zewnatrz — siega go tunel. */
  WEBHOOK_PORT: Number(process.env.WEBHOOK_PORT ?? 8080),
  /** Ile rownoleglych polaczen Telegram moze otworzyc do webhooka. */
  WEBHOOK_MAX_CONNECTIONS: Number(process.env.WEBHOOK_MAX_CONNECTIONS ?? 20),

  /** Model Gemini - jedno miejsce dla calej aplikacji. */
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3.7-flash',

  /**
   * Kolejka zapytan do Gemini. Album 3 zdjec = 6 wywolan (klasyfikacja + odczyt),
   * wiec bez limitu rownoleglosci darmowy tier zwraca 429.
   */
  GEMINI_CONCURRENCY: Number(process.env.GEMINI_CONCURRENCY ?? 1),
  GEMINI_MIN_INTERVAL_MS: Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 1200),
  GEMINI_MAX_RETRIES: Number(process.env.GEMINI_MAX_RETRIES ?? 4),
  GEMINI_BASE_DELAY_MS: 2000,
  GEMINI_MAX_DELAY_MS: 60_000,
  GEMINI_MAX_QUEUE: 20,

  /** Kolejka Google Maps - limity sa luzniejsze, ale 429 tez sie zdarza. */
  MAPS_CONCURRENCY: Number(process.env.MAPS_CONCURRENCY ?? 4),
  MAPS_MIN_INTERVAL_MS: Number(process.env.MAPS_MIN_INTERVAL_MS ?? 100),
  MAPS_MAX_RETRIES: 3,
  MAPS_BASE_DELAY_MS: 500,
  MAPS_MAX_DELAY_MS: 10_000,
  MAPS_MAX_QUEUE: 50,

  /**
   * Lista telegram_id z dostepem do bota (ALLOWED_TELEGRAM_IDS="123,456").
   * Pusta = bot otwarty dla wszystkich, ostrzezenie przy starcie.
   */
  ALLOWED_TELEGRAM_IDS: parseIdList(process.env.ALLOWED_TELEGRAM_IDS),
} as const;

export function isAllowedUser(telegramId: string | number): boolean {
  if (CFG.ALLOWED_TELEGRAM_IDS.size === 0) return true;
  return CFG.ALLOWED_TELEGRAM_IDS.has(String(telegramId));
}
```

# Plik: src/db/index.ts
```typescript
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('Brak zmiennej DATABASE_URL w pliku .env!');
}

/**
 * TLS jest OPT-IN.
 *
 * Postgres w kontenerze obok bota nie ma wlaczonego SSL — wymuszanie go
 * konczy sie bledem "The server does not support SSL connections" przy
 * pierwszym zapytaniu (pula laczy sie leniwie, wiec bot startuje normalnie
 * i dopiero pierwsza komenda zwraca blad).
 *
 * Hostowane bazy (Neon, Supabase, Railway) maja `sslmode=require` w URL-u,
 * wiec zostana wykryte automatycznie. Reszte wlaczasz przez DATABASE_SSL=true.
 */
const useSsl = process.env.DATABASE_SSL === 'true' || /sslmode=(require|verify)/.test(connectionString);

export const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

pool.on('error', (err) => {
  console.error('[DB Pool Error]', err);
});

export const db = drizzle(pool, { schema });

export async function closeDb(): Promise<void> {
  await pool.end();
}
```

# Plik: src/db/schema.ts
```typescript
import {
  pgTable,
  serial,
  text,
  numeric,
  integer,
  boolean,
  timestamp,
  date,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * FIX (4.2): tabela `users` byla zadeklarowana i nigdy nie zapisywana.
 * Teraz middleware bota robi upsert przy kazdej interakcji, a pozostale
 * tabele maja klucz obcy na `users.telegram_id`.
 */
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  telegramId: text('telegram_id').notNull().unique(),
  username: text('username'),
  firstName: text('first_name'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
});

/**
 * Jeden wiersz na dzien pracy.
 *
 * FIX (2.7): `fuel_distance` -> `distance_km`. To DZIENNY przejechany dystans,
 * nie stan licznika pojazdu. Sumowanie stanow licznika w raportach okresowych
 * dawalo bezsensowne liczby.
 * FIX (2.8): kolumny paliwowe wyprowadzone do osobnej tabeli `fuel_receipts`,
 * bo upsert na (telegram_id, date) kasowal drugie tankowanie tego samego dnia.
 */
export const dailyRecords = pgTable(
  'daily_records',
  {
    id: serial('id').primaryKey(),
    telegramId: text('telegram_id')
      .notNull()
      .references(() => users.telegramId, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    distanceKm: numeric('distance_km', { precision: 10, scale: 2 }),
    grossEarnings: numeric('gross_earnings', { precision: 10, scale: 2 }),
    workFrom: text('work_from'),
    workTo: text('work_to'),
    workHours: numeric('work_hours', { precision: 5, scale: 2 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    userDateIdx: uniqueIndex('daily_records_user_date_idx').on(table.telegramId, table.date),
  })
);

/**
 * FIX (2.8 + 5.3): osobna tabela na paragony. Wiele tankowan dziennie sumuje sie
 * zamiast nadpisywac. Trzymamy koszt calosci ORAZ cene za litr - stara kolumna
 * `fuel_price` mylaca nazwa: przechowywala kwote calego paragonu.
 */
export const fuelReceipts = pgTable(
  'fuel_receipts',
  {
    id: serial('id').primaryKey(),
    telegramId: text('telegram_id')
      .notNull()
      .references(() => users.telegramId, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    /** Kwota calego paragonu w zl. */
    totalCost: numeric('total_cost', { precision: 10, scale: 2 }).notNull(),
    liters: numeric('liters', { precision: 10, scale: 2 }),
    /** Cena za litr w zl. Liczona z paragonu albo total/liters. */
    pricePerLiter: numeric('price_per_liter', { precision: 10, scale: 3 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    // FIX (4.9)
    userDateIdx: index('fuel_receipts_user_date_idx').on(table.telegramId, table.date),
  })
);

export const cashTips = pgTable(
  'cash_tips',
  {
    id: serial('id').primaryKey(),
    telegramId: text('telegram_id')
      .notNull()
      .references(() => users.telegramId, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    // FIX (4.9)
    userDateIdx: index('cash_tips_user_date_idx').on(table.telegramId, table.date),
  })
);

/**
 * Transakcje Portfela Glovo - JEDYNE zrodlo prawdy o saldzie (2.2).
 *
 * FIX (2.5): `external_id` i `time` sa NOT NULL z domyslnym `''`.
 * W Postgresie NULL != NULL, wiec unikalny indeks z kolumna NULL-owalna
 * w ogole nie blokowal duplikatow transakcji bez ID.
 */
export const walletTransactions = pgTable(
  'wallet_transactions',
  {
    id: serial('id').primaryKey(),
    telegramId: text('telegram_id')
      .notNull()
      .references(() => users.telegramId, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    time: text('time').notNull().default(''),
    /** 'pobranie' | 'wyplata' | 'wyplata_gotowka' | 'platnosc_punkt' | 'korekta' */
    type: text('type').notNull(),
    /** Kwota ZE ZNAKIEM. Suma tej kolumny = saldo portfela. */
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    externalId: text('external_id').notNull().default(''),
    /** Skad wpis: 'OCR' (zrzut Portfela), 'MANUAL' (recznie), 'IMPORT' (CSV). */
    source: text('source').notNull().default('OCR'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    walletTxDedupIdx: uniqueIndex('wallet_tx_dedup_idx').on(
      table.telegramId,
      table.date,
      table.time,
      table.type,
      table.amount,
      table.externalId
    ),
    userDateIdx: index('wallet_tx_user_date_idx').on(table.telegramId, table.date),
  })
);

/**
 * FIX (2.3): dystans rozbity na trzy kolumny - Suma | Odbior | Dostawa.
 * Wczesniej weryfikacja Google Maps podmieniala `total_distance` na sam dojazd
 * do restauracji, przez co stawka zl/km znaczyla cos innego w zaleznosci od
 * tego, czy GPS byl swiezy.
 */
export const courseOffers = pgTable(
  'course_offers',
  {
    id: serial('id').primaryKey(),
    telegramId: text('telegram_id')
      .notNull()
      .references(() => users.telegramId, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    time: text('time').notNull(),
    grossAmount: numeric('gross_amount', { precision: 10, scale: 2 }).notNull(),
    netAmount: numeric('net_amount', { precision: 10, scale: 2 }).notNull(),

    // --- Dystans deklarowany przez aplikacje Glovo (z ekranu oferty) ---------
    appPickupKm: numeric('app_pickup_km', { precision: 10, scale: 2 }),
    appDeliveryKm: numeric('app_delivery_km', { precision: 10, scale: 2 }),
    appTotalKm: numeric('app_total_km', { precision: 10, scale: 2 }),

    // --- Dystans policzony niezaleznie przez Google Maps --------------------
    // Odcinek dostawy zwykle zostaje pusty: przed akceptacja Glovo nie podaje
    // adresu klienta, wiec nie ma czego geokodowac.
    mapsPickupKm: numeric('maps_pickup_km', { precision: 10, scale: 2 }),
    mapsDeliveryKm: numeric('maps_delivery_km', { precision: 10, scale: 2 }),
    mapsTotalKm: numeric('maps_total_km', { precision: 10, scale: 2 }),

    /** Dystans faktycznie uzyty do wyliczenia stawki zl/km. */
    distanceTotalKm: numeric('distance_total_km', { precision: 10, scale: 2 }).notNull(),
    /** Skad wziety `distance_total_km`: 'APP' | 'MAPS' | 'NONE'. */
    rateBasis: text('rate_basis').notNull().default('APP'),
    netRatePerKm: numeric('net_rate_per_km', { precision: 10, scale: 2 }).notNull(),
    isProfitable: boolean('is_profitable').notNull(),
    /** 'PENDING' | 'ACCEPTED' | 'REJECTED' */
    status: text('status').default('PENDING').notNull(),
    pickupAddress: text('pickup_address'),
    deliveryAddress: text('delivery_address'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    // FIX (4.9)
    userDateIdx: index('course_offers_user_date_idx').on(table.telegramId, table.date),
  })
);

/**
 * FIX (2.10): `year` przechowuje ROK ISO dla celow tygodniowych
 * (dla miesiecznych - zwykly rok kalendarzowy).
 */
export const earningTargets = pgTable(
  'earning_targets',
  {
    id: serial('id').primaryKey(),
    telegramId: text('telegram_id')
      .notNull()
      .references(() => users.telegramId, { onDelete: 'cascade' }),
    /** 'MONTHLY' | 'WEEKLY' */
    periodType: text('period_type').notNull(),
    targetAmount: numeric('target_amount', { precision: 10, scale: 2 }).notNull(),
    /** MONTHLY: rok kalendarzowy. WEEKLY: rok ISO. */
    year: integer('year').notNull(),
    /** MONTHLY: 1-12. WEEKLY: numer tygodnia ISO 1-53. */
    periodValue: integer('period_value').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    targetUserPeriodIdx: uniqueIndex('earning_targets_user_period_idx').on(
      table.telegramId,
      table.periodType,
      table.year,
      table.periodValue
    ),
  })
);

/**
 * USUNIETE (2.2): `balance_checkpoints`.
 * Saldo liczone jest wylacznie jako suma `wallet_transactions.amount`.
 * Reczna korekta salda zapisuje sie jako transakcja typu 'korekta',
 * dzieki czemu historia pozostaje audytowalna.
 */
```

# Plik: src/index.ts
```typescript
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { CFG } from './config.js';
import { closeDb } from './db/index.js';
import { registerBotHandlers } from './bot/index.js';
import { startWebhookServer, stopWebhookServer } from './server.js';
import type { Server } from 'node:http';

const botToken = process.env.BOT_TOKEN;
if (!botToken) {
  throw new Error('Brak zmiennej BOT_TOKEN w pliku .env!');
}

const bot = new Telegraf(botToken);

registerBotHandlers(bot);

/**
 * FIX (3.4): globalny handler bledow.
 * Wczesniej tylko `voice` i `photo` mialy try/catch — komenda `/dzis` przy
 * padnietym polaczeniu z baza po prostu milczala, a slad zostawal w logach.
 */
bot.catch(async (err, ctx) => {
  console.error(`[Bot Error] update=${ctx.updateType}`, err);
  try {
    await ctx.reply('❌ Coś poszło nie tak po mojej stronie. Spróbuj ponownie za chwilę.');
  } catch {
    /* wiadomosc moze byc nie do wyslania (zablokowany bot) — ignorujemy */
  }
});

async function main(): Promise<void> {
  if (CFG.ALLOWED_TELEGRAM_IDS.size === 0) {
    console.warn(
      '⚠️  ALLOWED_TELEGRAM_IDS jest puste — bot przyjmuje wiadomości od KAŻDEGO. ' +
        'Ustaw np. ALLOWED_TELEGRAM_IDS="5066453902".'
    );
  }

  const me = await bot.telegram.getMe();
  let webhookServer: Server | null = null;

  if (CFG.WEBHOOK_DOMAIN) {
    // --- Tryb webhook -------------------------------------------------------
    // Telegram sam puka pod nasz adres, wiec zadna instancja nie odpytuje
    // `getUpdates` i konflikt 409 przy podmianie kontenera nie ma jak wystapic.
    webhookServer = await startWebhookServer(bot, botToken);
    console.log(`🤖 @${me.username} działa w trybie WEBHOOK (model: ${CFG.GEMINI_MODEL}, TZ: ${CFG.TZ})`);
  } else {
    // --- Tryb long polling (rozwoj lokalny) ---------------------------------
    // Webhook i polling wykluczaja sie wzajemnie — jesli poprzednio byl
    // ustawiony webhook, `getUpdates` zwracalby 409, dopoki go nie usuniemy.
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });

    /**
     * FIX (3.5): `bot.launch()` w Telegraf 4 rozwiazuje sie dopiero po
     * ZATRZYMANIU pollingu, wiec `.then(...)` logowal przy zamykaniu bota.
     * Do tego brakowalo `.catch()` — bledny token dawal unhandled rejection.
     */
    void bot.launch().catch((err) => {
      console.error('❌ Polling Telegrama przerwany:', err);
      process.exit(1);
    });

    console.log(`🤖 @${me.username} działa w trybie POLLING (model: ${CFG.GEMINI_MODEL}, TZ: ${CFG.TZ})`);
    console.log('💡 Ustaw WEBHOOK_DOMAIN w .env, żeby przełączyć na webhook.');
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} — zamykam bota…`);

    // Webhooka NIE kasujemy: Telegram kolejkuje update'y do 24 h i dostarczy
    // je, gdy kontener wróci. Usunięcie oznaczałoby utratę wiadomości
    // wysłanych w trakcie wdrożenia.
    if (webhookServer) await stopWebhookServer(webhookServer).catch(() => {});
    else bot.stop(signal);

    await closeDb().catch((err) => console.error('[DB close]', err));
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('❌ Nie udało się uruchomić bota:', err);
  process.exit(1);
});
```

# Plik: src/scripts/import-sheets.ts
```typescript
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import 'dotenv/config';
import { closeDb, db } from '../db/index.js';
import { dailyRecords, cashTips, fuelReceipts, walletTransactions } from '../db/schema.js';
import { ensureUserById } from '../services/user.service.js';
import { normalizeTime } from '../utils/datetime.js';

/**
 * FIX (1.3): `telegramId` bylo liczba przy kolumnie `text`, a `fuelDistance`
 * stringiem przy kolumnie `integer`. Oba bledy typow blokowaly kompilacje,
 * a "52.3" i tak nie wchodzi do `integer`.
 */
const TELEGRAM_ID = String(process.env.IMPORT_TELEGRAM_ID ?? '5066453902');

type Row = string[];

function parseNum(val: unknown): number | null {
  if (typeof val !== 'string') return null;
  const clean = val.trim().replace(/\s/g, '').replace(',', '.').replace(/[^0-9.-]/g, '');
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

function parseDate(val: unknown): string | null {
  if (typeof val !== 'string') return null;
  const s = val.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
  if (!m) return null;
  return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

function readCsv(fileName: string): Row[] | null {
  const filePath = path.resolve('data', fileName);
  if (!fs.existsSync(filePath)) {
    console.log(`ℹ️  Brak pliku data/${fileName} — pomijam.`);
    return null;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return parse(content, { skip_empty_lines: true, relax_column_count: true }) as Row[];
}

async function importDane(): Promise<void> {
  const records = readCsv('dane.csv');
  if (!records) return;

  let importedDays = 0;
  let importedFuel = 0;

  for (let idx = 1; idx < records.length; idx++) {
    const row = records[idx];
    if (!row) continue;

    const date = parseDate(row[0]);
    if (!date || row[0]?.trim().toUpperCase() === 'SUMA') continue;

    const fuelCost = parseNum(row[2]);
    const fuelLiters = parseNum(row[3]);
    const distance = parseNum(row[4]);
    const gross = parseNum(row[8]);
    const workFrom = normalizeTime(row[13] ?? '');
    const workTo = normalizeTime(row[14] ?? '');
    const workHours = parseNum(row[15]);

    await db
      .insert(dailyRecords)
      .values({
        telegramId: TELEGRAM_ID,
        date,
        distanceKm: distance != null ? distance.toFixed(2) : null,
        grossEarnings: gross != null ? gross.toFixed(2) : null,
        workFrom,
        workTo,
        workHours: workHours != null ? workHours.toFixed(2) : null,
      })
      .onConflictDoNothing();
    importedDays++;

    // Paliwo trafia do osobnej tabeli (2.8).
    if (fuelCost != null && fuelCost > 0) {
      await db.insert(fuelReceipts).values({
        telegramId: TELEGRAM_ID,
        date,
        totalCost: fuelCost.toFixed(2),
        liters: fuelLiters != null ? fuelLiters.toFixed(2) : null,
        pricePerLiter: fuelLiters && fuelLiters > 0 ? (fuelCost / fuelLiters).toFixed(3) : null,
      });
      importedFuel++;
    }
  }

  console.log(`✅ Zaimportowano ${importedDays} wpisów dziennych i ${importedFuel} paragonów z dane.csv`);
}

async function importNapiwki(): Promise<void> {
  const records = readCsv('napiwki.csv');
  if (!records) return;

  let imported = 0;
  for (let idx = 1; idx < records.length; idx++) {
    const row = records[idx];
    if (!row) continue;

    const date = parseDate(row[0]);
    const amount = parseNum(row[1]);
    if (!date || amount == null) continue;

    await db.insert(cashTips).values({ telegramId: TELEGRAM_ID, date, amount: amount.toFixed(2) });
    imported++;
  }
  console.log(`✅ Zaimportowano ${imported} napiwków z napiwki.csv`);
}

async function importPortfel(): Promise<void> {
  const records = readCsv('portfel.csv');
  if (!records) return;

  let imported = 0;
  for (let idx = 1; idx < records.length; idx++) {
    const row = records[idx];
    if (!row) continue;

    const date = parseDate(row[0]);
    const time = normalizeTime(row[1] ?? '') ?? '00:00';
    const type = row[2]?.trim();
    const amount = parseNum(row[3]);
    // FIX (2.5): pusty string zamiast NULL — inaczej unikalny indeks nie dziala.
    const externalId = row[4]?.trim() || '';

    if (!date || !type || amount == null) continue;

    await db
      .insert(walletTransactions)
      .values({ telegramId: TELEGRAM_ID, date, time, type, amount: amount.toFixed(2), externalId, source: 'IMPORT' })
      .onConflictDoNothing();
    imported++;
  }
  console.log(`✅ Zaimportowano ${imported} transakcji z portfel.csv`);
}

async function run(): Promise<void> {
  console.log(`🚀 Import danych dla telegram_id=${TELEGRAM_ID}…`);
  // Klucze obce wymagaja istniejacego uzytkownika (4.2).
  await ensureUserById(TELEGRAM_ID);

  await importDane();
  await importNapiwki();
  await importPortfel();

  console.log('🎉 Migracja zakończona.');
  await closeDb();
}

run().catch(async (err) => {
  console.error('❌ Błąd podczas importu:', err);
  await closeDb().catch(() => {});
  process.exit(1);
});
```

# Plik: src/scripts/make-codebase.mjs
````javascript
#!/usr/bin/env node
/**
 * Skleja cały kod projektu w jeden plik markdown do udostępnienia.
 *
 *   npm run codebase              -> codebase.md
 *   npm run codebase -- out.md    -> out.md
 *
 * Lista plików pochodzi z `git ls-files`, więc automatycznie respektuje
 * .gitignore — node_modules, dist i .env nigdy tu nie trafią. Bez gita
 * skrypt przechodzi na własne przeszukiwanie katalogów z tą samą listą
 * wykluczeń.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

const OUTPUT = process.argv[2] ?? 'codebase.md';

/** Katalogi pomijane zawsze — także gdy ktoś je omyłkowo doda do gita. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'drizzle/meta', 'data', 'backups']);

/** Pliki bez wartości dla czytającego kod albo wprost niebezpieczne. */
const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.env', 'codebase.md']);

/** Binaria i zasoby — wrzucenie ich zaśmieciłoby plik. */
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
  '.pdf', '.zip', '.gz', '.gpg', '.woff', '.woff2', '.ttf',
  '.mp3', '.ogg', '.mp4', '.xlsx', '.docx',
]);

const LANG = {
  '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.mjs': 'javascript',
  '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml', '.sh': 'bash',
  '.sql': 'sql', '.md': 'markdown', '.env': 'ini', '.txt': 'text',
};

function languageFor(path) {
  const name = path.split('/').pop() ?? '';
  if (name === 'Dockerfile' || name.startsWith('Dockerfile.')) return 'dockerfile';
  if (name === '.gitignore' || name === '.dockerignore') return 'gitignore';
  if (name.startsWith('.env')) return 'ini';
  return LANG[extname(name)] ?? '';
}

function shouldSkip(path) {
  const parts = path.split('/');
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;
  if (SKIP_DIRS.has(parts.slice(0, 2).join('/'))) return true;
  if (SKIP_FILES.has(parts.at(-1))) return true;
  if (SKIP_EXT.has(extname(path).toLowerCase())) return true;
  return false;
}

function listFromGit() {
  try {
    const out = execFileSync('git', ['ls-files'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

function listFromDisk(dir = '.', acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative('.', full).split(sep).join('/');
    if (shouldSkip(rel)) continue;
    if (entry.isDirectory()) listFromDisk(full, acc);
    else if (entry.isFile()) acc.push(rel);
  }
  return acc;
}

/** Najpierw konfiguracja i dokumentacja, potem kod — czyta się w tej kolejności. */
const ORDER = ['README', 'package.json', 'tsconfig.json', 'docker-compose.yml', 'Dockerfile', '.env.example'];

function sortKey(path) {
  const idx = ORDER.findIndex((prefix) => path === prefix || path.startsWith(prefix));
  if (idx !== -1) return [0, idx, path];
  if (path.startsWith('src/')) return [1, 0, path];
  if (path.startsWith('docker/')) return [2, 0, path];
  if (path.startsWith('drizzle/')) return [3, 0, path];
  return [4, 0, path];
}

const files = (listFromGit() ?? listFromDisk())
  .filter((f) => !shouldSkip(f))
  .sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || String(ka[2]).localeCompare(String(kb[2]));
  });

const chunks = [];
let totalLines = 0;

for (const file of files) {
  let content;
  try {
    content = readFileSync(file, 'utf-8');
  } catch {
    continue; // plik binarny albo bez uprawnien
  }
  if (content.includes('\0')) continue; // binarium mimo rozszerzenia

  const lines = content.split('\n').length;
  totalLines += lines;

  // Jesli plik sam zawiera ``` , uzywamy dluzszego ogrodzenia, zeby go nie urwac.
  const fence = content.includes('```') ? '````' : '```';

  chunks.push(`\n\n# Plik: ${file}\n${fence}${languageFor(file)}\n${content.replace(/\s*$/, '')}\n${fence}`);
}

const header = [
  '# GlovoBot — kod źródłowy',
  '',
  `Plików: ${files.length} · linii: ${totalLines.toLocaleString('pl-PL')}`,
  '',
  '## Struktura',
  '',
  '```',
  ...files,
  '```',
].join('\n');

writeFileSync(OUTPUT, header + chunks.join('') + '\n');

const kb = Math.round(statSync(OUTPUT).size / 1024);
console.log(`✅ ${OUTPUT} — ${files.length} plików, ${totalLines.toLocaleString('pl-PL')} linii, ${kb} KB`);
````

# Plik: src/server.ts
```typescript
import { createHash } from 'node:crypto';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { Telegraf } from 'telegraf';
import { CFG } from './config.js';
import { geminiQueue } from './services/gemini.service.js';

/**
 * Tryb webhook.
 *
 * Long polling wymaga, zeby dokladnie jedna instancja odpytywala `getUpdates`.
 * Przy `docker compose up --build` stary kontener potrafi jeszcze chwile zyc
 * obok nowego i wtedy Telegram zwraca 409 Conflict, a czesc wiadomosci ginie.
 * Webhook nie ma tego problemu: Telegram sam puka pod adres, ktory dostal.
 *
 * Ruch wchodzi przez Cloudflare Tunnel, wiec kontener nie wystawia
 * zadnego portu na zewnatrz — tunel siega go po sieci Dockera.
 */

/**
 * Sciezka webhooka. Domyslnie wyprowadzona z tokenu bota, wiec jest
 * nieodgadywalna bez jego znajomosci i stabilna miedzy restartami.
 */
export function webhookPath(botToken: string): string {
  if (process.env.WEBHOOK_PATH) {
    return process.env.WEBHOOK_PATH.startsWith('/')
      ? process.env.WEBHOOK_PATH
      : `/${process.env.WEBHOOK_PATH}`;
  }
  return `/tg/${createHash('sha256').update(botToken).digest('hex').slice(0, 32)}`;
}

/**
 * Sekret przekazywany w naglowku `X-Telegram-Bot-Api-Secret-Token`.
 * Telegraf odrzuca zadania bez niego, wiec nawet ktos, kto zgadnie sciezke,
 * nie wstrzyknie botowi falszywego update'u.
 */
export function webhookSecret(botToken: string): string {
  return (
    process.env.WEBHOOK_SECRET ||
    createHash('sha256').update(`webhook-secret:${botToken}`).digest('hex').slice(0, 48)
  );
}

interface HealthPayload {
  status: 'ok';
  mode: 'webhook';
  uptimeSeconds: number;
  gemini: { running: number; pending: number };
}

function healthPayload(): HealthPayload {
  return {
    status: 'ok',
    mode: 'webhook',
    uptimeSeconds: Math.round(process.uptime()),
    gemini: { running: geminiQueue.running, pending: geminiQueue.pending },
  };
}

/**
 * Serwer HTTP obslugujacy webhook i endpoint zdrowia.
 * `/healthz` uzywa go healthcheck Dockera oraz Cloudflare — dzieki temu
 * tunel nie kieruje ruchu do kontenera, ktory jeszcze nie wstal.
 */
export async function startWebhookServer(bot: Telegraf, botToken: string): Promise<Server> {
  const domain = CFG.WEBHOOK_DOMAIN;
  if (!domain) throw new Error('startWebhookServer wywołane bez WEBHOOK_DOMAIN');

  const path = webhookPath(botToken);
  const secretToken = webhookSecret(botToken);

  // createWebhook rejestruje adres w Telegramie i zwraca handler HTTP.
  const telegrafHandler = await bot.createWebhook({
    domain,
    path,
    secret_token: secretToken,
    drop_pending_updates: process.env.WEBHOOK_DROP_PENDING === 'true',
    // Bot nie reaguje na nic poza tym, wiec nie ma po co odbierac reszty.
    allowed_updates: ['message', 'edited_message', 'callback_query'],
    max_connections: CFG.WEBHOOK_MAX_CONNECTIONS,
  });

  const handler: RequestListener = (req, res) => {
    if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/health')) {
      const body = JSON.stringify(healthPayload());
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    if (req.url === path) {
      telegrafHandler(req, res);
      return;
    }

    // Skanery trafiajace na losowe sciezki nie maja sie czego dowiedziec.
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  };

  const server = createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(CFG.WEBHOOK_PORT, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });

  console.log(`🌐 Webhook: https://${domain}${path}`);
  console.log(`🩺 Health:  http://0.0.0.0:${CFG.WEBHOOK_PORT}/healthz`);

  return server;
}

export async function stopWebhookServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
```

# Plik: src/services/finance.calc.test.ts
```typescript
import { describe, expect, it } from 'vitest';
import {
  computeDailyTotals,
  computeOfferRate,
  partitionNewTransactions,
  sumWalletPayouts,
  walletBalanceFrom,
  walletKey,
} from './finance.calc.js';

describe('computeDailyTotals (FIX 2.4)', () => {
  it('napiwki wchodzą do zarobku, ale NIE do przelewu', () => {
    const totals = computeDailyTotals({
      grossEarnings: 400,
      cashTipsTotal: 50,
      walletPayouts: 0,
      workHours: 8,
    });

    expect(totals.netEarnings).toBe(325.6); // 400 × 0.814
    expect(totals.totalNetto).toBe(375.6); // + 50 napiwków
    expect(totals.doPrzelewu).toBe(325.6); // napiwki są gotówkowe
  });

  it('wypłaty z portfela pomniejszają to, co jeszcze przyjdzie', () => {
    const totals = computeDailyTotals({
      grossEarnings: 400,
      cashTipsTotal: 0,
      walletPayouts: 100,
      workHours: 0,
    });
    expect(totals.doPrzelewu).toBe(225.6);
  });

  it('ujemne do przelewu jest widoczne, nie ucinane do zera', () => {
    const totals = computeDailyTotals({
      grossEarnings: 100,
      cashTipsTotal: 0,
      walletPayouts: 250,
      workHours: 0,
    });
    expect(totals.doPrzelewu).toBeLessThan(0);
    expect(totals.doPrzelewu).toBe(-168.6);
  });

  it('stawka godzinowa liczy się z całego zarobku netto', () => {
    const totals = computeDailyTotals({
      grossEarnings: 400,
      cashTipsTotal: 50,
      walletPayouts: 0,
      workHours: 8,
    });
    expect(totals.hourlyRateNetto).toBe(46.95);
  });

  it('zero godzin nie wywala dzielenia', () => {
    expect(computeDailyTotals({ grossEarnings: 0, cashTipsTotal: 0, walletPayouts: 0, workHours: 0 })).toEqual({
      netEarnings: 0,
      totalNetto: 0,
      doPrzelewu: 0,
      hourlyRateNetto: 0,
    });
  });
});

describe('saldo portfela (FIX 2.2)', () => {
  const txs = [
    { type: 'pobranie', amount: '63.34' },
    { type: 'pobranie', amount: '35.99' },
    { type: 'wyplata', amount: '-174.89' },
    { type: 'wyplata_gotowka', amount: '-100.00' },
    { type: 'platnosc_punkt', amount: '-255.69' },
    { type: 'korekta', amount: '-2.78' },
  ];

  it('saldo to suma kwot ze znakiem', () => {
    expect(walletBalanceFrom(txs)).toBe(-434.03);
  });

  it('wypłaty to tylko wyplata i wyplata_gotowka', () => {
    // platnosc_punkt i pobranie nie wchodzą do rozliczenia dnia.
    expect(sumWalletPayouts(txs)).toBe(274.89);
  });
});

describe('deduplikacja transakcji (FIX 2.5 / 2.6)', () => {
  const tx = (over: Partial<Parameters<typeof walletKey>[0]> = {}) => ({
    date: '2026-08-11',
    time: '15:50',
    type: 'pobranie',
    amount: 63.34,
    externalId: '101735350998',
    ...over,
  });

  it('rozpoznaje transakcję już zapisaną w bazie', () => {
    const existing = new Set([walletKey(tx())]);
    const result = partitionNewTransactions([tx()], existing);
    expect(result.newItems).toHaveLength(0);
    expect(result.duplicates).toBe(1);
  });

  it('transakcje bez externalId też są deduplikowane', () => {
    // Wcześniej pusty externalId był NULL-em, a NULL != NULL w Postgresie,
    // więc unikalny indeks w ogóle nie blokował duplikatów.
    const noId = tx({ externalId: '' });
    const existing = new Set([walletKey(noId)]);
    expect(partitionNewTransactions([noId], existing).duplicates).toBe(1);
  });

  it('wyłapuje powtórzenia w obrębie jednego zrzutu', () => {
    const result = partitionNewTransactions([tx(), tx(), tx({ amount: 10 })], new Set());
    expect(result.newItems).toHaveLength(2);
    expect(result.duplicates).toBe(1);
  });

  it('różna kwota to inna transakcja', () => {
    const existing = new Set([walletKey(tx())]);
    const result = partitionNewTransactions([tx({ amount: 63.35 })], existing);
    expect(result.newItems).toHaveLength(1);
  });

  it('delta salda liczy tylko nowe pozycje', () => {
    const existing = new Set([walletKey(tx())]);
    const result = partitionNewTransactions([tx(), tx({ amount: -50, externalId: 'x' })], existing);
    expect(result.totalDelta).toBe(-50);
  });
});

describe('computeOfferRate (FIX 2.3)', () => {
  it('stawka liczona z całej trasy, nie z samego dojazdu', () => {
    // 20 zł brutto, dojazd 2 km + dostawa 6 km = 8 km.
    const rate = computeOfferRate({ grossAmount: 20, totalKm: 8 });
    expect(rate.netAmount).toBe(16.28);
    expect(rate.netRatePerKm).toBe(2.04);
    expect(rate.isProfitable).toBe(true);
  });

  it('licząc tylko dojazd stawka byłaby zawyżona czterokrotnie', () => {
    const onlyPickup = computeOfferRate({ grossAmount: 20, totalKm: 2 });
    expect(onlyPickup.netRatePerKm).toBe(8.14);
  });

  it('zerowy dystans nie jest opłacalnym kursem', () => {
    const rate = computeOfferRate({ grossAmount: 20, totalKm: 0 });
    expect(rate.netRatePerKm).toBe(0);
    expect(rate.isProfitable).toBe(false);
  });

  it('kurs poniżej progu jest odrzucany', () => {
    expect(computeOfferRate({ grossAmount: 10, totalKm: 8 }).isProfitable).toBe(false);
  });
});
```

# Plik: src/services/finance.calc.ts
```typescript
import { CFG } from '../config.js';

/**
 * Czysta arytmetyka rozliczen — bez bazy, w calosci testowalna.
 * `finance.service.ts` tylko dostarcza tu dane z Postgresa.
 */

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export const WALLET_PAYOUT_TYPES = ['wyplata', 'wyplata_gotowka'] as const;

export interface DailyTotalsInput {
  grossEarnings: number;
  cashTipsTotal: number;
  walletPayouts: number;
  workHours: number;
}

export interface DailyTotals {
  netEarnings: number;
  totalNetto: number;
  doPrzelewu: number;
  hourlyRateNetto: number;
}

/**
 * Model rozliczenia (2.4) — zapisany wprost, zeby nie trzeba go bylo
 * odtwarzac z jednego dlugiego wyrazenia:
 *
 *   netEarnings  = brutto ze zlecen × NETTO_FACTOR      (trafi na konto)
 *   cashTips     = napiwki gotowkowe                    (juz w kieszeni)
 *   totalNetto   = netEarnings + cashTips               (ile kurier zarobil)
 *   walletPayouts= wyplata + wyplata_gotowka            (juz wyszlo z portfela)
 *   doPrzelewu   = netEarnings - walletPayouts          (co jeszcze przyjdzie)
 *
 * Napiwki NIE wchodza do `doPrzelewu`, bo sa gotowkowe i nikt ich nie przeleje.
 * Stary wzor dodawal je do `totalNetto` i zaraz odejmowal — wychodzilo to samo,
 * ale nie dalo sie tego przeczytac.
 *
 * `pobranie` i `platnosc_punkt` nie wystepuja tutaj w ogole: pierwsze tylko
 * podnosi saldo portfela, drugie tylko je obniza.
 *
 * Brak `Math.max(0, ...)` — ujemny wynik ma byc widoczny.
 */
export function computeDailyTotals(input: DailyTotalsInput): DailyTotals {
  const netEarnings = round2(input.grossEarnings * CFG.NETTO_FACTOR);
  const totalNetto = round2(netEarnings + input.cashTipsTotal);
  const doPrzelewu = round2(netEarnings - input.walletPayouts);

  return {
    netEarnings,
    totalNetto,
    doPrzelewu,
    hourlyRateNetto: input.workHours > 0 ? round2(totalNetto / input.workHours) : 0,
  };
}

/** Suma wyplat (gotowkowych i przelewem) z listy transakcji portfela. */
export function sumWalletPayouts(txs: Array<{ type: string; amount: string | number }>): number {
  let total = 0;
  for (const tx of txs) {
    if ((WALLET_PAYOUT_TYPES as readonly string[]).includes(tx.type)) {
      total += Math.abs(typeof tx.amount === 'string' ? parseFloat(tx.amount) : tx.amount);
    }
  }
  return round2(total);
}

/**
 * Saldo portfela = suma kwot ZE ZNAKIEM (2.2).
 * pobranie (+), wyplata (-), wyplata_gotowka (-), platnosc_punkt (-), korekta (+/-).
 */
export function walletBalanceFrom(txs: Array<{ amount: string | number }>): number {
  let total = 0;
  for (const tx of txs) {
    total += typeof tx.amount === 'string' ? parseFloat(tx.amount) : tx.amount;
  }
  return round2(total);
}

export interface WalletKeyParts {
  date: string;
  time: string;
  type: string;
  amount: number;
  externalId: string;
}

/**
 * Klucz deduplikacji (2.5).
 * MUSI zawierac dokladnie te kolumny co unikalny indeks `wallet_tx_dedup_idx`,
 * inaczej podglad importu i baza maja dwie rozne definicje "tej samej transakcji".
 */
export function walletKey(t: WalletKeyParts): string {
  return [t.date, t.time, t.type, t.amount.toFixed(2), t.externalId].join('|');
}

export interface PartitionResult<T> {
  newItems: T[];
  duplicates: number;
  totalDelta: number;
}

/**
 * Dzieli transakcje ze zrzutu na nowe i duplikaty.
 * Wykrywa takze powtorzenia w obrebie samego zrzutu.
 */
export function partitionNewTransactions<T extends WalletKeyParts>(
  incoming: T[],
  existingKeys: ReadonlySet<string>
): PartitionResult<T> {
  const seen = new Set<string>();
  const newItems: T[] = [];
  let duplicates = 0;
  let totalDelta = 0;

  for (const item of incoming) {
    const key = walletKey(item);
    if (existingKeys.has(key) || seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    newItems.push(item);
    totalDelta += item.amount;
  }

  return { newItems, duplicates, totalDelta: round2(totalDelta) };
}

export interface OfferRateInput {
  grossAmount: number;
  totalKm: number;
}

export interface OfferRate {
  netAmount: number;
  netRatePerKm: number;
  isProfitable: boolean;
}

/** Stawka kursu liczona z CALEJ trasy (dojazd + dostawa) — patrz 2.3. */
export function computeOfferRate(input: OfferRateInput): OfferRate {
  const netAmount = round2(input.grossAmount * CFG.NETTO_FACTOR);
  const netRatePerKm = input.totalKm > 0 ? round2(netAmount / input.totalKm) : 0;
  return {
    netAmount,
    netRatePerKm,
    isProfitable: input.totalKm > 0 && netRatePerKm >= CFG.MIN_STAWKA_NETTO_KM,
  };
}
```

# Plik: src/services/finance.service.ts
```typescript
import { db } from '../db/index.js';
import {
  dailyRecords,
  cashTips,
  fuelReceipts,
  walletTransactions,
  courseOffers,
  earningTargets,
} from '../db/schema.js';
import { eq, and, gte, lte, inArray, sql, desc } from 'drizzle-orm';
import { CFG } from '../config.js';
import {
  todayWarsaw,
  nowTimeWarsaw,
  addDays,
  daysInMonth,
  isoDayOfWeek,
  isoWeek,
  isValidDateStr,
  normalizeTime,
  splitDate,
  weekRange,
  weekRangeFor,
  calculateHours,
  type DateRange,
} from '../utils/datetime.js';
import {
  computeDailyTotals,
  partitionNewTransactions,
  round2,
  sumWalletPayouts,
  walletKey,
} from './finance.calc.js';
import type { VoiceExtractedData, WalletTransactionItem } from './gemini.service.js';

export interface DailySummary {
  date: string;
  grossEarnings: number;
  netEarnings: number;
  cashTipsTotal: number;
  totalNetto: number;
  walletPayouts: number;
  doPrzelewu: number;
  workFrom: string | null;
  workTo: string | null;
  workHours: number;
  hourlyRateNetto: number;
  fuelCost: number;
  fuelLiters: number;
  fuelPricePerLiter: number | null;
  fuelReceiptCount: number;
  distanceKm: number | null;
}

export interface PeriodSummary extends DateRange {
  totalGross: number;
  totalNettoEarnings: number;
  totalCashTips: number;
  grandTotalNetto: number;
  totalWalletPayouts: number;
  totalDoPrzelewu: number;
  totalWorkHours: number;
  avgHourlyRateNetto: number;
  totalFuelCost: number;
  totalFuelLiters: number;
  avgPricePerLiter: number | null;
  totalDistanceKm: number;
}

export interface TargetProgress {
  periodType: 'MONTHLY' | 'WEEKLY';
  targetAmount: number;
  currentNetto: number;
  remainingNetto: number;
  progressPercent: number;
  daysRemaining: number;
  dailyRequiredNetto: number;
  avgHourlyRate: number;
  usedFallbackRate: boolean;
  estimatedHoursRemaining: number;
  hoursPerDayRequired: number;
  isCompleted: boolean;
}

export interface CourseOfferStats {
  date: string;
  totalOffers: number;
  profitable: number;
  unprofitable: number;
  accepted: number;
  rejected: number;
  pending: number;
  /** Srednia arytmetyczna stawek pojedynczych ofert - "jakie oferty przychodza". */
  avgNetRatePerKm: number | null;
  /** Suma netto / suma km - "ile realnie wychodzi na kilometr". */
  weightedNetRatePerKm: number | null;
  bestNetRate: number | null;
  worstNetRate: number | null;
  totalGross: number;
  totalDistanceKm: number;
}

export interface WalletImportPreview {
  newTransactions: WalletTransactionItem[];
  existingCount: number;
  totalAmountDelta: number;
  dates: string[];
}

const num = (v: string | null | undefined): number => (v ? parseFloat(v) : 0);
const numOrNull = (v: string | null | undefined): number | null => (v ? parseFloat(v) : null);

export class FinanceService {
  // --- Daty -----------------------------------------------------------------

  /**
   * Data, do ktorej trafiaja wpisy robione "teraz".
   *
   * FIX (2.1): to po prostu dzisiejsza data kalendarzowa w Europe/Warsaw.
   * Doba konczy sie o polnocy - wpis o 01:00 nalezy do nowego dnia.
   * Poprzednia wersja mieszala `getHours()` (czas lokalny serwera) z
   * `toISOString()` (UTC) i na serwerze w UTC cofala date w godzinach 04:00-06:00.
   */
  getEffectiveDate(): string {
    return todayWarsaw();
  }

  resolveTargetDate(targetDateStr?: string | null): string {
    if (!targetDateStr) return this.getEffectiveDate();

    const upper = targetDateStr.trim().toUpperCase();
    if (['TODAY', 'DZISIAJ', 'DZIS', 'DZIŚ'].includes(upper)) return this.getEffectiveDate();
    if (['YESTERDAY', 'WCZORAJ'].includes(upper)) return addDays(this.getEffectiveDate(), -1);
    if (isValidDateStr(targetDateStr)) return targetDateStr;

    return this.getEffectiveDate();
  }

  getWeekRange(offsetWeeks = 0): DateRange {
    return weekRange(this.getEffectiveDate(), offsetWeeks);
  }

  // --- Zmiana ---------------------------------------------------------------

  async setShiftStart(
    telegramId: string | number,
    date: string,
    workFrom: string
  ): Promise<{ summary: DailySummary; hoursError: string | null }> {
    const tId = String(telegramId);
    const from = normalizeTime(workFrom);
    if (!from) throw new Error('Nieprawidłowy format godziny wyjazdu.');

    const existing = await this.getDailyRecord(tId, date);

    let hours: number | null = null;
    let hoursError: string | null = null;
    if (existing?.workTo) {
      const res = calculateHours(from, existing.workTo);
      hours = res.hours;
      hoursError = res.error;
    }

    await db
      .insert(dailyRecords)
      .values({
        telegramId: tId,
        date,
        workFrom: from,
        workTo: existing?.workTo ?? null,
        workHours: hours !== null ? hours.toFixed(2) : null,
      })
      .onConflictDoUpdate({
        target: [dailyRecords.telegramId, dailyRecords.date],
        set: {
          workFrom: from,
          // Godziny przeliczamy zawsze gdy da sie je policzyc - takze na null,
          // zeby po poprawce wyjazdu nie zostawala stara, nieaktualna wartosc.
          ...(existing?.workTo ? { workHours: hours !== null ? hours.toFixed(2) : null } : {}),
        },
      });

    return { summary: await this.getDailySummary(tId, date), hoursError };
  }

  async setShiftEnd(
    telegramId: string | number,
    date: string,
    data: { workTo?: string | null; distanceKm?: number | null }
  ): Promise<{ summary: DailySummary; hoursError: string | null }> {
    const tId = String(telegramId);
    const existing = await this.getDailyRecord(tId, date);

    const workFrom = existing?.workFrom ?? null;
    const workTo = data.workTo ? normalizeTime(data.workTo) : (existing?.workTo ?? null);
    if (data.workTo && !workTo) throw new Error('Nieprawidłowy format godziny zjazdu.');

    let hours: number | null = existing?.workHours ? parseFloat(existing.workHours) : null;
    let hoursError: string | null = null;
    if (workFrom && workTo) {
      const res = calculateHours(workFrom, workTo);
      hours = res.hours;
      hoursError = res.error;
    }

    await db
      .insert(dailyRecords)
      .values({
        telegramId: tId,
        date,
        workFrom,
        workTo,
        workHours: hours !== null ? hours.toFixed(2) : null,
        distanceKm: data.distanceKm != null ? data.distanceKm.toFixed(2) : null,
      })
      .onConflictDoUpdate({
        target: [dailyRecords.telegramId, dailyRecords.date],
        set: {
          ...(workTo ? { workTo } : {}),
          ...(workFrom && workTo ? { workHours: hours !== null ? hours.toFixed(2) : null } : {}),
          ...(data.distanceKm != null ? { distanceKm: data.distanceKm.toFixed(2) } : {}),
        },
      });

    return { summary: await this.getDailySummary(tId, date), hoursError };
  }

  private async getDailyRecord(tId: string, date: string) {
    const [record] = await db
      .select()
      .from(dailyRecords)
      .where(and(eq(dailyRecords.telegramId, tId), eq(dailyRecords.date, date)))
      .limit(1);
    return record;
  }

  // --- Napiwki i paliwo -----------------------------------------------------

  async saveCashTip(telegramId: string | number, date: string, amount: number): Promise<void> {
    await db.insert(cashTips).values({
      telegramId: String(telegramId),
      date,
      amount: amount.toFixed(2),
    });
  }

  /**
   * FIX (2.8): kazdy paragon to osobny wiersz. Drugie tankowanie tego samego dnia
   * dodaje sie do sumy zamiast nadpisywac pierwsze.
   * FIX (5.3): trzymamy koszt calosci ORAZ cene za litr.
   */
  async saveFuelReceipt(
    telegramId: string | number,
    date: string,
    data: { totalCost: number; liters?: number | null; pricePerLiter?: number | null }
  ): Promise<void> {
    const liters = data.liters ?? null;
    const pricePerLiter =
      data.pricePerLiter ?? (liters && liters > 0 ? round2(data.totalCost / liters) : null);

    await db.insert(fuelReceipts).values({
      telegramId: String(telegramId),
      date,
      totalCost: data.totalCost.toFixed(2),
      liters: liters != null ? liters.toFixed(2) : null,
      pricePerLiter: pricePerLiter != null ? pricePerLiter.toFixed(3) : null,
    });
  }

  async setDailyDistance(telegramId: string | number, date: string, distanceKm: number): Promise<void> {
    const tId = String(telegramId);
    await db
      .insert(dailyRecords)
      .values({ telegramId: tId, date, distanceKm: distanceKm.toFixed(2) })
      .onConflictDoUpdate({
        target: [dailyRecords.telegramId, dailyRecords.date],
        set: { distanceKm: distanceKm.toFixed(2) },
      });
  }

  async setGrossEarnings(telegramId: string | number, date: string, gross: number): Promise<void> {
    const tId = String(telegramId);
    await db
      .insert(dailyRecords)
      .values({ telegramId: tId, date, grossEarnings: gross.toFixed(2) })
      .onConflictDoUpdate({
        target: [dailyRecords.telegramId, dailyRecords.date],
        set: { grossEarnings: gross.toFixed(2) },
      });
  }

  // --- Portfel Glovo --------------------------------------------------------

  /**
   * FIX (2.2): saldo to po prostu suma kwot wszystkich transakcji.
   * Nie ma juz tabeli `balance_checkpoints`, ktora dublowala transakcje z dnia
   * checkpointu (warunek `gte` obejmowal takze operacje sprzed jego zapisania).
   *
   * Znaki: pobranie (+), wyplata (-), wyplata_gotowka (-), platnosc_punkt (-), korekta (+/-).
   */
  async getWalletBalance(
    telegramId: string | number,
    toDate?: string
  ): Promise<{ balance: number; transactionCount: number; lastDate: string | null }> {
    const tId = String(telegramId);
    const conditions = [eq(walletTransactions.telegramId, tId)];
    if (toDate) conditions.push(lte(walletTransactions.date, toDate));

    const [row] = await db
      .select({
        total: sql<string>`coalesce(sum(${walletTransactions.amount}), 0)`,
        count: sql<number>`count(*)::int`,
        lastDate: sql<string | null>`max(${walletTransactions.date})`,
      })
      .from(walletTransactions)
      .where(and(...conditions));

    return {
      balance: round2(num(row?.total)),
      transactionCount: row?.count ?? 0,
      lastDate: row?.lastDate ?? null,
    };
  }

  /**
   * Reczne wyrownanie salda do podanej wartosci.
   * Zapisuje sie jako transakcja 'korekta', wiec saldo dalej jest wylacznie
   * suma transakcji, a historia pozostaje audytowalna.
   */
  async adjustWalletBalance(
    telegramId: string | number,
    date: string,
    targetBalance: number
  ): Promise<{ delta: number; balance: number }> {
    const tId = String(telegramId);
    const { balance: current } = await this.getWalletBalance(tId);
    const delta = round2(targetBalance - current);

    if (Math.abs(delta) >= 0.01) {
      await db
        .insert(walletTransactions)
        .values({
          telegramId: tId,
          date,
          time: nowTimeWarsaw(),
          type: 'korekta',
          amount: delta.toFixed(2),
          externalId: `manual-${Date.now()}`,
          source: 'MANUAL',
        })
        .onConflictDoNothing();
    }

    return { delta, balance: targetBalance };
  }

  /**
   * FIX (2.6): jedno zapytanie zamiast N.
   * FIX (2.5): klucz porownania jest identyczny z kolumnami unikalnego indeksu.
   */
  async previewWalletImport(
    telegramId: string | number,
    transactions: WalletTransactionItem[]
  ): Promise<WalletImportPreview> {
    const tId = String(telegramId);

    const normalized = transactions.map((t) => ({
      ...t,
      time: normalizeTime(t.time) ?? t.time,
      externalId: t.externalId ?? '',
    }));

    const dates = Array.from(new Set(normalized.map((t) => t.date))).sort();
    if (dates.length === 0) {
      return { newTransactions: [], existingCount: 0, totalAmountDelta: 0, dates: [] };
    }

    const existingRows = await db
      .select({
        date: walletTransactions.date,
        time: walletTransactions.time,
        type: walletTransactions.type,
        amount: walletTransactions.amount,
        externalId: walletTransactions.externalId,
      })
      .from(walletTransactions)
      .where(and(eq(walletTransactions.telegramId, tId), inArray(walletTransactions.date, dates)));

    const existingKeys = new Set(
      existingRows.map((r) =>
        walletKey({
          date: r.date,
          time: r.time,
          type: r.type,
          amount: parseFloat(r.amount),
          externalId: r.externalId,
        })
      )
    );

    const { newItems, duplicates, totalDelta } = partitionNewTransactions(normalized, existingKeys);

    return {
      newTransactions: newItems,
      existingCount: duplicates,
      totalAmountDelta: totalDelta,
      dates,
    };
  }

  async saveWalletTransactions(
    telegramId: string | number,
    transactions: WalletTransactionItem[]
  ): Promise<{ added: number; skipped: number; dates: string[]; balance: number }> {
    const tId = String(telegramId);
    const preview = await this.previewWalletImport(tId, transactions);

    if (preview.newTransactions.length > 0) {
      await db
        .insert(walletTransactions)
        .values(
          preview.newTransactions.map((t) => ({
            telegramId: tId,
            date: t.date,
            time: t.time,
            type: t.type,
            amount: t.amount.toFixed(2),
            externalId: t.externalId ?? '',
            source: 'OCR',
          }))
        )
        // FIX (2.5): przy dwoch zrzutach pod rzad wyscig nie wywala juz handlera.
        .onConflictDoNothing();
    }

    const { balance } = await this.getWalletBalance(tId);

    return {
      added: preview.newTransactions.length,
      skipped: preview.existingCount,
      dates: preview.dates,
      balance,
    };
  }

  // --- Oferty kursow --------------------------------------------------------

  async saveCourseOffer(
    telegramId: string | number,
    data: {
      grossAmount: number;
      netAmount: number;
      appPickupKm: number | null;
      appDeliveryKm: number | null;
      appTotalKm: number | null;
      mapsPickupKm: number | null;
      mapsDeliveryKm: number | null;
      mapsTotalKm: number | null;
      distanceTotalKm: number;
      rateBasis: 'APP' | 'MAPS' | 'NONE';
      netRatePerKm: number;
      isProfitable: boolean;
      pickupAddress: string;
      deliveryAddress: string;
    }
  ): Promise<number> {
    const dec = (v: number | null): string | null => (v != null ? v.toFixed(2) : null);

    const [inserted] = await db
      .insert(courseOffers)
      .values({
        telegramId: String(telegramId),
        date: this.getEffectiveDate(),
        time: nowTimeWarsaw(),
        grossAmount: data.grossAmount.toFixed(2),
        netAmount: data.netAmount.toFixed(2),
        appPickupKm: dec(data.appPickupKm),
        appDeliveryKm: dec(data.appDeliveryKm),
        appTotalKm: dec(data.appTotalKm),
        mapsPickupKm: dec(data.mapsPickupKm),
        mapsDeliveryKm: dec(data.mapsDeliveryKm),
        mapsTotalKm: dec(data.mapsTotalKm),
        distanceTotalKm: data.distanceTotalKm.toFixed(2),
        rateBasis: data.rateBasis,
        netRatePerKm: data.netRatePerKm.toFixed(2),
        isProfitable: data.isProfitable,
        status: 'PENDING',
        pickupAddress: data.pickupAddress,
        deliveryAddress: data.deliveryAddress,
      })
      .returning({ id: courseOffers.id });

    if (!inserted) throw new Error('Błąd zapisu oferty kursu.');
    return inserted.id;
  }

  /**
   * FIX (3.7): zwraca zaktualizowany wiersz (albo null), zeby bot mial
   * z czego przerysowac karte i nie potwierdzal zapisu, ktorego nie bylo.
   */
  async updateCourseOfferStatus(
    offerId: number,
    telegramId: string | number,
    status: 'ACCEPTED' | 'REJECTED'
  ): Promise<typeof courseOffers.$inferSelect | null> {
    const [updated] = await db
      .update(courseOffers)
      .set({ status })
      .where(and(eq(courseOffers.id, offerId), eq(courseOffers.telegramId, String(telegramId))))
      .returning();

    return updated ?? null;
  }

  // --- Wpisy glosowe --------------------------------------------------------

  async saveVoiceEvent(
    telegramId: string | number,
    data: VoiceExtractedData
  ): Promise<{ date: string; hasDailyUpdate: boolean; hasTip: boolean; hasFuel: boolean; hoursError: string | null }> {
    const tId = String(telegramId);
    const date = this.resolveTargetDate(data.targetDate);
    let hasDailyUpdate = false;
    let hasTip = false;
    let hasFuel = false;
    let hoursError: string | null = null;

    if (data.cashTip != null && data.cashTip > 0) {
      await this.saveCashTip(tId, date, data.cashTip);
      hasTip = true;
    }

    if (data.fuelTotalCost != null && data.fuelTotalCost > 0) {
      await this.saveFuelReceipt(tId, date, {
        totalCost: data.fuelTotalCost,
        liters: data.fuelLiters,
        pricePerLiter: data.fuelPricePerLiter,
      });
      hasFuel = true;
    }

    const workFrom = data.workFrom ? normalizeTime(data.workFrom) : null;
    const workTo = data.workTo ? normalizeTime(data.workTo) : null;

    let hours: number | null = null;
    if (workFrom && workTo) {
      const res = calculateHours(workFrom, workTo);
      hours = res.hours;
      hoursError = res.error;
    }

    if (data.grossEarnings != null || data.distanceKm != null || workFrom || workTo) {
      hasDailyUpdate = true;
      await db
        .insert(dailyRecords)
        .values({
          telegramId: tId,
          date,
          grossEarnings: data.grossEarnings != null ? data.grossEarnings.toFixed(2) : null,
          distanceKm: data.distanceKm != null ? data.distanceKm.toFixed(2) : null,
          workFrom,
          workTo,
          workHours: hours !== null ? hours.toFixed(2) : null,
        })
        .onConflictDoUpdate({
          target: [dailyRecords.telegramId, dailyRecords.date],
          set: {
            ...(data.grossEarnings != null ? { grossEarnings: data.grossEarnings.toFixed(2) } : {}),
            ...(data.distanceKm != null ? { distanceKm: data.distanceKm.toFixed(2) } : {}),
            ...(workFrom ? { workFrom } : {}),
            ...(workTo ? { workTo } : {}),
            ...(workFrom && workTo ? { workHours: hours !== null ? hours.toFixed(2) : null } : {}),
          },
        });
    }

    return { date, hasDailyUpdate, hasTip, hasFuel, hoursError };
  }

  async handleVoiceDeletion(
    telegramId: string | number,
    target: 'LAST_TIP' | 'ALL_TIPS' | 'FUEL' | 'HOURS' | 'EARNINGS' | 'DISTANCE' | 'ALL_DAY',
    targetDateStr?: string | null
  ): Promise<{ success: boolean; message: string; date: string }> {
    const tId = String(telegramId);
    const date = this.resolveTargetDate(targetDateStr);
    const scope = and(eq(dailyRecords.telegramId, tId), eq(dailyRecords.date, date));

    switch (target) {
      case 'LAST_TIP': {
        const [lastTip] = await db
          .select()
          .from(cashTips)
          .where(and(eq(cashTips.telegramId, tId), eq(cashTips.date, date)))
          .orderBy(desc(cashTips.createdAt), desc(cashTips.id))
          .limit(1);

        if (!lastTip) return { success: false, message: `Brak napiwków do usunięcia z dnia ${date}.`, date };

        await db.delete(cashTips).where(eq(cashTips.id, lastTip.id));
        return {
          success: true,
          message: `Usunięto ostatni napiwek: ${parseFloat(lastTip.amount).toFixed(2)} zł z dnia ${date}.`,
          date,
        };
      }

      case 'ALL_TIPS': {
        const deleted = await db
          .delete(cashTips)
          .where(and(eq(cashTips.telegramId, tId), eq(cashTips.date, date)))
          .returning({ id: cashTips.id });
        if (!deleted.length) return { success: false, message: `Brak napiwków na ${date}.`, date };
        return { success: true, message: `Skasowano wszystkie napiwki (${deleted.length} szt.) z dnia ${date}.`, date };
      }

      case 'FUEL': {
        const deleted = await db
          .delete(fuelReceipts)
          .where(and(eq(fuelReceipts.telegramId, tId), eq(fuelReceipts.date, date)))
          .returning({ id: fuelReceipts.id });
        if (!deleted.length) return { success: false, message: `Brak wpisów paliwowych na ${date}.`, date };
        return { success: true, message: `Usunięto ${deleted.length} paragon(y) paliwowe z dnia ${date}.`, date };
      }

      case 'HOURS': {
        const updated = await db
          .update(dailyRecords)
          .set({ workFrom: null, workTo: null, workHours: null })
          .where(scope)
          .returning({ id: dailyRecords.id });
        return this.deletionResult(updated.length, `czas pracy na ${date}`, date);
      }

      case 'EARNINGS': {
        const updated = await db
          .update(dailyRecords)
          .set({ grossEarnings: null })
          .where(scope)
          .returning({ id: dailyRecords.id });
        return this.deletionResult(updated.length, `zarobek brutto na ${date}`, date);
      }

      case 'DISTANCE': {
        const updated = await db
          .update(dailyRecords)
          .set({ distanceKm: null })
          .where(scope)
          .returning({ id: dailyRecords.id });
        return this.deletionResult(updated.length, `dystans na ${date}`, date);
      }

      case 'ALL_DAY': {
        const removedRecords = await db.delete(dailyRecords).where(scope).returning({ id: dailyRecords.id });
        const removedTips = await db
          .delete(cashTips)
          .where(and(eq(cashTips.telegramId, tId), eq(cashTips.date, date)))
          .returning({ id: cashTips.id });
        const removedFuel = await db
          .delete(fuelReceipts)
          .where(and(eq(fuelReceipts.telegramId, tId), eq(fuelReceipts.date, date)))
          .returning({ id: fuelReceipts.id });

        const total = removedRecords.length + removedTips.length + removedFuel.length;
        if (total === 0) return { success: false, message: `Brak jakichkolwiek danych na ${date}.`, date };
        return {
          success: true,
          message: `Usunięto dzień ${date}: wpis dnia, ${removedTips.length} napiwk(ów), ${removedFuel.length} paragon(ów).`,
          date,
        };
      }

      default:
        return { success: false, message: 'Nie rozpoznano elementu do usunięcia.', date };
    }
  }

  /** Brak zaktualizowanych wierszy = nie bylo czego kasowac. Bez cichego "sukcesu". */
  private deletionResult(count: number, what: string, date: string) {
    return count > 0
      ? { success: true, message: `Wyczyszczono ${what}.`, date }
      : { success: false, message: `Brak wpisu, z którego można wyczyścić ${what}.`, date };
  }

  // --- Raporty --------------------------------------------------------------

  async getDailySummary(telegramId: string | number, date: string): Promise<DailySummary> {
    const tId = String(telegramId);

    const [record, tipsRow, fuelRow, txs] = await Promise.all([
      this.getDailyRecord(tId, date),
      db
        .select({ total: sql<string>`coalesce(sum(${cashTips.amount}), 0)` })
        .from(cashTips)
        .where(and(eq(cashTips.telegramId, tId), eq(cashTips.date, date)))
        .then((r) => r[0]),
      db
        .select({
          cost: sql<string>`coalesce(sum(${fuelReceipts.totalCost}), 0)`,
          liters: sql<string>`coalesce(sum(${fuelReceipts.liters}), 0)`,
          count: sql<number>`count(*)::int`,
        })
        .from(fuelReceipts)
        .where(and(eq(fuelReceipts.telegramId, tId), eq(fuelReceipts.date, date)))
        .then((r) => r[0]),
      db
        .select({ type: walletTransactions.type, amount: walletTransactions.amount })
        .from(walletTransactions)
        .where(and(eq(walletTransactions.telegramId, tId), eq(walletTransactions.date, date))),
    ]);

    // `pobranie` NIE wchodzi do rozliczenia dnia - aktualizuje wylacznie saldo (2.4).
    const walletPayouts = sumWalletPayouts(txs);

    const gross = num(record?.grossEarnings);
    const cashTipsTotal = round2(num(tipsRow?.total));
    const workHours = num(record?.workHours);

    const { netEarnings, totalNetto, doPrzelewu, hourlyRateNetto } = computeDailyTotals({
      grossEarnings: gross,
      cashTipsTotal,
      walletPayouts,
      workHours,
    });

    const fuelCost = round2(num(fuelRow?.cost));
    const fuelLiters = round2(num(fuelRow?.liters));

    return {
      date,
      grossEarnings: gross,
      netEarnings,
      cashTipsTotal,
      totalNetto,
      walletPayouts,
      doPrzelewu,
      workFrom: record?.workFrom ?? null,
      workTo: record?.workTo ?? null,
      workHours,
      hourlyRateNetto,
      fuelCost,
      fuelLiters,
      fuelPricePerLiter: fuelLiters > 0 ? round2(fuelCost / fuelLiters) : null,
      fuelReceiptCount: fuelRow?.count ?? 0,
      distanceKm: numOrNull(record?.distanceKm),
    };
  }

  async getPeriodSummary(telegramId: string | number, startDate: string, endDate: string): Promise<PeriodSummary> {
    const tId = String(telegramId);

    const [records, tipsRow, fuelRow, txs] = await Promise.all([
      db
        .select()
        .from(dailyRecords)
        .where(
          and(eq(dailyRecords.telegramId, tId), gte(dailyRecords.date, startDate), lte(dailyRecords.date, endDate))
        ),
      db
        .select({ total: sql<string>`coalesce(sum(${cashTips.amount}), 0)` })
        .from(cashTips)
        .where(and(eq(cashTips.telegramId, tId), gte(cashTips.date, startDate), lte(cashTips.date, endDate)))
        .then((r) => r[0]),
      db
        .select({
          cost: sql<string>`coalesce(sum(${fuelReceipts.totalCost}), 0)`,
          liters: sql<string>`coalesce(sum(${fuelReceipts.liters}), 0)`,
        })
        .from(fuelReceipts)
        .where(
          and(eq(fuelReceipts.telegramId, tId), gte(fuelReceipts.date, startDate), lte(fuelReceipts.date, endDate))
        )
        .then((r) => r[0]),
      db
        .select({ type: walletTransactions.type, amount: walletTransactions.amount })
        .from(walletTransactions)
        .where(
          and(
            eq(walletTransactions.telegramId, tId),
            gte(walletTransactions.date, startDate),
            lte(walletTransactions.date, endDate)
          )
        ),
    ]);

    let totalGross = 0;
    let totalWorkHours = 0;
    let totalDistanceKm = 0;

    for (const r of records) {
      totalGross += num(r.grossEarnings);
      totalWorkHours += num(r.workHours);
      totalDistanceKm += num(r.distanceKm);
    }

    const totalWalletPayouts = sumWalletPayouts(txs);
    const totalCashTips = round2(num(tipsRow?.total));

    const totals = computeDailyTotals({
      grossEarnings: totalGross,
      cashTipsTotal: totalCashTips,
      walletPayouts: totalWalletPayouts,
      workHours: totalWorkHours,
    });

    const totalNettoEarnings = totals.netEarnings;
    const grandTotalNetto = totals.totalNetto;
    const totalFuelCost = round2(num(fuelRow?.cost));
    const totalFuelLiters = round2(num(fuelRow?.liters));

    return {
      startDate,
      endDate,
      totalGross: round2(totalGross),
      totalNettoEarnings,
      totalCashTips,
      grandTotalNetto,
      totalWalletPayouts,
      totalDoPrzelewu: totals.doPrzelewu,
      totalWorkHours: round2(totalWorkHours),
      avgHourlyRateNetto: totals.hourlyRateNetto,
      totalFuelCost,
      totalFuelLiters,
      avgPricePerLiter: totalFuelLiters > 0 ? Math.round((totalFuelCost / totalFuelLiters) * 1000) / 1000 : null,
      totalDistanceKm: round2(totalDistanceKm),
    };
  }

  async getCourseOfferStats(telegramId: string | number, date: string): Promise<CourseOfferStats> {
    const tId = String(telegramId);
    const offers = await db
      .select()
      .from(courseOffers)
      .where(and(eq(courseOffers.telegramId, tId), eq(courseOffers.date, date)));

    let profitable = 0;
    let accepted = 0;
    let rejected = 0;
    let pending = 0;
    let sumRates = 0;
    let totalGross = 0;
    let totalNet = 0;
    let totalDistanceKm = 0;

    // FIX (5.5): zamiast sentinela 999 uzywamy null - przy stawce > 999 zl/km
    // albo ujemnej stary kod pokazywal bzdury.
    let bestNetRate: number | null = null;
    let worstNetRate: number | null = null;

    for (const o of offers) {
      if (o.isProfitable) profitable++;
      if (o.status === 'ACCEPTED') accepted++;
      else if (o.status === 'REJECTED') rejected++;
      else pending++;

      const rate = parseFloat(o.netRatePerKm);
      sumRates += rate;
      if (bestNetRate === null || rate > bestNetRate) bestNetRate = rate;
      if (worstNetRate === null || rate < worstNetRate) worstNetRate = rate;

      totalGross += parseFloat(o.grossAmount);
      totalNet += parseFloat(o.netAmount);
      totalDistanceKm += parseFloat(o.distanceTotalKm);
    }

    return {
      date,
      totalOffers: offers.length,
      profitable,
      unprofitable: offers.length - profitable,
      accepted,
      rejected,
      pending,
      // FIX (5.4): dwie rozne metryki, obie pokazywane w /statystyki.
      avgNetRatePerKm: offers.length > 0 ? round2(sumRates / offers.length) : null,
      weightedNetRatePerKm: totalDistanceKm > 0 ? round2(totalNet / totalDistanceKm) : null,
      bestNetRate,
      worstNetRate,
      totalGross: round2(totalGross),
      totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
    };
  }

  // --- Cele -----------------------------------------------------------------

  /**
   * FIX (2.10): cele tygodniowe kluczowane ROKIEM ISO.
   * Przy roku kalendarzowym cel zapisany 30 grudnia (tydzien ISO 1 roku
   * nastepnego) trafial pod inny klucz niz odczyt z 2 stycznia.
   */
  private periodKey(periodType: 'MONTHLY' | 'WEEKLY', date: string): { year: number; periodValue: number } {
    if (periodType === 'WEEKLY') {
      const { year, week } = isoWeek(date);
      return { year, periodValue: week };
    }
    const { year, month } = splitDate(date);
    return { year, periodValue: month };
  }

  async setEarningTarget(
    telegramId: string | number,
    periodType: 'MONTHLY' | 'WEEKLY',
    targetAmount: number
  ): Promise<{ year: number; periodValue: number; targetAmount: number }> {
    const tId = String(telegramId);
    const { year, periodValue } = this.periodKey(periodType, this.getEffectiveDate());

    await db
      .insert(earningTargets)
      .values({ telegramId: tId, periodType, targetAmount: targetAmount.toFixed(2), year, periodValue })
      .onConflictDoUpdate({
        target: [earningTargets.telegramId, earningTargets.periodType, earningTargets.year, earningTargets.periodValue],
        set: { targetAmount: targetAmount.toFixed(2) },
      });

    return { year, periodValue, targetAmount };
  }

  async getTargetProgress(
    telegramId: string | number,
    periodType: 'MONTHLY' | 'WEEKLY'
  ): Promise<TargetProgress | null> {
    const tId = String(telegramId);
    const today = this.getEffectiveDate();
    const { year, periodValue } = this.periodKey(periodType, today);

    const [target] = await db
      .select()
      .from(earningTargets)
      .where(
        and(
          eq(earningTargets.telegramId, tId),
          eq(earningTargets.periodType, periodType),
          eq(earningTargets.year, year),
          eq(earningTargets.periodValue, periodValue)
        )
      )
      .limit(1);

    if (!target) return null;

    const targetAmount = parseFloat(target.targetAmount);
    let startDate: string;
    let daysRemaining: number;

    if (periodType === 'MONTHLY') {
      const { day } = splitDate(today);
      startDate = `${year}-${String(periodValue).padStart(2, '0')}-01`;
      daysRemaining = Math.max(1, daysInMonth(year, periodValue) - day + 1);
    } else {
      startDate = weekRangeFor(year, periodValue).startDate;
      daysRemaining = Math.max(1, 7 - isoDayOfWeek(today) + 1);
    }

    const summary = await this.getPeriodSummary(tId, startDate, today);
    const currentNetto = summary.grandTotalNetto;
    const remainingNetto = round2(targetAmount - currentNetto);
    const progressPercent = targetAmount > 0 ? Math.round((currentNetto / targetAmount) * 1000) / 10 : 0;

    const usedFallbackRate = summary.avgHourlyRateNetto <= 0;
    const avgHourlyRate = usedFallbackRate ? CFG.FALLBACK_HOURLY_RATE_NETTO : summary.avgHourlyRateNetto;

    const estimatedHoursRemaining = remainingNetto > 0 ? Math.round((remainingNetto / avgHourlyRate) * 10) / 10 : 0;

    return {
      periodType,
      targetAmount,
      currentNetto,
      remainingNetto: Math.max(0, remainingNetto),
      progressPercent: Math.min(100, Math.max(0, progressPercent)),
      daysRemaining,
      dailyRequiredNetto: remainingNetto > 0 ? round2(remainingNetto / daysRemaining) : 0,
      avgHourlyRate,
      usedFallbackRate,
      estimatedHoursRemaining,
      hoursPerDayRequired: estimatedHoursRemaining > 0 ? Math.round((estimatedHoursRemaining / daysRemaining) * 10) / 10 : 0,
      isCompleted: currentNetto >= targetAmount,
    };
  }
}

export const financeService = new FinanceService();
```

# Plik: src/services/gemini.service.ts
```typescript
import { GoogleGenAI, Type, type Schema } from '@google/genai';
import { z } from 'zod';
import { CFG } from '../config.js';
import { RequestQueue } from '../utils/rate-limiter.js';

/**
 * Wszystkie wywolania Gemini przechodza przez jedna kolejke procesu.
 * Ogranicza rownoleglosc, wymusza odstep miedzy zapytaniami i ponawia 429/503
 * z wykladniczym backoffem, honorujac `retryDelay` z odpowiedzi Google.
 */
export const geminiQueue = new RequestQueue({
  name: 'gemini',
  concurrency: CFG.GEMINI_CONCURRENCY,
  minIntervalMs: CFG.GEMINI_MIN_INTERVAL_MS,
  maxRetries: CFG.GEMINI_MAX_RETRIES,
  baseDelayMs: CFG.GEMINI_BASE_DELAY_MS,
  maxDelayMs: CFG.GEMINI_MAX_DELAY_MS,
  maxQueueLength: CFG.GEMINI_MAX_QUEUE,
});

/**
 * FIX (3.10): odpowiedzi modelu byly rzutowane przez `as`, bez zadnej walidacji.
 * Przy ucietym albo pustym JSON-ie `extracted.transcription` bylo `undefined`,
 * a `extracted.grossEarnings.toFixed(2)` wywalalo handler. Teraz kazda odpowiedz
 * przechodzi przez zod, a przy bledzie parsowania robimy jeden retry.
 *
 * FIX (5.6 + 1.2): nazwa modelu tylko z `CFG.GEMINI_MODEL`, typ `Schema`
 * importowany jako `import type` (wymog `verbatimModuleSyntax`).
 */

const nullableNumber = z.number().nullish().transform((v) => v ?? null);
const nullableString = z.string().nullish().transform((v) => v ?? null);

export const VoiceExtractedSchema = z.object({
  transcription: z.string().default(''),
  action: z.enum(['UPSERT', 'DELETE']).default('UPSERT'),
  deleteTarget: z
    .enum(['LAST_TIP', 'ALL_TIPS', 'FUEL', 'HOURS', 'EARNINGS', 'DISTANCE', 'ALL_DAY'])
    .nullish()
    .transform((v) => v ?? null),
  targetDate: nullableString,
  fuelTotalCost: nullableNumber,
  fuelLiters: nullableNumber,
  fuelPricePerLiter: nullableNumber,
  distanceKm: nullableNumber,
  grossEarnings: nullableNumber,
  workFrom: nullableString,
  workTo: nullableString,
  cashTip: nullableNumber,
});
export type VoiceExtractedData = z.infer<typeof VoiceExtractedSchema>;

export const FuelReceiptSchema = z.object({
  date: nullableString,
  totalCost: z.number(),
  liters: nullableNumber,
  pricePerLiter: nullableNumber,
});
export type FuelReceiptExtractedData = z.infer<typeof FuelReceiptSchema>;

export const CourseOfferSchema = z.object({
  grossAmount: z.number(),
  pickupAddress: z.string().min(1),
  deliveryAddress: z.string().min(1),
  /** Dystans z aplikacji Glovo: kurier -> punkt odbioru (przy wierszu restauracji). */
  appPickupKm: nullableNumber,
  /** Dystans z aplikacji Glovo: odbior -> klient (przy wierszu "Dostawa"). */
  appDeliveryKm: nullableNumber,
});
export type CourseOfferExtractedData = z.infer<typeof CourseOfferSchema>;

export const WalletTransactionItemSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{1,2}:\d{2}$/),
  type: z.enum(['pobranie', 'wyplata', 'wyplata_gotowka', 'platnosc_punkt', 'korekta']),
  amount: z.number(),
  externalId: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
});
export type WalletTransactionItem = z.infer<typeof WalletTransactionItemSchema>;

const WalletScreenSchema = z.object({
  transactions: z.array(WalletTransactionItemSchema).default([]),
});

const ImageCategorySchema = z.object({
  category: z.enum(['WALLET', 'FUEL', 'OFFER']).default('OFFER'),
});
export type ImageCategory = z.infer<typeof ImageCategorySchema>['category'];

// --- Schematy responseSchema dla Gemini -------------------------------------

const voiceResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    transcription: { type: Type.STRING, description: 'Dosłowna transkrypcja wypowiedzi po polsku.' },
    action: { type: Type.STRING, enum: ['UPSERT', 'DELETE'] },
    deleteTarget: {
      type: Type.STRING,
      enum: ['LAST_TIP', 'ALL_TIPS', 'FUEL', 'HOURS', 'EARNINGS', 'DISTANCE', 'ALL_DAY'],
      nullable: true,
    },
    targetDate: { type: Type.STRING, nullable: true, description: 'YYYY-MM-DD, TODAY albo YESTERDAY.' },
    fuelTotalCost: { type: Type.NUMBER, nullable: true, description: 'Łączna kwota tankowania w zł.' },
    fuelLiters: { type: Type.NUMBER, nullable: true },
    fuelPricePerLiter: { type: Type.NUMBER, nullable: true, description: 'Cena za litr w zł.' },
    distanceKm: { type: Type.NUMBER, nullable: true, description: 'Dystans PRZEJECHANY danego dnia, nie stan licznika.' },
    grossEarnings: { type: Type.NUMBER, nullable: true },
    workFrom: { type: Type.STRING, nullable: true, description: 'HH:MM' },
    workTo: { type: Type.STRING, nullable: true, description: 'HH:MM' },
    cashTip: { type: Type.NUMBER, nullable: true },
  },
  required: ['transcription', 'action'],
};

const fuelReceiptResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    date: { type: Type.STRING, nullable: true },
    totalCost: { type: Type.NUMBER, description: 'Kwota do zapłaty za paliwo w zł.' },
    liters: { type: Type.NUMBER, nullable: true },
    pricePerLiter: { type: Type.NUMBER, nullable: true, description: 'Cena jednostkowa za litr w zł.' },
  },
  required: ['totalCost'],
};

const courseOfferResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    grossAmount: { type: Type.NUMBER },
    pickupAddress: { type: Type.STRING },
    deliveryAddress: { type: Type.STRING },
    appPickupKm: {
      type: Type.NUMBER,
      nullable: true,
      description: 'Kilometry po PRAWEJ stronie wiersza z nazwą i adresem punktu odbioru (np. 3,37 km).',
    },
    appDeliveryKm: {
      type: Type.NUMBER,
      nullable: true,
      description: 'Kilometry po PRAWEJ stronie wiersza "Dostawa" (np. 3,01 km).',
    },
  },
  required: ['grossAmount', 'pickupAddress', 'deliveryAddress'],
};

const walletScreenResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    transactions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          date: {
            type: Type.STRING,
            description: 'Data YYYY-MM-DD na podstawie nagłówka sekcji (np. "czw., 6 sierpnia").',
          },
          time: { type: Type.STRING, description: 'Godzina transakcji HH:MM (np. 15:50).' },
          type: {
            type: Type.STRING,
            enum: ['pobranie', 'wyplata', 'wyplata_gotowka', 'platnosc_punkt', 'korekta'],
            description:
              '"Pobranie gotówki od klienta" -> pobranie, "Wypłata" -> wyplata, "Wypłata w gotówce" -> wyplata_gotowka, "Płatność w punkcie" -> platnosc_punkt, "Korekta" -> korekta.',
          },
          amount: {
            type: Type.NUMBER,
            description: 'Kwota ZE ZNAKIEM (ujemna przy minusie, np. -180.60; dodatnia przy pobraniu, np. 63.34).',
          },
          externalId: { type: Type.STRING, nullable: true, description: 'Identyfikator transakcji (ciąg cyfr).' },
        },
        required: ['date', 'time', 'type', 'amount'],
      },
    },
  },
  required: ['transactions'],
};

const imageCategoryResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    category: { type: Type.STRING, enum: ['WALLET', 'FUEL', 'OFFER'] },
  },
  required: ['category'],
};

export class GeminiService {
  private readonly ai: GoogleGenAI;
  private readonly model: string;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('Brak zmiennej GEMINI_API_KEY w pliku .env!');
    this.ai = new GoogleGenAI({ apiKey });
    this.model = CFG.GEMINI_MODEL;
  }

  /** Jedno wywolanie + walidacja zod. Przy bledzie parsowania jeden retry. */
  private async generate<T>(
    schema: z.ZodType<T>,
    responseSchema: Schema,
    parts: Array<Record<string, unknown>>,
    temperature: number,
    label: string
  ): Promise<T> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      // Kolejka zajmuje sie limitami i ponawianiem bledow sieciowych;
      // ta petla obsluguje wylacznie odpowiedz niezgodna ze schematem.
      const response = await geminiQueue.run(
        () =>
          this.ai.models.generateContent({
            model: this.model,
            contents: [{ role: 'user', parts }],
            config: {
              responseMimeType: 'application/json',
              responseSchema,
              temperature,
            },
          }),
        label
      );

      try {
        return schema.parse(JSON.parse(response.text || '{}'));
      } catch (err) {
        lastError = err;
        console.warn(`[Gemini:${label}] próba ${attempt} — nieprawidłowa odpowiedź:`, err);
      }
    }

    throw new Error(`Model zwrócił odpowiedź niezgodną ze schematem (${label}): ${String(lastError)}`);
  }

  async parseVoiceNote(audioBuffer: Buffer, mimeType = 'audio/ogg'): Promise<VoiceExtractedData> {
    const prompt = `
Jesteś asystentem kuriera. Przeanalizuj nagranie audio i zwróć dane w JSON.
Rozpoznaj akcję:
- UPSERT: tankowanie (łączna kwota, litry, cena za litr), przejechany dystans, godziny od-do, zarobki brutto, napiwek gotówkowy.
- DELETE: 'LAST_TIP', 'ALL_TIPS', 'FUEL', 'HOURS', 'EARNINGS', 'DISTANCE', 'ALL_DAY'.
Uwaga: "distanceKm" to dystans PRZEJECHANY danego dnia, nie stan licznika pojazdu.
Jeśli kurier poda stan licznika, zostaw distanceKm puste.
Ignoruj szum wiatru i wydechu motocykla.
`;
    return this.generate(
      VoiceExtractedSchema,
      voiceResponseSchema,
      [{ inlineData: { mimeType, data: audioBuffer.toString('base64') } }, { text: prompt }],
      0.1,
      'voice'
    );
  }

  async extractFuelReceipt(imageBuffer: Buffer, mimeType = 'image/jpeg'): Promise<FuelReceiptExtractedData> {
    const prompt = `
Przeanalizuj paragon paliwowy. Wyciągnij:
- totalCost: łączną kwotę do zapłaty w PLN,
- liters: ilość litrów,
- pricePerLiter: cenę jednostkową za litr w PLN,
- date: datę w formacie YYYY-MM-DD.
Ignoruj kody CN, numery stacji i oznaczenia 95/98.
`;
    return this.generate(
      FuelReceiptSchema,
      fuelReceiptResponseSchema,
      [{ inlineData: { mimeType, data: imageBuffer.toString('base64') } }, { text: prompt }],
      0.1,
      'fuel'
    );
  }

  async analyzeCourseOffer(imageBuffer: Buffer, mimeType = 'image/jpeg'): Promise<CourseOfferExtractedData> {
    const prompt = `
Przeanalizuj ofertę kursu Glovo. Ekran ma układ pionowej osi z dwoma punktami.

- grossAmount: duża zielona kwota u góry. IGNORUJ "POTRZEBNA GOTÓWKA" i przycisk "ZAPŁAĆ ... zł"
  (to gotówka do pobrania od klienta, nie zarobek).
- pickupAddress: nazwa i adres pierwszego punktu (ikona sklepu).
- deliveryAddress: opis drugiego punktu (ikona osoby, zwykle podpisany "Dostawa").
  Często jest to sama nazwa miasta — przepisz dokładnie to, co widzisz, nie zgaduj adresu.
- appPickupKm: liczba kilometrów wyrównana do PRAWEJ w wierszu punktu odbioru (np. 3,37 km).
- appDeliveryKm: liczba kilometrów wyrównana do PRAWEJ w wierszu "Dostawa" (np. 3,01 km).

Kilometry zapisuj jako liczby, przecinek zamień na kropkę. Jeśli któregoś nie widać, zwróć null.
`;
    return this.generate(
      CourseOfferSchema,
      courseOfferResponseSchema,
      [{ inlineData: { mimeType, data: imageBuffer.toString('base64') } }, { text: prompt }],
      0.1,
      'offer'
    );
  }

  /** Vision: OCR zrzutow ekranu Portfela Glovo (lista transakcji). */
  async analyzeWalletScreenshot(
    imageBuffer: Buffer,
    currentYear: number,
    mimeType = 'image/jpeg'
  ): Promise<WalletTransactionItem[]> {
    const prompt = `
Przeanalizuj zrzut ekranu "Portfel" z aplikacji Glovo. Bieżący rok to ${currentYear}.
Wyodrębnij wszystkie widoczne transakcje z listy:
- Nagłówek dnia (np. "Dzisiaj, 11 sierpnia" -> ${currentYear}-08-11, "czw., 6 sierpnia" -> ${currentYear}-08-06).
- Typ pozycji:
  • "Pobranie gotówki od klienta" -> pobranie (kwota dodatnia, np. 35.99)
  • "Wypłata" -> wyplata (kwota ujemna, np. -174.89)
  • "Wypłata w gotówce" -> wyplata_gotowka (kwota ujemna, np. -100.00)
  • "Płatność w punkcie" -> platnosc_punkt (kwota ujemna, np. -255.69)
  • "Korekta" -> korekta (kwota ze znakiem, np. -2.78)
- Godzina: format HH:MM pod nazwą.
- ID transakcji: ciąg cyfr po kropce obok godziny. Jeśli brak, zwróć pusty string.
- IGNORUJ wiersze podsumowania "Łączna kwota w gotówce".
`;
    const parsed = await this.generate(
      WalletScreenSchema,
      walletScreenResponseSchema,
      [{ inlineData: { mimeType, data: imageBuffer.toString('base64') } }, { text: prompt }],
      0.1,
      'wallet'
    );
    return parsed.transactions;
  }

  /** Automatyczna klasyfikacja rodzaju przeslanego obrazu. */
  async classifyImage(imageBuffer: Buffer, caption = '', mimeType = 'image/jpeg'): Promise<ImageCategory> {
    const lower = caption.toLowerCase();
    if (lower.includes('portfel')) return 'WALLET';
    if (lower.includes('paragon') || lower.includes('paliwo') || lower.includes('stacja')) return 'FUEL';
    if (lower.includes('oferta') || lower.includes('kurs') || lower.includes('zlecenie')) return 'OFFER';

    const prompt = `
Rozpoznaj typ ekranu:
- WALLET (ekran "Portfel" z listą transakcji: Pobranie gotówki, Wypłata, Płatność w punkcie)
- FUEL (paragon ze stacji paliw, faktura Orlen/CircleK/itp.)
- OFFER (nowa oferta zlecenia Glovo z mapą, trasą i zieloną kwotą)
`;
    const res = await this.generate(
      ImageCategorySchema,
      imageCategoryResponseSchema,
      [{ inlineData: { mimeType, data: imageBuffer.toString('base64') } }, { text: prompt }],
      0.0,
      'classify'
    );
    return res.category;
  }
}

export const geminiService = new GeminiService();
```

# Plik: src/services/maps.service.ts
```typescript
import 'dotenv/config';
import { CFG } from '../config.js';
import { RequestQueue } from '../utils/rate-limiter.js';

interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteVerification {
  /** Czy udalo sie policzyc cokolwiek. */
  available: boolean;
  /** Powod braku danych: brak klucza, przestarzaly GPS, blad geokodowania... */
  reason: string | null;
  /** Kurier -> punkt odbioru. */
  pickupKm: number | null;
  /** Punkt odbioru -> klient. `null`, gdy oferta nie podaje adresu klienta. */
  deliveryKm: number | null;
  /** Dlaczego nie ma odcinka dostawy. */
  deliveryReason: string | null;
  /** Suma odcinkow. `null`, gdy ktoregokolwiek brakuje. */
  totalKm: number | null;
  /** Wiek uzytej pozycji GPS w minutach. */
  ageMin: number;
}

/**
 * Czy adres jest na tyle konkretny, zeby geokodowanie mialo sens.
 *
 * Ekran oferty Glovo NIE pokazuje adresu klienta przed akceptacja — Gemini
 * wyciaga z niego zwykle sama nazwe miasta ("Katowice"). Geokoder zwraca wtedy
 * centroid miasta, a dystans do niego to liczba bez zadnego zwiazku
 * z rzeczywistoscia. Lepiej nie podac nic niz podac zmyslone 1,83 km.
 */
export function isSpecificAddress(address: string): boolean {
  const trimmed = address.trim();
  if (trimmed.length < 6) return false;
  // Numer budynku albo kod pocztowy.
  if (/\d/.test(trimmed)) return true;
  // Prefiks ulicy bez numeru — te potraktujemy jako zbyt ogolne.
  return false;
}

const geoCache = new Map<string, LatLng>();

function apiKey(): string | null {
  return process.env.GOOGLE_MAPS_API_KEY || null;
}

const mapsQueue = new RequestQueue({
  name: 'maps',
  concurrency: CFG.MAPS_CONCURRENCY,
  minIntervalMs: CFG.MAPS_MIN_INTERVAL_MS,
  maxRetries: CFG.MAPS_MAX_RETRIES,
  baseDelayMs: CFG.MAPS_BASE_DELAY_MS,
  maxDelayMs: CFG.MAPS_MAX_DELAY_MS,
  maxQueueLength: CFG.MAPS_MAX_QUEUE,
});

/** Bledy HTTP musza polecieć wyjatkiem, inaczej kolejka nie ma czego ponowic. */
class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}

async function fetchJson(url: string, label: string): Promise<unknown | null> {
  try {
    return await mapsQueue.run(async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new HttpError(res.status);
      return (await res.json()) as unknown;
    }, label);
  } catch (err) {
    console.warn(`[Maps:${label}] błąd zapytania:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function geocodeAddress(address: string): Promise<LatLng | null> {
  const key = apiKey();
  if (!key) return null;

  const cached = geoCache.get(address);
  if (cached) return cached;

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
  const data = (await fetchJson(url, 'geocode')) as
    | { status?: string; results?: Array<{ geometry?: { location?: LatLng } }> }
    | null;

  const loc = data?.status === 'OK' ? data.results?.[0]?.geometry?.location : undefined;
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return null;

  geoCache.set(address, loc);
  return loc;
}

export async function getRoadDistanceKm(origin: LatLng, dest: LatLng): Promise<number | null> {
  const key = apiKey();
  if (!key) return null;

  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${origin.lat},${origin.lng}&destinations=${dest.lat},${dest.lng}` +
    `&mode=driving&units=metric&key=${key}`;

  const data = (await fetchJson(url, 'distance')) as
    | { rows?: Array<{ elements?: Array<{ status?: string; distance?: { value?: number } }> }> }
    | null;

  const element = data?.rows?.[0]?.elements?.[0];
  if (!element || element.status !== 'OK' || typeof element.distance?.value !== 'number') return null;

  return Math.round((element.distance.value / 1000) * 100) / 100;
}

/**
 * Niezalezna kontrola dystansu przez Google Maps.
 *
 * FIX (2.3): liczymy OBA odcinki, nie tylko dojazd do restauracji.
 *
 * Ograniczenia, o ktorych trzeba pamietac czytajac wynik:
 *  • odcinek odbioru liczy sie od OSTATNIEJ wyslanej pozycji GPS, nie od
 *    biezacej — jesli kurier ruszyl sie od czasu `/lokalizacja`, bedzie
 *    rozbieznosc wzgledem aplikacji Glovo, ktora zna pozycje na zywo;
 *  • odcinek dostawy da sie policzyc tylko wtedy, gdy oferta podaje konkretny
 *    adres klienta — przed akceptacja Glovo go nie pokazuje.
 */
export async function verifyOfferDistance(
  userLoc: { lat: number; lng: number; ts: number } | null,
  pickupAddress: string,
  deliveryAddress: string
): Promise<RouteVerification> {
  const empty = (reason: string, ageMin = 0): RouteVerification => ({
    available: false,
    reason,
    pickupKm: null,
    deliveryKm: null,
    deliveryReason: reason,
    totalKm: null,
    ageMin,
  });

  if (!apiKey()) return empty('brak GOOGLE_MAPS_API_KEY');
  if (!userLoc) return empty('brak pozycji GPS — wyślij /lokalizacja');

  const ageMs = Date.now() - userLoc.ts;
  if (ageMs > CFG.LOCATION_MAX_AGE_MS) return empty('pozycja GPS jest przestarzała');

  const ageMin = Math.max(0, Math.round(ageMs / 60_000));

  const pickupGeo = await geocodeAddress(pickupAddress);
  if (!pickupGeo) return empty('nie udało się zgeokodować adresu odbioru', ageMin);

  const pickupKm = await getRoadDistanceKm({ lat: userLoc.lat, lng: userLoc.lng }, pickupGeo);
  if (pickupKm === null) return empty('nie udało się wyznaczyć dojazdu', ageMin);

  // Odcinek dostawy — tylko gdy adres klienta jest konkretny.
  let deliveryKm: number | null = null;
  let deliveryReason: string | null = null;

  if (!isSpecificAddress(deliveryAddress)) {
    deliveryReason = 'oferta nie podaje adresu klienta';
  } else {
    const deliveryGeo = await geocodeAddress(deliveryAddress);
    if (!deliveryGeo) {
      deliveryReason = 'nie udało się zgeokodować adresu klienta';
    } else {
      deliveryKm = await getRoadDistanceKm(pickupGeo, deliveryGeo);
      if (deliveryKm === null) deliveryReason = 'nie udało się wyznaczyć trasy do klienta';
    }
  }

  return {
    available: true,
    reason: null,
    pickupKm,
    deliveryKm,
    deliveryReason,
    totalKm: deliveryKm !== null ? Math.round((pickupKm + deliveryKm) * 100) / 100 : null,
    ageMin,
  };
}
```

# Plik: src/services/user.service.ts
```typescript
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { sql } from 'drizzle-orm';

/**
 * FIX (4.2): tabela `users` byla martwa. Teraz kazda interakcja z botem robi
 * upsert, dzieki czemu klucze obce z pozostalych tabel maja na czym stac.
 *
 * Bez cache'a w pamieci — swiadomie.
 * Pierwsza wersja pomijala zapis, jesli widziala tego uzytkownika w ciagu
 * ostatniej godziny. Wystarczylo jednak, ze wiersz zniknal z bazy przy zywym
 * procesie (reset schematu, przywracanie dumpa) i `ensureUser` po cichu nic
 * nie robil, a kazdy kolejny insert lecial na naruszeniu klucza obcego.
 * Jeden upsert na wiadomosc to przy tej skali koszt bez znaczenia.
 */

export interface TelegramUserInfo {
  id: number | string;
  username?: string | undefined;
  first_name?: string | undefined;
}

export async function ensureUser(from: TelegramUserInfo): Promise<void> {
  await db
    .insert(users)
    .values({
      telegramId: String(from.id),
      username: from.username ?? null,
      firstName: from.first_name ?? null,
    })
    .onConflictDoUpdate({
      target: users.telegramId,
      set: {
        username: from.username ?? null,
        firstName: from.first_name ?? null,
        lastSeenAt: sql`now()`,
      },
    });
}

/** Uzywane przez skrypty CLI, ktore pisza do bazy poza kontekstem bota. */
export async function ensureUserById(telegramId: string): Promise<void> {
  await db.insert(users).values({ telegramId }).onConflictDoNothing();
}
```

# Plik: src/utils/datetime.test.ts
```typescript
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  addDays,
  calculateHours,
  daysBetween,
  isoDayOfWeek,
  isoWeek,
  isoWeekStart,
  isValidDateStr,
  monthRange,
  normalizeTime,
  nowTimeWarsaw,
  todayWarsaw,
  weekRange,
  weekRangeFor,
} from './datetime.js';

afterEach(() => {
  vi.useRealTimers();
});

function atUtc(iso: string): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

describe('todayWarsaw (FIX 2.1)', () => {
  it('01:00 czasu warszawskiego należy już do nowego dnia', () => {
    // 2026-08-16 01:00 Warszawa = 2026-08-15 23:00 UTC
    atUtc('2026-08-15T23:00:00Z');
    expect(todayWarsaw()).toBe('2026-08-16');
  });

  it('23:30 czasu warszawskiego to nadal ten sam dzień', () => {
    atUtc('2026-08-15T21:30:00Z');
    expect(todayWarsaw()).toBe('2026-08-15');
  });

  it('05:30 rano NIE cofa daty (regresja starego kodu)', () => {
    // Stary getEffectiveDate() czytal getHours() z UTC (03:30 < 4)
    // i cofal date o dzien. Tutaj musi wyjsc 2026-08-16.
    atUtc('2026-08-16T03:30:00Z');
    expect(todayWarsaw()).toBe('2026-08-16');
  });

  it('działa też zimą, przy przesunięciu UTC+1', () => {
    atUtc('2026-01-15T23:30:00Z'); // 2026-01-16 00:30 Warszawa
    expect(todayWarsaw()).toBe('2026-01-16');
  });

  it('nowTimeWarsaw zwraca czas lokalny, nie UTC', () => {
    atUtc('2026-08-15T21:30:00Z');
    expect(nowTimeWarsaw()).toBe('23:30');
  });
});

describe('isoWeek (FIX 2.10)', () => {
  it('koniec grudnia należy do tygodnia 1 następnego roku ISO', () => {
    expect(isoWeek('2025-12-29')).toEqual({ year: 2026, week: 1 });
    expect(isoWeek('2025-12-31')).toEqual({ year: 2026, week: 1 });
  });

  it('początek stycznia potrafi należeć do poprzedniego roku ISO', () => {
    expect(isoWeek('2027-01-01')).toEqual({ year: 2026, week: 53 });
  });

  it('cel zapisany 30 grudnia i odczytany 2 stycznia ma ten sam klucz', () => {
    expect(isoWeek('2025-12-30')).toEqual(isoWeek('2026-01-02'));
  });

  it('isoWeekStart zwraca poniedziałek tygodnia', () => {
    expect(isoWeekStart(2026, 1)).toBe('2025-12-29');
    expect(isoDayOfWeek(isoWeekStart(2026, 33))).toBe(1);
  });

  it('weekRange to zawsze pon–niedz', () => {
    const range = weekRange('2026-08-15'); // sobota
    expect(range).toEqual({ startDate: '2026-08-10', endDate: '2026-08-16' });
  });

  it('weekRange z offsetem -1 daje poprzedni tydzień', () => {
    expect(weekRange('2026-08-15', -1)).toEqual({ startDate: '2026-08-03', endDate: '2026-08-09' });
  });

  it('weekRangeFor jest spójne z isoWeek', () => {
    const { year, week } = isoWeek('2026-08-15');
    const range = weekRangeFor(year, week);
    expect(range.startDate).toBe('2026-08-10');
    expect(range.endDate).toBe('2026-08-16');
  });
});

describe('arytmetyka dat', () => {
  it('addDays przechodzi przez granicę miesiąca', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('addDays nie gubi dnia przy zmianie czasu', () => {
    // Zmiana czasu w Polsce: 2026-03-29
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
  });

  it('daysBetween liczy różnicę dni', () => {
    expect(daysBetween('2026-08-01', '2026-08-15')).toBe(14);
  });

  it('monthRange obsługuje luty roku przestępnego', () => {
    expect(monthRange(2028, 2)).toEqual({ startDate: '2028-02-01', endDate: '2028-02-29' });
  });

  it('isValidDateStr odrzuca nieistniejące daty', () => {
    expect(isValidDateStr('2026-02-30')).toBe(false);
    expect(isValidDateStr('2026-08-15')).toBe(true);
    expect(isValidDateStr('15.08.2026')).toBe(false);
    expect(isValidDateStr(undefined)).toBe(false);
  });
});

describe('normalizeTime', () => {
  it('uzupełnia zero wiodące', () => {
    expect(normalizeTime('9:05')).toBe('09:05');
    expect(normalizeTime('19:30')).toBe('19:30');
  });

  it('odrzuca bzdury', () => {
    expect(normalizeTime('25:00')).toBeNull();
    expect(normalizeTime('12:99')).toBeNull();
    expect(normalizeTime('/dzis')).toBeNull();
  });
});

describe('calculateHours (FIX 2.9)', () => {
  it('liczy zwykłą zmianę', () => {
    expect(calculateHours('16:00', '23:30')).toEqual({ hours: 7.5, error: null });
  });

  it('obsługuje przejście przez północ', () => {
    expect(calculateHours('22:00', '02:00')).toEqual({ hours: 4, error: null });
  });

  it('odrzuca literówkę zamiast dodawać po cichu 24 h', () => {
    // Stary kod zwracal tutaj 23 h i wpuszczal je do statystyk.
    const result = calculateHours('10:00', '09:00');
    expect(result.hours).toBeNull();
    expect(result.error).toContain('limit');
  });

  it('odrzuca zmianę krótszą niż minimum', () => {
    const result = calculateHours('10:00', '10:10');
    expect(result.hours).toBeNull();
    expect(result.error).toContain('minimum');
  });

  it('zgłasza błąd formatu zamiast zwracać 0', () => {
    expect(calculateHours('abc', '10:00').error).toContain('format');
  });
});
```

# Plik: src/utils/datetime.ts
```typescript
import { CFG } from '../config.js';

/**
 * Cala arytmetyka dat w projekcie opiera sie na stringach `YYYY-MM-DD`
 * interpretowanych jako data kalendarzowa w strefie Europe/Warsaw.
 *
 * Zasada (ustalona 2.1): doba konczy sie o polnocy. Wpis zrobiony o 01:00
 * nalezy juz do NOWEGO dnia. Nie ma zadnego cofania nocnych zmian.
 *
 * Operacje na dniach robimy na UTC-polnocy, zeby DST nigdy nie przesunelo wyniku.
 */

const DAY_MS = 86_400_000;

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: CFG.TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: CFG.TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Dzisiejsza data kalendarzowa w Warszawie, `YYYY-MM-DD`. */
export function todayWarsaw(now: Date = new Date()): string {
  return dateFmt.format(now);
}

/** Biezaca godzina w Warszawie, `HH:MM`. */
export function nowTimeWarsaw(now: Date = new Date()): string {
  return timeFmt.format(now);
}

export function isValidDateStr(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && toDateStr(new Date(t)) === s;
}

export function isValidTimeStr(s: unknown): s is string {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** `9:05` -> `09:05`. Zwraca null gdy format jest nieprawidlowy. */
export function normalizeTime(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toUtcMidnight(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`);
}

export function addDays(dateStr: string, days: number): string {
  return toDateStr(new Date(toUtcMidnight(dateStr).getTime() + days * DAY_MS));
}

/** Liczba dni od `a` do `b` (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcMidnight(b).getTime() - toUtcMidnight(a).getTime()) / DAY_MS);
}

/** Numer dnia tygodnia wg ISO: poniedzialek = 1 ... niedziela = 7. */
export function isoDayOfWeek(dateStr: string): number {
  return toUtcMidnight(dateStr).getUTCDay() || 7;
}

/**
 * Tydzien ISO 8601 wraz z ROKIEM ISO (2.10).
 * Rok ISO potrafi rozniac sie od kalendarzowego na przelomie roku:
 * 2025-12-29 -> { year: 2026, week: 1 }, 2027-01-01 -> { year: 2026, week: 53 }.
 * Wlasnie dlatego cele tygodniowe musza byc kluczowane rokiem ISO.
 */
export function isoWeek(dateStr: string): { year: number; week: number } {
  const d = toUtcMidnight(dateStr);
  // Przesuwamy sie na czwartek biezacego tygodnia - jego rok to rok ISO.
  d.setUTCDate(d.getUTCDate() + 4 - isoDayOfWeek(dateStr));
  const year = d.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d.getTime() - jan1) / DAY_MS + 1) / 7);
  return { year, week };
}

/** Poniedzialek tygodnia ISO o podanym numerze. */
export function isoWeekStart(year: number, week: number): string {
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Dow = new Date(jan4).getUTCDay() || 7;
  const week1Monday = jan4 - (jan4Dow - 1) * DAY_MS;
  return toDateStr(new Date(week1Monday + (week - 1) * 7 * DAY_MS));
}

export interface DateRange {
  startDate: string;
  endDate: string;
}

/** Zakres pon-niedz tygodnia ISO zawierajacego `dateStr`, przesuniety o `offsetWeeks`. */
export function weekRange(dateStr: string, offsetWeeks = 0): DateRange {
  const { year, week } = isoWeek(dateStr);
  const monday = addDays(isoWeekStart(year, week), offsetWeeks * 7);
  return { startDate: monday, endDate: addDays(monday, 6) };
}

/** Zakres tygodnia ISO wskazanego wprost przez (rok ISO, numer tygodnia). */
export function weekRangeFor(year: number, week: number): DateRange {
  const monday = isoWeekStart(year, week);
  return { startDate: monday, endDate: addDays(monday, 6) };
}

export function monthRange(year: number, month: number): DateRange {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { startDate: start, endDate: `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function splitDate(dateStr: string): { year: number; month: number; day: number } {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { year: y ?? 0, month: m ?? 0, day: d ?? 0 };
}

export interface ShiftHours {
  hours: number | null;
  error: string | null;
}

/**
 * Dlugosc zmiany w godzinach (2.9).
 *
 * Stary kod przy ujemnej roznicy dodawal po cichu 24 h, wiec literowka
 * `10:00 -> 09:00` zamieniala sie w 23 h i wchodzila do statystyk oraz do
 * stawki zl/h. Teraz przejscie przez polnoc dalej dziala (22:00 -> 02:00 = 4 h),
 * ale wynik poza [MIN_SHIFT_HOURS, MAX_SHIFT_HOURS] zwraca blad zamiast liczby.
 */
export function calculateHours(fromStr: string, toStr: string): ShiftHours {
  const from = normalizeTime(fromStr);
  const to = normalizeTime(toStr);
  if (!from || !to) return { hours: null, error: 'Nieprawidlowy format godziny (oczekiwano GG:MM).' };

  const [fH, fM] = from.split(':').map(Number) as [number, number];
  const [tH, tM] = to.split(':').map(Number) as [number, number];

  let diffMinutes = tH * 60 + tM - (fH * 60 + fM);
  if (diffMinutes <= 0) diffMinutes += 24 * 60; // zmiana przez polnoc

  const hours = Math.round((diffMinutes / 60) * 100) / 100;

  if (hours > CFG.MAX_SHIFT_HOURS) {
    return {
      hours: null,
      error: `Zmiana ${from}-${to} wychodzi ${hours.toFixed(2)} h (limit ${CFG.MAX_SHIFT_HOURS} h). Sprawdz godziny.`,
    };
  }
  if (hours < CFG.MIN_SHIFT_HOURS) {
    return {
      hours: null,
      error: `Zmiana ${from}-${to} to tylko ${hours.toFixed(2)} h (minimum ${CFG.MIN_SHIFT_HOURS} h).`,
    };
  }
  return { hours, error: null };
}
```

# Plik: src/utils/format.ts
```typescript
/**
 * Formatowanie wiadomosci Telegrama.
 *
 * FIX (3.3): caly bot przechodzi z legacy `parse_mode: 'Markdown'` na `'HTML'`.
 * Powod: transkrypcje glosowe i adresy z OCR trafialy do szablonu bez zadnego
 * escapowania. Adres `ul. Sportowa 5_A` albo gwiazdka w transkrypcji wywalaly
 * cala wiadomosc bledem `400: can't parse entities`, a uzytkownik widzial
 * tylko "Blad analizy obrazu". W HTML escapowanie to trzy znaki i jest pewne.
 */

/** Escape tresci pochodzacej od uzytkownika / modelu. Uzywaj ZAWSZE. */
export function h(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const b = (value: unknown): string => `<b>${h(value)}</b>`;
export const i = (value: unknown): string => `<i>${h(value)}</i>`;
export const code = (value: unknown): string => `<code>${h(value)}</code>`;

/** Kwota w złotówkach, zawsze 2 miejsca po przecinku. */
export const zl = (n: number): string => `${n.toFixed(2)} zł`;
/** Kwota ze znakiem (`+12.00 zł` / `-8.50 zł`). */
export const zlSigned = (n: number): string => `${n > 0 ? '+' : ''}${n.toFixed(2)} zł`;

export const km = (n: number, digits = 1): string => `${n.toFixed(digits)} km`;

/**
 * FIX (4.7): `.filter(Boolean)` nie zawężał typu — tablica dalej była
 * `Array<string | false>` z punktu widzenia TypeScriptu.
 */
export function compact(lines: Array<string | false | null | undefined>): string[] {
  return lines.filter((line): line is string => typeof line === 'string' && line.length > 0);
}

/** Składa wiersze wiadomości, wyrzucając puste/warunkowe. */
export function joinLines(lines: Array<string | false | null | undefined>): string {
  return compact(lines).join('\n');
}

export function progressBar(percent: number, totalBlocks = 10): string {
  const filled = Math.min(totalBlocks, Math.max(0, Math.round((percent / 100) * totalBlocks)));
  return `[${'█'.repeat(filled)}${'░'.repeat(totalBlocks - filled)}]`;
}

export const SEPARATOR = '────────────────';
```

# Plik: src/utils/rate-limiter.test.ts
```typescript
import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  isRetryable,
  QueueOverflowError,
  RequestQueue,
  serverRetryAfterMs,
} from './rate-limiter.js';

/** Kolejka bez realnego czekania — testy lecą natychmiast. */
function testQueue(overrides: Partial<ConstructorParameters<typeof RequestQueue>[0]> = {}) {
  const slept: number[] = [];
  const queue = new RequestQueue({
    name: 'test',
    concurrency: 1,
    minIntervalMs: 0,
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 5000,
    maxQueueLength: 10,
    sleep: async (ms) => {
      slept.push(ms);
    },
    random: () => 1, // bez losowości — jitter zawsze 100%
    ...overrides,
  });
  return { queue, slept };
}

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`Request failed with status ${status}`), { status });
}

describe('isRetryable', () => {
  it('rozpoznaje limity i błędy serwera', () => {
    expect(isRetryable(httpError(429))).toBe(true);
    expect(isRetryable(httpError(503))).toBe(true);
    expect(isRetryable(httpError(500))).toBe(true);
  });

  it('nie ponawia błędów, które i tak się powtórzą', () => {
    expect(isRetryable(httpError(400))).toBe(false);
    expect(isRetryable(httpError(401))).toBe(false);
    expect(isRetryable(httpError(404))).toBe(false);
  });

  it('łapie błędy sieciowe Node', () => {
    expect(isRetryable(Object.assign(new Error('socket'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('dns'), { code: 'EAI_AGAIN' }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))).toBe(true);
  });

  it('rozpoznaje komunikaty Gemini bez pola status', () => {
    expect(isRetryable(new Error('[429] RESOURCE_EXHAUSTED: Quota exceeded'))).toBe(true);
    expect(isRetryable(new Error('The model is overloaded. Please try again later.'))).toBe(true);
    expect(isRetryable(new Error('Invalid API key'))).toBe(false);
  });
});

describe('serverRetryAfterMs', () => {
  it('czyta nagłówek Retry-After', () => {
    expect(serverRetryAfterMs({ headers: { 'retry-after': '30' } })).toBe(30_000);
  });

  it('czyta retryDelay z RetryInfo Google', () => {
    const err = new Error('RESOURCE_EXHAUSTED {"retryDelay":"31s"}');
    expect(serverRetryAfterMs(err)).toBe(31_000);
  });

  it('zwraca null, gdy serwer nic nie podpowiada', () => {
    expect(serverRetryAfterMs(new Error('boom'))).toBeNull();
  });
});

describe('backoffDelayMs', () => {
  it('rośnie wykładniczo', () => {
    const opts = { baseDelayMs: 1000, maxDelayMs: 60_000, random: () => 1 };
    expect(backoffDelayMs(1, opts)).toBe(1000);
    expect(backoffDelayMs(2, opts)).toBe(2000);
    expect(backoffDelayMs(3, opts)).toBe(4000);
    expect(backoffDelayMs(4, opts)).toBe(8000);
  });

  it('nie przekracza limitu', () => {
    expect(backoffDelayMs(20, { baseDelayMs: 1000, maxDelayMs: 60_000, random: () => 1 })).toBe(60_000);
  });

  it('jitter skraca opóźnienie maksymalnie o połowę', () => {
    const delay = backoffDelayMs(3, { baseDelayMs: 1000, maxDelayMs: 60_000, random: () => 0 });
    expect(delay).toBe(2000); // 4000 × 0.5
  });

  it('wskazówka serwera ma pierwszeństwo przed własnym backoffem', () => {
    const delay = backoffDelayMs(1, { baseDelayMs: 1000, maxDelayMs: 60_000, retryAfterMs: 31_000, random: () => 1 });
    expect(delay).toBe(31_000);
  });

  it('ale nadal podlega limitowi', () => {
    const delay = backoffDelayMs(1, { baseDelayMs: 1000, maxDelayMs: 10_000, retryAfterMs: 600_000, random: () => 1 });
    expect(delay).toBe(10_000);
  });
});

describe('RequestQueue', () => {
  it('ponawia po 429 i zwraca wynik', async () => {
    const { queue, slept } = testQueue();
    let calls = 0;

    const result = await queue.run(async () => {
      calls++;
      if (calls < 3) throw httpError(429);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(slept).toEqual([100, 200]); // backoff między próbami
  });

  it('poddaje się po wyczerpaniu prób', async () => {
    const { queue } = testQueue({ maxRetries: 2 });
    let calls = 0;

    await expect(
      queue.run(async () => {
        calls++;
        throw httpError(503);
      })
    ).rejects.toThrow('503');

    expect(calls).toBe(3); // pierwsza próba + 2 ponowienia
  });

  it('nie ponawia błędów trwałych', async () => {
    const { queue } = testQueue();
    let calls = 0;

    await expect(
      queue.run(async () => {
        calls++;
        throw httpError(400);
      })
    ).rejects.toThrow('400');

    expect(calls).toBe(1);
  });

  it('respektuje wskazówkę serwera zamiast własnego backoffu', async () => {
    // maxDelayMs musi być wyższe niż wskazówka, inaczej zostanie przycięta.
    const { queue, slept } = testQueue({ maxDelayMs: 30_000 });
    let calls = 0;

    await queue.run(async () => {
      calls++;
      if (calls === 1) throw new Error('RESOURCE_EXHAUSTED {"retryDelay":"7s"}');
      return 'ok';
    });

    expect(slept).toEqual([7000]); // zamiast bazowych 100 ms
  });

  it('przycina wskazówkę serwera do maxDelayMs', async () => {
    const { queue, slept } = testQueue({ maxDelayMs: 5000 });
    let calls = 0;

    await queue.run(async () => {
      calls++;
      if (calls === 1) throw new Error('RESOURCE_EXHAUSTED {"retryDelay":"120s"}');
      return 'ok';
    });

    expect(slept).toEqual([5000]);
  });

  it('pilnuje limitu równoległości', async () => {
    const { queue } = testQueue({ concurrency: 2 });
    let running = 0;
    let peak = 0;

    const task = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    };

    await Promise.all(Array.from({ length: 6 }, () => queue.run(task)));

    expect(peak).toBe(2);
  });

  it('przepuszcza album 3 zdjęć = 6 wywołań, ale pojedynczo', async () => {
    const { queue } = testQueue({ concurrency: 1 });
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 6 }, (_, idx) =>
        queue.run(async () => {
          order.push(idx);
          await new Promise((r) => setTimeout(r, 1));
        })
      )
    );

    expect(order).toHaveLength(6);
    expect(queue.running).toBe(0);
    expect(queue.pending).toBe(0);
  });

  it('odrzuca zadania, gdy kolejka jest przepełniona', async () => {
    const { queue } = testQueue({ concurrency: 1, maxQueueLength: 2 });
    const slow = () => queue.run(() => new Promise((r) => setTimeout(r, 20)));

    const running = [slow(), slow(), slow()]; // 1 aktywne + 2 czekające
    await expect(slow()).rejects.toThrow(QueueOverflowError);

    await Promise.all(running);
  });

  it('zwalnia miejsce także po błędzie', async () => {
    const { queue } = testQueue({ concurrency: 1, maxRetries: 0 });

    await expect(queue.run(async () => Promise.reject(httpError(400)))).rejects.toThrow();
    await expect(queue.run(async () => 'działa')).resolves.toBe('działa');
    expect(queue.running).toBe(0);
  });
});
```

# Plik: src/utils/rate-limiter.ts
```typescript
/**
 * Kolejka zapytan do zewnetrznych API z ograniczeniem rownoleglosci
 * i ponawianiem z wykladniczym backoffem.
 *
 * Po co: Telegram wysyla album 3 zdjec jako 3 osobne update'y, wiec handler
 * zdjec odpala sie 3 razy rownolegle. Kazde zdjecie to 2 wywolania Gemini
 * (klasyfikacja + odczyt), czyli 6 rownoczesnych zapytan z jednego gestu
 * uzytkownika. Darmowy tier Gemini tego nie przepuszcza i zwraca 429,
 * a bot pokazywal wtedy "Blad analizy obrazu" i gubil paragon.
 *
 * Bez zewnetrznej zaleznosci — p-queue nie obsluguje naglowka `Retry-After`
 * ani `retryDelay` z odpowiedzi Google, a to wlasnie one mowia, ile realnie
 * trzeba odczekac.
 */

export interface RequestQueueOptions {
  /** Nazwa do logow. */
  name: string;
  /** Ile zapytan moze leciec jednoczesnie. */
  concurrency: number;
  /** Minimalny odstep miedzy STARTAMI zapytan (ms). */
  minIntervalMs: number;
  /** Ile razy ponowic po bledzie przejsciowym. */
  maxRetries: number;
  /** Bazowe opoznienie backoffu (ms). */
  baseDelayMs: number;
  /** Gorny limit pojedynczego opoznienia (ms). */
  maxDelayMs: number;
  /** Maksymalna dlugosc kolejki — chroni przed zalaniem. */
  maxQueueLength: number;
  /** Wstrzykiwane w testach. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Kody HTTP, po ktorych ma sens sprobowac jeszcze raz. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Bledy sieciowe Node — polaczenie zerwane, DNS chwilowo nie odpowiada itd. */
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND']);

const RETRYABLE_TEXT =
  /(rate.?limit|quota|too many requests|resource_exhausted|unavailable|overloaded|deadline|timeout|socket hang up)/i;

function readStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as Record<string, unknown>;
  for (const key of ['status', 'statusCode', 'code']) {
    const value = e[key];
    if (typeof value === 'number' && value >= 100 && value < 600) return value;
  }
  const nested = e['error'];
  if (typeof nested === 'object' && nested !== null) {
    const code = (nested as Record<string, unknown>)['code'];
    if (typeof code === 'number') return code;
  }
  // SDK Google potrafi wcisnac kod tylko w tresc komunikatu.
  const message = typeof e['message'] === 'string' ? e['message'] : '';
  const match = message.match(/\b(429|500|502|503|504)\b/);
  return match ? Number(match[1]) : null;
}

export function isRetryable(err: unknown): boolean {
  const status = readStatus(err);
  if (status !== null) return RETRYABLE_STATUS.has(status);

  if (typeof err === 'object' && err !== null) {
    const code = (err as Record<string, unknown>)['code'];
    if (typeof code === 'string' && RETRYABLE_CODES.has(code)) return true;

    const name = (err as Record<string, unknown>)['name'];
    if (name === 'AbortError' || name === 'TimeoutError') return true;
  }

  const message = err instanceof Error ? err.message : String(err);
  return RETRYABLE_TEXT.test(message);
}

/**
 * Ile serwer kaze czekac. Kolejno sprawdzamy:
 *  • naglowek `Retry-After` (sekundy),
 *  • `retryDelay: "31s"` z RetryInfo w odpowiedzi Google,
 *  • brak wskazowki -> null, uzyjemy wlasnego backoffu.
 */
export function serverRetryAfterMs(err: unknown): number | null {
  if (typeof err === 'object' && err !== null) {
    const headers = (err as Record<string, unknown>)['headers'];
    if (headers && typeof headers === 'object') {
      const raw = (headers as Record<string, unknown>)['retry-after'];
      const seconds = Number(raw);
      if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/"?retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s/i);
  return match ? Math.round(Number(match[1]) * 1000) : null;
}

/**
 * Opoznienie przed kolejna proba: wykladnicze z pelnym jitterem
 * (losowe 50–100% wyliczonej wartosci), zeby rownolegle zapytania
 * nie wracaly do API dokladnie w tej samej chwili.
 */
export function backoffDelayMs(
  attempt: number,
  opts: { baseDelayMs: number; maxDelayMs: number; retryAfterMs?: number | null; random?: () => number }
): number {
  if (opts.retryAfterMs != null && opts.retryAfterMs > 0) {
    return Math.min(opts.retryAfterMs, opts.maxDelayMs);
  }
  const exponential = Math.min(opts.baseDelayMs * 2 ** Math.max(0, attempt - 1), opts.maxDelayMs);
  const jitter = 0.5 + (opts.random ?? Math.random)() * 0.5;
  return Math.round(exponential * jitter);
}

export class QueueOverflowError extends Error {
  constructor(name: string, limit: number) {
    super(`Kolejka ${name} jest pełna (${limit} oczekujących). Spróbuj za chwilę.`);
    this.name = 'QueueOverflowError';
  }
}

export class RequestQueue {
  private readonly opts: Required<Omit<RequestQueueOptions, 'sleep' | 'random'>> & {
    sleep: (ms: number) => Promise<void>;
    random: () => number;
  };

  private active = 0;
  private lastStartedAt = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: RequestQueueOptions) {
    this.opts = {
      ...options,
      sleep: options.sleep ?? defaultSleep,
      random: options.random ?? Math.random,
    };
  }

  /** Ile zapytan czeka na wolne miejsce. */
  get pending(): number {
    return this.waiting.length;
  }

  /** Ile zapytan leci w tej chwili. */
  get running(): number {
    return this.active;
  }

  async run<T>(task: () => Promise<T>, label = ''): Promise<T> {
    if (this.waiting.length >= this.opts.maxQueueLength) {
      throw new QueueOverflowError(this.opts.name, this.opts.maxQueueLength);
    }

    await this.acquireSlot();
    try {
      return await this.attempt(task, label);
    } finally {
      this.releaseSlot();
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.active >= this.opts.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;

    const sinceLast = Date.now() - this.lastStartedAt;
    const wait = this.opts.minIntervalMs - sinceLast;
    if (wait > 0) await this.opts.sleep(wait);

    this.lastStartedAt = Date.now();
  }

  private releaseSlot(): void {
    this.active--;
    this.waiting.shift()?.();
  }

  private async attempt<T>(task: () => Promise<T>, label: string): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.opts.maxRetries + 1; attempt++) {
      try {
        return await task();
      } catch (err) {
        lastError = err;

        if (!isRetryable(err) || attempt > this.opts.maxRetries) throw err;

        const delay = backoffDelayMs(attempt, {
          baseDelayMs: this.opts.baseDelayMs,
          maxDelayMs: this.opts.maxDelayMs,
          retryAfterMs: serverRetryAfterMs(err),
          random: this.opts.random,
        });

        console.warn(
          `[${this.opts.name}${label ? `:${label}` : ''}] próba ${attempt}/${this.opts.maxRetries} nieudana ` +
            `(${err instanceof Error ? err.message.slice(0, 120) : String(err)}) — ponawiam za ${delay} ms`
        );

        await this.opts.sleep(delay);
      }
    }

    throw lastError;
  }
}
```

# Plik: docker/backup/backup.sh
```bash
#!/bin/sh
# Zrzut bazy -> gzip -> szyfrowanie AES256 -> katalog /backups
# Opcjonalnie wysyłka na prywatny czat Telegrama.
#
# Wołane z crona (patrz entrypoint.sh) albo ręcznie:
#   docker compose exec backup /usr/local/bin/backup.sh
#   docker compose exec backup /usr/local/bin/backup.sh --send

set -eu

SEND_TO_TELEGRAM=0
[ "${1:-}" = "--send" ] && SEND_TO_TELEGRAM=1

: "${POSTGRES_HOST:?brak POSTGRES_HOST}"
: "${POSTGRES_USER:?brak POSTGRES_USER}"
: "${POSTGRES_DB:?brak POSTGRES_DB}"
: "${PGPASSWORD:?brak PGPASSWORD}"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date +%Y-%m-%d_%H%M)"
BASENAME="${POSTGRES_DB}-${STAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

log() { echo "[backup $(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# --- Zrzut ------------------------------------------------------------------
# --clean --if-exists sprawia, że dump da się wgrać na niepustą bazę.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log "zrzucam ${POSTGRES_DB} z ${POSTGRES_HOST}…"
pg_dump \
  --host="$POSTGRES_HOST" \
  --port="${POSTGRES_PORT:-5432}" \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --clean --if-exists --no-owner --no-privileges \
  | gzip -9 > "$TMP/$BASENAME"

RAW_SIZE="$(du -h "$TMP/$BASENAME" | cut -f1)"

# Pusty albo podejrzanie mały zrzut to sygnał, że coś poszło nie tak.
MIN_BYTES="${BACKUP_MIN_BYTES:-1024}"
ACTUAL_BYTES="$(stat -c %s "$TMP/$BASENAME")"
if [ "$ACTUAL_BYTES" -lt "$MIN_BYTES" ]; then
  log "BŁĄD: zrzut ma tylko ${ACTUAL_BYTES} B (minimum ${MIN_BYTES} B) — przerywam."
  exit 1
fi

# --- Szyfrowanie ------------------------------------------------------------
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  OUTPUT="$BACKUP_DIR/${BASENAME}.gpg"
  gpg --batch --yes --quiet \
      --symmetric --cipher-algo AES256 \
      --passphrase "$BACKUP_PASSPHRASE" \
      --output "$OUTPUT" "$TMP/$BASENAME"
  log "zapisano ${OUTPUT} (${RAW_SIZE} przed szyfrowaniem)"
else
  OUTPUT="$BACKUP_DIR/$BASENAME"
  mv "$TMP/$BASENAME" "$OUTPUT"
  log "UWAGA: brak BACKUP_PASSPHRASE — kopia NIE jest zaszyfrowana."
  log "zapisano ${OUTPUT} (${RAW_SIZE})"
fi

# --- Rotacja ----------------------------------------------------------------
DELETED="$(find "$BACKUP_DIR" -name "${POSTGRES_DB}-*.sql.gz*" -type f -mtime "+${KEEP_DAYS}" -print -delete | wc -l)"
[ "$DELETED" -gt 0 ] && log "usunięto ${DELETED} kopii starszych niż ${KEEP_DAYS} dni"

# --- Wysyłka na Telegram ----------------------------------------------------
if [ "$SEND_TO_TELEGRAM" = "1" ]; then
  if [ -z "${BOT_TOKEN:-}" ] || [ -z "${BACKUP_CHAT_ID:-}" ]; then
    log "pomijam wysyłkę: brak BOT_TOKEN lub BACKUP_CHAT_ID"
    exit 0
  fi

  SIZE_BYTES="$(stat -c %s "$OUTPUT")"
  LIMIT=$((50 * 1024 * 1024)) # limit sendDocument dla botów
  if [ "$SIZE_BYTES" -gt "$LIMIT" ]; then
    log "kopia ma $((SIZE_BYTES / 1024 / 1024)) MB — przekracza limit 50 MB Telegrama, nie wysyłam"
    curl -sS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -d chat_id="$BACKUP_CHAT_ID" \
      -d text="⚠️ Kopia bazy ($(basename "$OUTPUT")) ma $((SIZE_BYTES / 1024 / 1024)) MB i nie zmieściła się w limicie Telegrama. Leży w wolumenie backupów." \
      > /dev/null
    exit 0
  fi

  CAPTION="🗄️ Kopia bazy ${POSTGRES_DB}
📅 ${STAMP}
📦 $(du -h "$OUTPUT" | cut -f1)"
  [ -n "${BACKUP_PASSPHRASE:-}" ] && CAPTION="${CAPTION}
🔐 AES256 — do odczytu potrzebne hasło"

  log "wysyłam na czat ${BACKUP_CHAT_ID}…"
  RESPONSE="$(curl -sS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendDocument" \
    -F chat_id="$BACKUP_CHAT_ID" \
    -F document=@"$OUTPUT" \
    -F caption="$CAPTION")"

  if echo "$RESPONSE" | grep -q '"ok":true'; then
    log "wysłano"
  else
    log "BŁĄD wysyłki: $RESPONSE"
    exit 1
  fi
fi

log "gotowe"
```

# Plik: docker/backup/Dockerfile
```dockerfile
# Lekki kontener pomocniczy: pg_dump + gzip + gpg + curl na crondzie.
# Obraz waży ~40 MB, nie ma w nim Node ani kodu bota.
FROM alpine:3.20

# postgresql16-client MUSI odpowiadać wersji serwera (postgres:16-alpine),
# inaczej pg_dump odmówi zrzutu z nowszej bazy.
RUN apk add --no-cache \
      postgresql16-client \
      gnupg \
      curl \
      tzdata \
    && rm -rf /var/cache/apk/*

ENV TZ=Europe/Warsaw

COPY backup.sh /usr/local/bin/backup.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/entrypoint.sh

VOLUME ["/backups"]

# Healthcheck: baza osiągalna i katalog zapisywalny.
HEALTHCHECK --interval=5m --timeout=10s --start-period=30s \
  CMD pg_isready -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      && test -w /backups || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

# Plik: docker/backup/entrypoint.sh
```bash
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
```

# Plik: docker/backup/README.md
````markdown
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
````

# Plik: drizzle/0001_rework.sql
```sql
-- =============================================================================
-- Migracja 0001: przebudowa schematu po przeglądzie kodu
--
-- Zmiany danych, których `drizzle-kit push` nie zrobi za Ciebie:
--   • daily_records.fuel_price / fuel_liters  -> tabela fuel_receipts
--   • daily_records.fuel_distance (integer)   -> distance_km (numeric, dystans dnia)
--   • course_offers.total_distance            -> distance_total_km + rozbicie na odcinki
--   • wallet_transactions.external_id NULL    -> '' (NULL psuł unikalny indeks)
--   • balance_checkpoints                     -> ostatni checkpoint jako 'korekta'
--
-- ZRÓB KOPIĘ BAZY PRZED URUCHOMIENIEM:
--   pg_dump "$DATABASE_URL" > backup_$(date +%F).sql
-- =============================================================================

BEGIN;

-- --- 1. users: uzupełnienie i backfill ---------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name   text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamp NOT NULL DEFAULT now();

-- Tabela była pusta mimo danych w pozostałych tabelach (4.2).
INSERT INTO users (telegram_id)
SELECT DISTINCT telegram_id FROM daily_records
UNION SELECT DISTINCT telegram_id FROM cash_tips
UNION SELECT DISTINCT telegram_id FROM wallet_transactions
UNION SELECT DISTINCT telegram_id FROM course_offers
UNION SELECT DISTINCT telegram_id FROM earning_targets
ON CONFLICT (telegram_id) DO NOTHING;

-- --- 2. fuel_receipts: osobna tabela na paragony (2.8, 5.3) ------------------

CREATE TABLE IF NOT EXISTS fuel_receipts (
  id              serial PRIMARY KEY,
  telegram_id     text NOT NULL,
  date            date NOT NULL,
  total_cost      numeric(10, 2) NOT NULL,
  liters          numeric(10, 2),
  price_per_liter numeric(10, 3),
  created_at      timestamp NOT NULL DEFAULT now()
);

-- Przeniesienie istniejących danych. `fuel_price` mimo nazwy trzymało
-- kwotę CAŁEGO paragonu, więc idzie do total_cost.
INSERT INTO fuel_receipts (telegram_id, date, total_cost, liters, price_per_liter, created_at)
SELECT
  telegram_id,
  date,
  fuel_price,
  fuel_liters,
  CASE WHEN fuel_liters > 0 THEN ROUND(fuel_price / fuel_liters, 3) END,
  created_at
FROM daily_records
WHERE fuel_price IS NOT NULL AND fuel_price > 0;

CREATE INDEX IF NOT EXISTS fuel_receipts_user_date_idx ON fuel_receipts (telegram_id, date);

-- --- 3. daily_records: dystans dnia zamiast stanu licznika (2.7) -------------

ALTER TABLE daily_records ADD COLUMN IF NOT EXISTS distance_km numeric(10, 2);

-- UWAGA: jeżeli w fuel_distance zapisywałeś STANY LICZNIKA, a nie dystans dnia,
-- ten UPDATE przepisze bezsensowne wartości. Wtedy zamiast niego uruchom:
--   UPDATE daily_records SET distance_km = NULL;
-- i wpisz dystanse od nowa.
UPDATE daily_records SET distance_km = fuel_distance WHERE fuel_distance IS NOT NULL;

ALTER TABLE daily_records DROP COLUMN IF EXISTS fuel_distance;
ALTER TABLE daily_records DROP COLUMN IF EXISTS fuel_price;
ALTER TABLE daily_records DROP COLUMN IF EXISTS fuel_liters;

-- --- 4. wallet_transactions: naprawa deduplikacji (2.5) ----------------------

UPDATE wallet_transactions SET external_id = '' WHERE external_id IS NULL;
UPDATE wallet_transactions SET time = ''        WHERE time IS NULL;

-- Usunięcie duplikatów, które przeszły przez zepsuty indeks (NULL != NULL).
DELETE FROM wallet_transactions a
USING wallet_transactions b
WHERE a.id > b.id
  AND a.telegram_id = b.telegram_id
  AND a.date        = b.date
  AND a.time        = b.time
  AND a.type        = b.type
  AND a.amount      = b.amount
  AND a.external_id = b.external_id;

ALTER TABLE wallet_transactions ALTER COLUMN external_id SET DEFAULT '';
ALTER TABLE wallet_transactions ALTER COLUMN external_id SET NOT NULL;
ALTER TABLE wallet_transactions ALTER COLUMN time        SET DEFAULT '';
ALTER TABLE wallet_transactions ALTER COLUMN time        SET NOT NULL;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'OCR';

DROP INDEX IF EXISTS wallet_tx_dedup_idx;
CREATE UNIQUE INDEX wallet_tx_dedup_idx
  ON wallet_transactions (telegram_id, date, time, type, amount, external_id);
CREATE INDEX IF NOT EXISTS wallet_tx_user_date_idx ON wallet_transactions (telegram_id, date);

-- --- 5. balance_checkpoints -> korekta (2.2) ---------------------------------
-- Saldo liczymy teraz wyłącznie jako sumę transakcji. Żeby wyświetlana kwota
-- się nie zmieniła, zapisujemy różnicę jako transakcję typu 'korekta'.

INSERT INTO wallet_transactions (telegram_id, date, time, type, amount, external_id, source)
SELECT
  c.telegram_id,
  c.date,
  '00:00',
  'korekta',
  ROUND(
    c.balance_value
      + COALESCE((
          SELECT SUM(w.amount) FROM wallet_transactions w
          WHERE w.telegram_id = c.telegram_id AND w.date >= c.date
        ), 0)
      - COALESCE((
          SELECT SUM(w.amount) FROM wallet_transactions w
          WHERE w.telegram_id = c.telegram_id
        ), 0),
    2
  ),
  'migracja-checkpoint',
  'MANUAL'
FROM balance_checkpoints c
WHERE c.date = (
  SELECT MAX(c2.date) FROM balance_checkpoints c2 WHERE c2.telegram_id = c.telegram_id
)
ON CONFLICT DO NOTHING;

-- Wiersze o zerowej korekcie nie wnoszą nic poza szumem.
DELETE FROM wallet_transactions WHERE external_id = 'migracja-checkpoint' AND amount = 0;

DROP TABLE IF EXISTS balance_checkpoints;

-- --- 6. course_offers: rozbicie dystansu (2.3) -------------------------------

ALTER TABLE course_offers ADD COLUMN IF NOT EXISTS distance_pickup_km   numeric(10, 2);
ALTER TABLE course_offers ADD COLUMN IF NOT EXISTS distance_delivery_km numeric(10, 2);
ALTER TABLE course_offers ADD COLUMN IF NOT EXISTS distance_total_km    numeric(10, 2);
ALTER TABLE course_offers ADD COLUMN IF NOT EXISTS distance_source      text NOT NULL DEFAULT 'APP';
ALTER TABLE course_offers ADD COLUMN IF NOT EXISTS pickup_address       text;
ALTER TABLE course_offers ADD COLUMN IF NOT EXISTS delivery_address     text;

UPDATE course_offers SET distance_total_km = total_distance WHERE distance_total_km IS NULL;
UPDATE course_offers SET distance_total_km = 0 WHERE distance_total_km IS NULL;
ALTER TABLE course_offers ALTER COLUMN distance_total_km SET NOT NULL;

-- Adresy leżały w JSON-ie w kolumnie tekstowej.
UPDATE course_offers
SET pickup_address   = COALESCE(pickup_address,   points_json::json ->> 'pickup'),
    delivery_address = COALESCE(delivery_address, points_json::json ->> 'delivery')
WHERE points_json IS NOT NULL AND points_json <> '';

ALTER TABLE course_offers DROP COLUMN IF EXISTS total_distance;
ALTER TABLE course_offers DROP COLUMN IF EXISTS points_json;
ALTER TABLE course_offers DROP COLUMN IF EXISTS verification_text;

CREATE INDEX IF NOT EXISTS course_offers_user_date_idx ON course_offers (telegram_id, date);

-- --- 7. cash_tips: brakujący indeks (4.9) ------------------------------------

CREATE INDEX IF NOT EXISTS cash_tips_user_date_idx ON cash_tips (telegram_id, date);

-- --- 8. Klucze obce do users (4.2) -------------------------------------------

ALTER TABLE daily_records       ADD CONSTRAINT daily_records_user_fk
  FOREIGN KEY (telegram_id) REFERENCES users (telegram_id) ON DELETE CASCADE;
ALTER TABLE cash_tips           ADD CONSTRAINT cash_tips_user_fk
  FOREIGN KEY (telegram_id) REFERENCES users (telegram_id) ON DELETE CASCADE;
ALTER TABLE fuel_receipts       ADD CONSTRAINT fuel_receipts_user_fk
  FOREIGN KEY (telegram_id) REFERENCES users (telegram_id) ON DELETE CASCADE;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_user_fk
  FOREIGN KEY (telegram_id) REFERENCES users (telegram_id) ON DELETE CASCADE;
ALTER TABLE course_offers       ADD CONSTRAINT course_offers_user_fk
  FOREIGN KEY (telegram_id) REFERENCES users (telegram_id) ON DELETE CASCADE;
ALTER TABLE earning_targets     ADD CONSTRAINT earning_targets_user_fk
  FOREIGN KEY (telegram_id) REFERENCES users (telegram_id) ON DELETE CASCADE;

COMMIT;

-- =============================================================================
-- PO MIGRACJI: cele tygodniowe są teraz kluczowane ROKIEM ISO (2.10).
-- Jeżeli masz zapisane cele tygodniowe z przełomu roku, sprawdź je ręcznie:
--   SELECT * FROM earning_targets WHERE period_type = 'WEEKLY' ORDER BY year, period_value;
-- =============================================================================
```

# Plik: .dockerignore
```gitignore
# Bez tego `COPY . .` wciaga node_modules i .git do obrazu:
# build trwa dluzej, obraz puchnie, a modules skompilowane pod hosta
# potrafia nadpisac te zainstalowane w kontenerze.
node_modules
dist
.git
.gitignore

# Sekrety nie moga trafic do warstwy obrazu — zmienne i tak wchodzą
# przez `env_file` w docker-compose.yml.
.env
.env.*
!.env.example

# Backupy i dane lokalne
backups
data
*.sql.gz
*.gpg
# UWAGA: nie wykluczaj `*.sql` — skasowaloby to drizzle/0001_rework.sql,
# ktory bywa potrzebny z wnetrza kontenera przy migracji.

# Dokumentacja i artefakty
codebase.md
*.md
!README.md
```

# Plik: .gitignore
```gitignore
node_modules/
dist/
.env
data/
```

# Plik: drizzle.config.ts
```typescript
import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

# Plik: vitest.config.ts
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

# Plik: ZMIANY.md
````markdown
# GlovoBot — co się zmieniło

Przepisana wersja po przeglądzie kodu. Każda poprawka ma w kodzie komentarz `FIX (numer)` odsyłający do punktu z analizy, więc da się prześledzić po `grep -rn "FIX ("`.

---

## Nowa struktura

```
src/
  index.ts                     start bota, bot.catch, graceful shutdown
  config.ts                    CFG + lista dozwolonych telegram_id
  bot/
    index.ts                   rejestracja handlerów
    cards.ts                   renderowanie wiadomości (HTML)
    keyboards.ts               klawiatury (jedno źródło prawdy)
  services/
    finance.service.ts         operacje na bazie
    finance.calc.ts            NOWY — czysta arytmetyka rozliczeń, testowalna
    gemini.service.ts          Vision/audio + walidacja zod
    maps.service.ts            geokodowanie i dystanse
    user.service.ts            NOWY — upsert do tabeli users
  utils/
    datetime.ts                NOWY — cała logika dat w Europe/Warsaw
    format.ts                  NOWY — escapowanie HTML, formatowanie kwot
  db/
    schema.ts, index.ts
  scripts/import-sheets.ts
drizzle/0001_rework.sql        migracja danych
```

Testy: `src/utils/datetime.test.ts`, `src/services/finance.calc.test.ts` — `npm test`.

---

## Odpowiedzi na Twoje pytania

### 1.1 — dlaczego `"types": []` psuło build

W `tsconfig.json` opcja `types` mówi kompilatorowi, **które paczki typów globalnych automatycznie wczytać** z `node_modules/@types`. Domyślnie (bez tej opcji) TypeScript ładuje wszystkie, jakie znajdzie — w tym `@types/node`.

Ustawienie `"types": []` znaczy dosłownie „nie ładuj żadnych". Efekt: `process`, `Buffer`, `console`, `setInterval`, `fs`, `path` przestają istnieć z punktu widzenia kompilatora, mimo że `@types/node` siedzi w `devDependencies`. Ten sam problem dotyczył `lib` — bez `"lib": ["esnext"]` brakowało typów nowszych API JS.

To była linia z komentarzem `// For nodejs:` w wygenerowanym pliku startowym — instrukcja, żeby ją odkomentować, nigdy nie została wykonana. `npm run build` musiał sypać setkami błędów typu `Cannot find name 'process'`.

Teraz jest `"lib": ["esnext"]` i `"types": ["node"]`.

### 2.9 — o co chodziło z `calculateHours`

Stary kod:

```ts
let diffMinutes = tH * 60 + tM - (fH * 60 + fM);
if (diffMinutes < 0) diffMinutes += 24 * 60;
```

Ta linia jest potrzebna, bo zmiana `22:00 → 02:00` daje ujemną różnicę, a naprawdę trwała 4 h. Problem w tym, że kod nie odróżnia „przejścia przez północ" od **zwykłej pomyłki**.

Wpiszesz `10:00 → 09:00` (literówka, chodziło o `19:00`) — różnica to −60 minut, kod dodaje 24 h i zapisuje **23 godziny pracy**. Ta liczba wchodzi potem do:

- sumy godzin w `/tydzien` i `/miesiac`,
- stawki zł/h (nagle wychodzi 15 zł/h zamiast 45),
- prognozy w celach zarobkowych („zostało Ci 3 h dziennie" liczone złą stawką).

I nic nie sygnalizuje błędu. Drugi przypadek: `hours >= 0.25 ? hours : 0` — zmiana 10-minutowa zapisywała się po cichu jako 0 h, też bez słowa.

Teraz funkcja zwraca `{ hours, error }`. Przejście przez północ dalej działa, ale wynik powyżej 16 h albo poniżej 15 min zwraca `hours: null` plus komunikat, który bot dokleja do odpowiedzi: `⚠️ Zmiana 10:00-09:00 wychodzi 23.00 h (limit 16 h). Sprawdź godziny.`

### 2.4 — co to jest `walletCollections`

To była suma transakcji typu `pobranie` z danego dnia, czyli **gotówka pobrana od klientów przy dostawie**. Liczyło się to w `getDailySummary()` i… nigdzie nie było używane — ani w kartach, ani w raportach, ani w `doPrzelewu`. Martwa zmienna.

Zgodnie z Twoją decyzją (`pobranie` ma tylko aktualizować saldo) usunąłem ją z podsumowania dnia. Te transakcje dalej wpływają na saldo portfela, bo saldo to suma wszystkich kwot ze znakiem.

### 2.4 — „jak wypisać model rozliczenia na kartce"

Chodziło o to, żeby najpierw ustalić po ludzku, co jest czym, a dopiero potem pisać kod — bo w starej wersji `doPrzelewu` mieszało trzy różne intuicje w jednym wyrażeniu. Zrobiłem to za Ciebie i zapisałem w `finance.calc.ts`:

```
netEarnings   = brutto ze zleceń × 0.814      → trafi na konto
cashTips      = napiwki gotówkowe             → już w kieszeni
totalNetto    = netEarnings + cashTips        → ile kurier zarobił
walletPayouts = wyplata + wyplata_gotowka     → już wyszło z portfela
doPrzelewu    = netEarnings − walletPayouts   → co jeszcze przyjdzie
```

Trzy typy transakcji nie występują w tym rachunku w ogóle:

| typ | co robi |
|---|---|
| `pobranie` | tylko podnosi saldo portfela |
| `platnosc_punkt` | tylko obniża saldo portfela |
| `korekta` | tylko koryguje saldo portfela |

Zniknęło też `Math.max(0, ...)` — ujemne „do przelewu" jest teraz widoczne (test to pilnuje).

### 3.8 — czy była autoryzacja

Nie było żadnej. Każdy, kto znalazł nazwę bota, mógł wysłać `/dzis`, zdjęcie albo głosówkę — czyli czytać Twoje dane, zapisywać swoje i palić limit Gemini na Twoim kluczu. Handlery brały `ctx.from.id` i traktowały go jako właściciela danych.

Dodane: `ALLOWED_TELEGRAM_IDS` w `.env` (lista po przecinkach) i middleware, który odrzuca resztę z logiem. Pusta lista = bot otwarty, ale przy starcie leci ostrzeżenie w konsoli.

### 4.6 — te trzy funkcje

Mój punkt dotyczył **dopisania testów** do `calculateHours`, `getEffectiveDate`, `getWeekNumber` i `previewWalletImport` — to czyste funkcje, w których siedziała większość błędów. Usunięcie ich rozłożyłoby bota (nie ma jak wyznaczyć daty wpisu, klucza celu tygodniowego ani wykryć duplikatów).

Zgodnie z Twoim wyborem: funkcje zostają (poprawione i przeniesione do `utils/datetime.ts` oraz `services/finance.calc.ts`), a testy są dopisane — 8 grup asercji pokrywających dokładnie te przypadki, które wcześniej były błędne.

### 5.4 — dwie średnie stawki

`/statystyki` pokazuje teraz obie, bo mówią o czym innym:

```
📈 Średnia z ofert:  2.15 zł/km  — jakie oferty przychodzą
⚖️ Średnia ważona:   1.78 zł/km  — ile realnie wychodzi na km
```

Pierwsza to średnia arytmetyczna stawek (kurs 3 km waży tyle samo co 15 km). Druga to suma netto / suma km. Rozjazd między nimi mówi Ci, że krótkie kursy podbijają statystykę.

---

## Wykaz zmian

### Blokery

| # | Zmiana |
|---|---|
| 1.1 | `tsconfig.json`: `"lib": ["esnext"]`, `"types": ["node"]` |
| 1.2 | `import type` wszędzie, gdzie wymaga tego `verbatimModuleSyntax` (`Schema`, `Context`, `Telegraf`, typy z serwisów) |
| 1.3 | `import-sheets.ts`: `telegramId` jako string, dystans jako `numeric`, paliwo do nowej tabeli |

### Błędy logiczne

| # | Zmiana |
|---|---|
| 2.1 | Cała logika dat w `utils/datetime.ts`, strefa `Europe/Warsaw`. **Doba kończy się o północy — wpis o 01:00 należy do nowego dnia.** Zniknęło cofanie nocnych zmian i `adjustDateForNightShift()` |
| 2.2 | Tabela `balance_checkpoints` usunięta. Saldo = suma `wallet_transactions.amount`. Ręczny wpis zapisuje się jako transakcja `korekta` (Twój wybór), więc historia zostaje audytowalna |
| 2.3 | `course_offers`: kolumny `distance_pickup_km`, `distance_delivery_km`, `distance_total_km` + `distance_source`. `verifyOfferDistance()` liczy oba odcinki, stawka zawsze z całej trasy |
| 2.4 | `doPrzelewu` rozpisane wprost w `finance.calc.ts`, bez skracających się napiwków i bez `Math.max(0, ...)` |
| 2.5 | `external_id` i `time` `NOT NULL DEFAULT ''`, klucz dedupu identyczny z unikalnym indeksem, `.onConflictDoNothing()` przy insercie |
| 2.6 | `previewWalletImport()`: jedno zapytanie zamiast N, wykrywa też duplikaty wewnątrz jednego zrzutu |
| 2.7 | `fuel_distance` → `distance_km` (`numeric`). To **dystans przejechany danego dnia**, nie stan licznika — prompty Gemini i teksty przycisków mówią to wprost |
| 2.8 | Nowa tabela `fuel_receipts`. Wiele tankowań dziennie sumuje się zamiast nadpisywać |
| 2.9 | `calculateHours()` zwraca `{ hours, error }` z limitem 16 h |
| 2.10 | Cele tygodniowe kluczowane **rokiem ISO** (`isoWeek` zwraca `{ year, week }`) |

### Warstwa bota

| # | Zmiana |
|---|---|
| 3.1 | Komendy rejestrowane przed handlerem tekstowym + middleware czyszczący stan przy każdym `/`. Doszło `/anuluj`, przycisk „✖️ Anuluj" i TTL 5 min |
| 3.2 | TTL na wszystkich mapach stanu + sweeper co 60 s (dalej pamięć procesu — świadomy kompromis, opisany w komentarzu) |
| 3.3 | Cały bot na `parse_mode: 'HTML'`, każda wartość od użytkownika/modelu przez `h()` |
| 3.4 | `bot.catch()` + graceful shutdown zamykający pulę Postgresa |
| 3.5 | `bot.launch()` z własnym `.catch()`, komunikat startowy z `getMe()` (weryfikuje też token) |
| 3.6 | Karta oferty przerysowywana z danych z bazy zamiast doklejania linii statusu |
| 3.7 | `updateCourseOfferStatus()` zwraca zaktualizowany wiersz; brak trafienia = alert, nie fałszywe „ZAAKCEPTOWANO" |
| 3.8 | `ALLOWED_TELEGRAM_IDS` + middleware autoryzacji |
| 3.9 | Sprawdzanie `file_size` przed pobraniem, limit po pobraniu, timeout 30 s |
| 3.10 | Wszystkie odpowiedzi Gemini walidowane zod, jeden retry przy błędzie parsowania |

### Porządki

| # | Zmiana |
|---|---|
| 4.1 | `src/gemini.ts` usunięty |
| 4.2 | `users` zapisywane przy każdej interakcji + klucze obce z pozostałych tabel |
| 4.3 | `TOLERANCJA_KM` i `HISTORY_LEN` usunięte; `MAX_AUDIO_BYTES`/`MAX_PHOTO_BYTES` są teraz faktycznie używane |
| 4.4 | Podwójne eksporty `TAX_FACTOR` / `NETTO_FACTOR` / `MIN_STAWKA_NETTO_KM` usunięte |
| 4.5 | `walletCollections` usunięte |
| 4.6 | Testy dopisane, funkcje zostają |
| 4.7 | `.filter(Boolean)` → `compact()` z type guardem |
| 4.8 | Klawiatury w `bot/keyboards.ts` |
| 4.9 | Indeksy na `cash_tips`, `course_offers`, `fuel_receipts`, `wallet_transactions` |

### Dziedzinowe

| # | Zmiana |
|---|---|
| 5.1 | `NETTO_FACTOR` bez zmian (0.814) |
| 5.2 | Paliwo dalej nie pomniejsza „czystego netto" |
| 5.3 | `fuel_receipts` trzyma `total_cost` **i** `price_per_liter`; Gemini wyciąga oba z paragonu |
| 5.4 | `/statystyki` pokazuje średnią z ofert i średnią ważoną |
| 5.5 | Sentinel `999` zastąpiony przez `null` |
| 5.6 | `gemini-3.7-flash` w jednym miejscu (`CFG.GEMINI_MODEL`, nadpisywalne przez env) |

---

## Wdrożenie

```bash
npm install
cp .env.example .env        # uzupełnij BOT_TOKEN, DATABASE_URL, GEMINI_API_KEY, ALLOWED_TELEGRAM_IDS

pg_dump "$DATABASE_URL" > backup_$(date +%F).sql   # KONIECZNIE
psql "$DATABASE_URL" -f drizzle/0001_rework.sql

npm run typecheck
npm test
npm run dev
```

### Na co uważać przy migracji

1. **`fuel_distance` → `distance_km`.** Migracja przepisuje wartości 1:1. Jeżeli zapisywałeś tam **stany licznika**, a nie dystans dnia, te liczby są bezużyteczne — w SQL-u jest zakomentowana alternatywa (`SET distance_km = NULL`).

2. **Saldo portfela.** Migracja przelicza ostatni checkpoint na transakcję `korekta`, żeby wyświetlana kwota się nie zmieniła. Po wdrożeniu porównaj `/saldo` z aplikacją Glovo i w razie czego wyrównaj przez `/saldo <kwota>`.

3. **Duplikaty transakcji.** Migracja kasuje wiersze, które przeszły przez zepsuty indeks. Przed uruchomieniem możesz je policzyć:

```sql
SELECT telegram_id, date, time, type, amount, external_id, COUNT(*)
FROM wallet_transactions
GROUP BY 1,2,3,4,5,6 HAVING COUNT(*) > 1;
```

4. **Cele tygodniowe** z przełomu roku mogą siedzieć pod starym kluczem (rok kalendarzowy). Sprawdź `SELECT * FROM earning_targets WHERE period_type = 'WEEKLY'`.

---

## Czego nie ruszałem

- **Stan w pamięci procesu.** `awaitingInput`, `pendingWalletImports` i `lastCourierLocation` dalej giną przy restarcie. Dodałem TTL i sprzątanie, ale przy jednym użytkowniku przenoszenie tego do Postgresa to przerost formy. Gdyby botów miało być więcej — to pierwsza rzecz do zmiany.
- **Podatki.** `NETTO_FACTOR` to dalej płaskie 18,6% (Twoja decyzja 5.1).
- **Paliwo w rozliczeniu.** Koszt paliwa jest zbierany i raportowany, ale nie pomniejsza `grandTotalNetto` (Twoja decyzja 5.2). Warto do tego wrócić — dla kuriera na motocyklu to główny koszt, więc stawka zł/h jest dziś zawyżona.
- **Wersja `gemini-3.7-flash`** — wpisana zgodnie z tym, co podałeś, do zmiany przez `GEMINI_MODEL` w `.env` bez ruszania kodu.

---

## Weryfikacja

Nie miałem w tym środowisku dostępu do rejestru npm, więc `tsc` i `vitest` nie mogły się uruchomić. Zamiast tego:

- wszystkie pliki `.ts` przeszły sprawdzenie składni,
- czysta logika (`finance.calc.ts` i `datetime.ts`) została **uruchomiona z prawdziwych źródeł** i przeszła 8 grup asercji odpowiadających plikom testowym — daty i strefy czasowe, tygodnie ISO, rozliczenia, deduplikacja, stawki kursów, godziny pracy.

Po `npm install` u siebie odpal `npm run typecheck && npm test` — to domknie weryfikację warstwy typów, której tutaj nie dało się sprawdzić.
````
