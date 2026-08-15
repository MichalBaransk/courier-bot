import { pgTable, serial, bigint, varchar, timestamp, numeric, text, boolean, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  telegramId: bigint('telegram_id', { mode: 'number' }).notNull().unique(),
  username: varchar('username', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Zakładka "Dane"
export const dailyRecords = pgTable('daily_records', {
  id: serial('id').primaryKey(),
  telegramId: bigint('telegram_id', { mode: 'number' }).notNull(),
  date: varchar('date', { length: 10 }).notNull(), // Format YYYY-MM-DD
  fuelPrice: numeric('fuel_price', { precision: 10, scale: 2 }),
  fuelLiters: numeric('fuel_liters', { precision: 10, scale: 2 }),
  fuelDistance: numeric('fuel_distance', { precision: 10, scale: 2 }),
  grossEarnings: numeric('gross_earnings', { precision: 10, scale: 2 }),
  workFrom: varchar('work_from', { length: 5 }), // GG:MM
  workTo: varchar('work_to', { length: 5 }),     // GG:MM
  workHours: numeric('work_hours', { precision: 5, scale: 2 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('user_date_idx').on(table.telegramId, table.date)
]);

// Zakładka "Napiwki"
export const cashTips = pgTable('cash_tips', {
  id: serial('id').primaryKey(),
  telegramId: bigint('telegram_id', { mode: 'number' }).notNull(),
  date: varchar('date', { length: 10 }).notNull(), // Format YYYY-MM-DD
  amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Zakładka "Portfel"
export const walletTransactions = pgTable('wallet_transactions', {
  id: serial('id').primaryKey(),
  telegramId: bigint('telegram_id', { mode: 'number' }).notNull(),
  date: varchar('date', { length: 10 }).notNull(),
  time: varchar('time', { length: 5 }).notNull(),
  type: varchar('type', { length: 50 }).notNull(), // pobranie | wyplata | wyplata_gotowka | platnosc_punkt | korekta
  amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
  externalId: varchar('external_id', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('wallet_dedup_idx').on(table.telegramId, table.date, table.time, table.type, table.amount, table.externalId)
]);

// Zakładka "Oferty"
export const courseOffers = pgTable('course_offers', {
  id: serial('id').primaryKey(),
  telegramId: bigint('telegram_id', { mode: 'number' }).notNull(),
  date: varchar('date', { length: 10 }).notNull(),
  time: varchar('time', { length: 5 }).notNull(),
  grossAmount: numeric('gross_amount', { precision: 10, scale: 2 }).notNull(),
  netAmount: numeric('net_amount', { precision: 10, scale: 2 }).notNull(),
  totalDistance: numeric('total_distance', { precision: 10, scale: 2 }),
  netRatePerKm: numeric('net_rate_per_km', { precision: 10, scale: 2 }),
  isProfitable: boolean('is_profitable'),
  pointsJson: jsonb('points_json'),
  verificationText: text('verification_text'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Punkty bazowe salda Glovo
export const balanceCheckpoints = pgTable('balance_checkpoints', {
  id: serial('id').primaryKey(),
  telegramId: bigint('telegram_id', { mode: 'number' }).notNull(),
  date: varchar('date', { length: 10 }).notNull(),
  balanceValue: numeric('balance_value', { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('user_balance_cp_idx').on(table.telegramId, table.date)
]);