import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import 'dotenv/config';
import { closeDb, db } from '../db/index.js';
import { dailyRecords, workSessions, cashTips, fuelReceipts, walletTransactions } from '../db/schema.js';
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
  let importedSessions = 0;

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

    await db
      .insert(dailyRecords)
      .values({
        telegramId: TELEGRAM_ID,
        date,
        distanceKm: distance != null ? distance.toFixed(2) : null,
        grossEarnings: gross != null ? gross.toFixed(2) : null,
      })
      .onConflictDoNothing();
    importedDays++;

    // Godziny ida do `work_sessions` (P3). Arkusz mial jedna pare na dzien,
    // wiec z kazdego wiersza wychodzi najwyzej jedna zmiana.
    //
    // Kolumna 15 arkusza (liczba godzin) jest CELOWO ignorowana: `work_sessions`
    // nie przechowuje dlugosci, tylko ja liczy. Import wartosci, ktora sie
    // z godzinami nie zgadza, byloby wpuszczeniem sprzecznosci do bazy.
    if (workFrom && workTo) {
      await db
        .insert(workSessions)
        .values({ telegramId: TELEGRAM_ID, date, workFrom, workTo, source: 'IMPORT' })
        .onConflictDoNothing();
      importedSessions++;
    }

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

  console.log(
    `✅ Zaimportowano ${importedDays} wpisów dziennych, ${importedSessions} zmian i ${importedFuel} paragonów z dane.csv`
  );
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
