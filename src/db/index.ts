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
