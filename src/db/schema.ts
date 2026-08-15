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
    /** Kurier -> punkt odbioru. */
    distancePickupKm: numeric('distance_pickup_km', { precision: 10, scale: 2 }),
    /** Punkt odbioru -> klient. */
    distanceDeliveryKm: numeric('distance_delivery_km', { precision: 10, scale: 2 }),
    /** Suma odcinkow - podstawa wyliczenia stawki zl/km. */
    distanceTotalKm: numeric('distance_total_km', { precision: 10, scale: 2 }).notNull(),
    /** 'MAPS' = zweryfikowane Google Maps, 'APP' = deklaracja z aplikacji Glovo. */
    distanceSource: text('distance_source').notNull().default('APP'),
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
