import {
  pgTable,
  serial,
  text,
  numeric,
  integer,
  boolean,
  timestamp,
  date,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  telegramId: text('telegram_id').notNull().unique(),
  username: text('username'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const dailyRecords = pgTable(
  'daily_records',
  {
    id: serial('id').primaryKey(),
    telegramId: text('telegram_id').notNull(),
    date: date('date').notNull(),
    fuelPrice: numeric('fuel_price', { precision: 10, scale: 2 }),
    fuelLiters: numeric('fuel_liters', { precision: 10, scale: 2 }),
    fuelDistance: integer('fuel_distance'),
    grossEarnings: numeric('gross_earnings', { precision: 10, scale: 2 }),
    workFrom: text('work_from'),
    workTo: text('work_to'),
    workHours: numeric('work_hours', { precision: 5, scale: 2 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    userDateIdx: uniqueIndex('daily_records_user_date_idx').on(
      table.telegramId,
      table.date
    ),
  })
);

export const cashTips = pgTable('cash_tips', {
  id: serial('id').primaryKey(),
  telegramId: text('telegram_id').notNull(),
  date: date('date').notNull(),
  amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const walletTransactions = pgTable(
  'wallet_transactions',
  {
    id: serial('id').primaryKey(),
    telegramId: text('telegram_id').notNull(),
    date: date('date').notNull(),
    time: text('time'),
    type: text('type').notNull(), // 'pobranie' | 'wyplata' | 'wyplata_gotowka' | 'platnosc_punkt' | 'korekta'
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    externalId: text('external_id'),
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
  })
);

export const balanceCheckpoints = pgTable(
  'balance_checkpoints',
  {
    id: serial('id').primaryKey(),
    telegramId: text('telegram_id').notNull(),
    date: date('date').notNull(),
    balanceValue: numeric('balance_value', { precision: 10, scale: 2 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    checkpointUserDateIdx: uniqueIndex('balance_checkpoint_user_date_idx').on(
      table.telegramId,
      table.date
    ),
  })
);

export const courseOffers = pgTable('course_offers', {
  id: serial('id').primaryKey(),
  telegramId: text('telegram_id').notNull(),
  date: date('date').notNull(),
  time: text('time').notNull(),
  grossAmount: numeric('gross_amount', { precision: 10, scale: 2 }).notNull(),
  netAmount: numeric('net_amount', { precision: 10, scale: 2 }).notNull(),
  totalDistance: numeric('total_distance', { precision: 10, scale: 2 }).notNull(),
  netRatePerKm: numeric('net_rate_per_km', { precision: 10, scale: 2 }).notNull(),
  isProfitable: boolean('is_profitable').notNull(),
  pointsJson: text('points_json'),
  verificationText: text('verification_text'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const earningTargets = pgTable(
  'earning_targets',
  {
    id: serial('id').primaryKey(),
    telegramId: text('telegram_id').notNull(),
    periodType: text('period_type').notNull(), // 'MONTHLY' | 'WEEKLY'
    targetAmount: numeric('target_amount', { precision: 10, scale: 2 }).notNull(),
    year: integer('year').notNull(),
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