import { sql } from 'drizzle-orm';
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
 *
 * P3 (19.08.2026): z tego samego powodu wyszly stad GODZINY. `work_from`,
 * `work_to` i `work_hours` byly jedna para na dobe, wiec drugi wyjazd tego
 * samego dnia nadpisywal pierwszy. Teraz kazda zmiana to wiersz w
 * `work_sessions`, a suma godzin doby liczy sie z sumy sesji — nie ma juz
 * kolumny, ktora moglaby sie z nia rozjechac.
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
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    userDateIdx: uniqueIndex('daily_records_user_date_idx').on(table.telegramId, table.date),
  })
);

/**
 * Jedna ZMIANA = jeden wiersz. Doba moze miec ich wiele.
 *
 * Powod: `daily_records` trzyma JEDNA pare `work_from`/`work_to` na dzien,
 * pilnowana unikalnym indeksem na (telegram_id, date). Drugi wyjazd tego
 * samego dnia nadpisywal pierwszy i pierwsza zmiana znikala bez sladu —
 * dlatego przycisk zmiany w aplikacji wyszarza sie po zamknieciu pierwszej.
 *
 * Kolumny godzinowe w `daily_records` zostaja na czas P1 i P2 — usuwa je P3,
 * razem z kodem, ktory z nich czyta. Rozdzielenie jest celowe: usuniecie ich
 * teraz wywalilo by `npm run typecheck` na siedmiu odwolaniach w
 * `finance.service.ts`, ktore znikaja dopiero w P3.
 */
export const workSessions = pgTable(
  'work_sessions',
  {
    id: serial('id').primaryKey(),
    telegramId: text('telegram_id')
      .notNull()
      .references(() => users.telegramId, { onDelete: 'cascade' }),
    /**
     * Doba, do ktorej nalezy zmiana = data WYJAZDU.
     *
     * Zmiana 23:50 -> 02:10 CALA idzie na dzien wyjazdu. To nie jest wyjatek
     * od reguly „doba konczy sie o polnocy" (2.1) — ta regula mowi, do ktorego
     * dnia trafia WPIS robiony teraz, a nie jak dzielic zmiane na dwie doby.
     */
    date: date('date').notNull(),
    /** Godzina wyjazdu `GG:MM`. Zmiana bez poczatku nie istnieje. */
    workFrom: text('work_from').notNull(),
    /** Godzina zjazdu `GG:MM`. NULL = zmiana TRWA. */
    workTo: text('work_to'),
    /** Skad wpis: 'BOT' | 'APP' | 'VOICE' | 'IMPORT'. */
    source: text('source').notNull().default('BOT'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    userDateIdx: index('work_sessions_user_date_idx').on(table.telegramId, table.date),
    /**
     * JEDNA otwarta zmiana na kuriera — pilnowana przez baze, nie przez kod.
     *
     * To indeks CZESCIOWY i nie jest to obejscie pulapki 2.5 („NULL != NULL
     * psuje unikalne indeksy"). Tam problem polegal na tym, ze kolumna
     * NULL-owalna WCHODZILA w sklad klucza; tutaj unikalnosc stoi na samym
     * `telegram_id`, a `WHERE work_to IS NULL` jedynie zaweza zbior wierszy,
     * ktorych indeks dotyczy.
     *
     * Praktyczny skutek: powtorzony `POST /api/v1/zmiana` bez naglowka
     * `Idempotency-Key` odbija sie od bazy zamiast dopisac druga otwarta
     * zmiane. Ochrona dziala nawet wtedy, gdy kod o niej zapomni.
     */
    otwartaIdx: uniqueIndex('work_sessions_otwarta_idx')
      .on(table.telegramId)
      .where(sql`work_to is null`),
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

/**
 * Pamiec idempotencji dla `POST /api/v1/*` (krok 5 planu aplikacji).
 *
 * Powod: `saveCashTip` i `saveFuelReceipt` to czyste `INSERT` — celowo, bo
 * drugie tankowanie tego samego dnia ma sie dodawac (FIX 2.8). Kolejka offline
 * ponawia zadania, wiec bez tej tabeli kazde ponowienie tworzyloby DRUGI wpis.
 *
 * Klient generuje `Idempotency-Key` (UUID) i wysyla go w naglowku. Ten sam
 * klucz drugi raz nie wykonuje operacji, tylko odsyla zapamietana odpowiedz.
 *
 * `key` jest KLUCZEM GLOWNYM, nie unikalnym indeksem na kolumnie nullowalnej.
 * W Postgresie `NULL != NULL`, wiec taki indeks nie blokowalby duplikatow (9a).
 *
 * `status_code = 0` oznacza wiersz ZAJETY, ale jeszcze nierozstrzygniety —
 * pierwsze zadanie trwa. To jest mechanizm blokady, nie stan koncowy.
 *
 * `response_json` to `text`, nie `jsonb`: odpowiedz jest odsylana doslownie
 * i nigdy po niej nie szukamy.
 */
export const apiIdempotency = pgTable(
  'api_idempotency',
  {
    key: text('key').primaryKey(),
    telegramId: text('telegram_id')
      .notNull()
      .references(() => users.telegramId, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    /** 0 = zadanie w toku. >0 = zapamietany kod odpowiedzi. */
    statusCode: integer('status_code').notNull(),
    responseJson: text('response_json').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    // Wylacznie pod sprzatanie starych wierszy.
    apiIdempotencyCreatedAtIdx: index('api_idempotency_created_at_idx').on(table.createdAt),
  })
);

/**
 * Ostatnia znana pozycja kuriera — JEDEN WIERSZ NA UZYTKOWNIKA.
 *
 * Dlaczego w bazie, a nie w pamieci procesu: `lastCourierLocation` w
 * `bot/index.ts` to zwykla `Map`, ktora ginie przy restarcie (10e). Oferta
 * potrafi przyjsc minute po `docker compose up -d --build bot`, a wtedy bot
 * nie ma pozycji i liczy dojazd od niczego.
 *
 * Dlaczego bez historii: do naprawy 8f wystarczy „gdzie jestes TERAZ".
 * Historia przejazdu to osobny temat (liczenie realnego dystansu zamiast
 * wpisywania go recznie) i osobna decyzja — przy odczycie co 20 s to setki
 * wierszy dziennie i wlasny problem czyszczenia.
 *
 * `recorded_at` to moment ZLAPANIA pozycji, nie moment zapisu. Roznica ma
 * znaczenie przy kolejce offline, gdzie odczyt lezy kilkadziesiat sekund
 * zanim dojdzie. Telefon przysyla WIEK odczytu, a nie znacznik czasu —
 * wiek jest wielkoscia wzgledna, wiec nie ma w nim zegara, ktory moglby byc
 * przestawiony (8a).
 */
export const courierLocations = pgTable('courier_locations', {
  telegramId: text('telegram_id')
    .primaryKey()
    .references(() => users.telegramId, { onDelete: 'cascade' }),
  latitude: numeric('latitude', { precision: 9, scale: 6 }).notNull(),
  longitude: numeric('longitude', { precision: 9, scale: 6 }).notNull(),
  /** Promien niepewnosci w metrach, tak jak podaje go GPS. `null` = nie podano. */
  accuracyM: integer('accuracy_m'),
  /**
   * Predkosc w metrach na sekunde w chwili odczytu. `null` = GPS nie podal.
   *
   * To NIE jest ciekawostka — od niej zalezy, jak dlugo pozycja jest cokolwiek
   * warta. Przy 100 km/h pozycja sprzed minuty jest o 1,7 km obok.
   */
  speedMps: numeric('speed_mps', { precision: 6, scale: 2 }),
  /** `APP` (automat z telefonu) albo `TELEGRAM` (przypieta pinezka). */
  source: text('source').default('APP').notNull(),
  recordedAt: timestamp('recorded_at').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
