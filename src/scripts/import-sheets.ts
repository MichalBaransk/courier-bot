import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import 'dotenv/config';
import { db } from '../db/index.js';
import { dailyRecords, cashTips, walletTransactions } from '../db/schema.js';

// Twój Telegram ID, do którego zostaną przypisane rekordy
const TELEGRAM_ID = 5066453902;

function parsePlNum(val: any): string | null {
  if (!val || typeof val !== 'string') return null;
  const clean = val.trim().replace(/\s/g, '').replace(',', '.').replace(/[^0-9.-]/g, '');
  if (!clean || isNaN(Number(clean))) return null;
  return clean;
}

function parseDate(val: any): string | null {
  if (!val || typeof val !== 'string') return null;
  const s = val.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
  if (m) {
    return `${m[3]}-${('0' + m[2]).slice(-2)}-${('0' + m[1]).slice(-2)}`;
  }
  return null;
}

async function importDane() {
  const filePath = path.resolve('data/dane.csv');
  if (!fs.existsSync(filePath)) {
    console.log('ℹ️ Brak pliku data/dane.csv — pomijam.');
    return;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const records = parse(content, { skip_empty_lines: true, relax_column_count: true });

  let imported = 0;
  // Pomijamy wiersz 1 (nagłówki)
  for (let i = 1; i < records.length; i++) {
    const row = records[i];
    const dateStr = parseDate(row[0]);

    // Ignoruj wiersz SUMA i puste daty[cite: 1]
    if (!dateStr || row[0]?.toString().trim().toUpperCase() === 'SUMA') continue;

    await db.insert(dailyRecords).values({
      telegramId: TELEGRAM_ID,
      date: dateStr,
      fuelPrice: parsePlNum(row[2]),     // Paliwo (zł)[cite: 1]
      fuelLiters: parsePlNum(row[3]),    // Litry[cite: 1]
      fuelDistance: parsePlNum(row[4]),  // Dystans (km)[cite: 1]
      grossEarnings: parsePlNum(row[8]), // Brutto[cite: 1]
      workFrom: row[13]?.trim() || null, // Praca od[cite: 1]
      workTo: row[14]?.trim() || null,   // Praca do[cite: 1]
      workHours: parsePlNum(row[15]),    // Godziny[cite: 1]
    }).onConflictDoNothing();

    imported++;
  }
  console.log(`✅ Zaimportowano ${imported} wpisów dziennych z dane.csv`);
}

async function importNapiwki() {
  const filePath = path.resolve('data/napiwki.csv');
  if (!fs.existsSync(filePath)) {
    console.log('ℹ️ Brak pliku data/napiwki.csv — pomijam.');
    return;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const records = parse(content, { skip_empty_lines: true, relax_column_count: true });

  let imported = 0;
  for (let i = 1; i < records.length; i++) {
    const row = records[i];
    const dateStr = parseDate(row[0]);
    const amount = parsePlNum(row[1]);

    if (!dateStr || !amount) continue;

    await db.insert(cashTips).values({
      telegramId: TELEGRAM_ID,
      date: dateStr,
      amount: amount,
    });
    imported++;
  }
  console.log(`✅ Zaimportowano ${imported} napiwków z napiwki.csv`);
}

async function importPortfel() {
  const filePath = path.resolve('data/portfel.csv');
  if (!fs.existsSync(filePath)) {
    console.log('ℹ️ Brak pliku data/portfel.csv — pomijam.');
    return;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const records = parse(content, { skip_empty_lines: true, relax_column_count: true });

  let imported = 0;
  for (let i = 1; i < records.length; i++) {
    const row = records[i];
    const dateStr = parseDate(row[0]);
    const timeStr = row[1]?.trim() || '00:00';
    const typeStr = row[2]?.trim();
    const amount = parsePlNum(row[3]);
    const extId = row[4]?.trim() || null;

    if (!dateStr || !typeStr || !amount) continue;

    await db.insert(walletTransactions).values({
      telegramId: TELEGRAM_ID,
      date: dateStr,
      time: timeStr,
      type: typeStr,
      amount: amount,
      externalId: extId,
    }).onConflictDoNothing();

    imported++;
  }
  console.log(`✅ Zaimportowano ${imported} transakcji z portfel.csv`);
}

async function run() {
  console.log('🚀 Rozpoczynam import danych z Google Sheets...');
  await importDane();
  await importNapiwki();
  await importPortfel();
  console.log('🎉 Migracja zakończona sukcesem!');
  process.exit(0);
}

run().catch((err) => {
  console.error('❌ Błąd podczas importu:', err);
  process.exit(1);
});