import { db } from '../db/index.js';
import { dailyRecords, cashTips, walletTransactions, balanceCheckpoints, courseOffers } from '../db/schema.js';
import { CFG } from '../config.js';
import { eq, and, sql, desc, gte, lte } from 'drizzle-orm';

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function fmt(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === '') return '';
  const num = typeof n === 'string' ? parseFloat(n) : n;
  if (isNaN(num)) return '';
  const r = round2(num);
  return (r % 1 === 0 ? String(r) : r.toFixed(2)).replace('.', ',');
}

export function getWorkDate(date: Date = new Date()): string {
  const d = new Date(date);
  const hour = d.getHours();
  // Reguła nocna: wpis między 00:00 a 03:59 należy do poprzedniego dnia roboczego
  if (hour >= 0 && hour < 4) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

export function normalizeTime(timeStr: string | null | undefined): string | null {
  if (!timeStr) return null;
  const s = timeStr.trim();
  const m1 = s.match(/^(\d{1,2})[:.](\d{2})$/);
  if (m1) {
    const h = parseInt(m1[1], 10), min = parseInt(m1[2], 10);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      return ('0' + h).slice(-2) + ':' + ('0' + min).slice(-2);
    }
  }
  const m2 = s.match(/^(\d{1,2})$/);
  if (m2) {
    const h = parseInt(m2[1], 10);
    if (h >= 0 && h <= 23) return ('0' + h).slice(-2) + ':00';
  }
  return null;
}

export function calculateHoursFromRange(from: string, to: string): number | null {
  const normFrom = normalizeTime(from);
  const normTo = normalizeTime(to);
  if (!normFrom || !normTo) return null;

  const [h1, m1] = normFrom.split(':').map(Number);
  const [h2, m2] = normTo.split(':').map(Number);
  let diffMin = (h2 * 60 + m2) - (h1 * 60 + m1);
  if (diffMin <= 0) diffMin += 24 * 60; // Praca przez północ
  return round2(diffMin / 60);
}

export function parseQuickTip(text: string): number | null {
  const s = text.trim();
  const m = s.match(/^(?:n|np|nap|napiwek|napiwki)\s*[:=]?\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:z[łl]|pln)?\s*$/i);
  if (!m) return null;
  const kwota = parseFloat(m[1].replace(',', '.'));
  return isNaN(kwota) || kwota <= 0 ? null : round2(kwota);
}

export function parseQuickWorkRange(text: string): { from: string; to: string } | null {
  const m = text.match(/(?:od\s+)?(\d{1,2}(?:[:.]\d{2})?)\s*(?:-|–|do)\s*(\d{1,2}(?:[:.]\d{2})?)/i);
  if (!m) return null;
  const from = normalizeTime(m[1]);
  const to = normalizeTime(m[2]);
  return from && to ? { from, to } : null;
}

export async function saveCashTip(telegramId: number, amount: number, dateStr: string) {
  await db.insert(cashTips).values({
    telegramId,
    date: dateStr,
    amount: amount.toString(),
  });

  const tips = await db.select().from(cashTips).where(
    and(eq(cashTips.telegramId, telegramId), eq(cashTips.date, dateStr))
  );

  const total = tips.reduce((acc, curr) => acc + parseFloat(curr.amount), 0);
  return { sum: round2(total), count: tips.length };
}

export async function undoLastCashTip(telegramId: number) {
  const [last] = await db.select().from(cashTips)
    .where(eq(cashTips.telegramId, telegramId))
    .orderBy(desc(cashTips.id))
    .limit(1);

  if (!last) return 'ℹ️ Brak zapisanych napiwków do cofnięcia.';

  await db.delete(cashTips).where(eq(cashTips.id, last.id));
  const remaining = await db.select().from(cashTips).where(
    and(eq(cashTips.telegramId, telegramId), eq(cashTips.date, last.date))
  );
  const sum = remaining.reduce((acc, curr) => acc + parseFloat(curr.amount), 0);

  return `↩️ Cofnięto ostatni napiwek: ${fmt(last.amount)} zł z ${last.date}.\nPozostało w tym dniu: ${fmt(sum)} zł.`;
}

export async function getTipsForDay(telegramId: number, dateStr: string) {
  const tips = await db.select().from(cashTips).where(
    and(eq(cashTips.telegramId, telegramId), eq(cashTips.date, dateStr))
  );
  if (!tips.length) return `ℹ️ Brak napiwków na ${dateStr}.`;

  const total = tips.reduce((acc, curr) => acc + parseFloat(curr.amount), 0);
  const list = tips.map(t => `• ${fmt(t.amount)} zł`).join('\n');
  return `💸 Napiwki ${dateStr}\n\n${list}\n\nRazem: ${fmt(total)} zł (${tips.length} szt.)`;
}

export async function saveDailyRecord(
  telegramId: number,
  dateStr: string,
  data: {
    grossEarnings?: number | null;
    fuelPrice?: number | null;
    fuelLiters?: number | null;
    fuelDistance?: number | null;
    workFrom?: string | null;
    workTo?: string | null;
    workHours?: number | null;
  }
) {
  const existing = await db.select().from(dailyRecords).where(
    and(eq(dailyRecords.telegramId, telegramId), eq(dailyRecords.date, dateStr))
  );

  const payload = {
    telegramId,
    date: dateStr,
    grossEarnings: data.grossEarnings !== undefined ? (data.grossEarnings?.toString() || null) : existing[0]?.grossEarnings,
    fuelPrice: data.fuelPrice !== undefined ? (data.fuelPrice?.toString() || null) : existing[0]?.fuelPrice,
    fuelLiters: data.fuelLiters !== undefined ? (data.fuelLiters?.toString() || null) : existing[0]?.fuelLiters,
    fuelDistance: data.fuelDistance !== undefined ? (data.fuelDistance?.toString() || null) : existing[0]?.fuelDistance,
    workFrom: data.workFrom !== undefined ? data.workFrom : existing[0]?.workFrom,
    workTo: data.workTo !== undefined ? data.workTo : existing[0]?.workTo,
    workHours: data.workHours !== undefined ? (data.workHours?.toString() || null) : existing[0]?.workHours,
  };

  if (existing.length > 0) {
    await db.update(dailyRecords).set(payload).where(eq(dailyRecords.id, existing[0].id));
  } else {
    await db.insert(dailyRecords).values(payload);
  }
}

export async function calculateBalance(telegramId: number, targetDate: string): Promise<number | null> {
  const [checkpoint] = await db.select().from(balanceCheckpoints)
    .where(and(eq(balanceCheckpoints.telegramId, telegramId), lte(balanceCheckpoints.date, targetDate)))
    .orderBy(desc(balanceCheckpoints.date))
    .limit(1);

  if (!checkpoint) return null;

  const baseVal = parseFloat(checkpoint.balanceValue);
  const txs = await db.select().from(walletTransactions).where(
    and(
      eq(walletTransactions.telegramId, telegramId),
      gte(walletTransactions.date, checkpoint.date),
      lte(walletTransactions.date, targetDate)
    )
  );

  const movement = txs.reduce((acc, curr) => acc + parseFloat(curr.amount), 0);
  return round2(baseVal + movement);
}

export async function getDaySummaryText(telegramId: number, dateStr: string): Promise<string> {
  const [record] = await db.select().from(dailyRecords).where(
    and(eq(dailyRecords.telegramId, telegramId), eq(dailyRecords.date, dateStr))
  );

  const tips = await db.select().from(cashTips).where(
    and(eq(cashTips.telegramId, telegramId), eq(cashTips.date, dateStr))
  );
  const tipSum = tips.reduce((acc, curr) => acc + parseFloat(curr.amount), 0);

  const walletTxs = await db.select().from(walletTransactions).where(
    and(eq(walletTransactions.telegramId, telegramId), eq(walletTransactions.date, dateStr))
  );
  const payoutPf = Math.abs(walletTxs.filter(t => t.type === 'wyplata').reduce((a, c) => a + parseFloat(c.amount), 0));

  const gross = record?.grossEarnings ? parseFloat(record.grossEarnings) : null;
  const distance = record?.fuelDistance ? parseFloat(record.fuelDistance) : null;
  const fuelPrice = record?.fuelPrice ? parseFloat(record.fuelPrice) : null;
  const fuelLiters = record?.fuelLiters ? parseFloat(record.fuelLiters) : null;
  const hours = record?.workHours ? parseFloat(record.workHours) : null;

  const tax = gross !== null ? round2(gross * CFG.TAX_FACTOR) : null;
  const netEarnings = gross !== null ? round2(gross * CFG.NETTO_FACTOR) : 0;
  const netWithTips = (gross !== null || tipSum > 0) ? round2(netEarnings + tipSum) : null;
  const toTransfer = netWithTips !== null ? round2(netWithTips - tipSum - payoutPf) : null;
  const burn = (fuelLiters && distance && distance > 0) ? round2((fuelLiters / distance) * 100) : null;

  const balance = await calculateBalance(telegramId, dateStr);

  const lines: string[] = [`📅 *Stan dnia: ${dateStr}*`, ''];

  if (gross !== null) {
    lines.push(`• *Brutto:* ${fmt(gross)} zł (podatek 18,6%: ${fmt(tax)} zł) → *netto:* ${fmt(netWithTips)} zł`);
    if (tipSum > 0) lines.push(`• *Napiwki (gotówka):* ${fmt(tipSum)} zł (wliczone w netto)`);
    if (distance && distance > 0) {
      lines.push(`• *Stawka/km:* ${fmt(gross / distance)} zł brutto | ${fmt(netWithTips! / distance)} zł netto`);
    }
    if (hours && hours > 0) {
      const range = (record?.workFrom && record?.workTo) ? ` (${record.workFrom}–${record.workTo})` : '';
      lines.push(`• *Czas pracy:* ${fmt(hours)} h${range} → ${fmt(gross / hours)} zł brutto/h | ${fmt(netWithTips! / hours)} zł netto/h`);
    }
    if (toTransfer !== null) lines.push(`• *Do przelewu (Glovo):* ${fmt(toTransfer)} zł`);
  } else if (tipSum > 0) {
    lines.push(`• *Napiwki (gotówka):* ${fmt(tipSum)} zł`);
  }

  if (balance !== null) {
    lines.push(`• *Saldo Glovo:* ${fmt(balance)} zł${balance < 0 ? ' (Glovo jest Ci winne)' : ''}`);
  }

  if (fuelPrice !== null || fuelLiters !== null || distance !== null) {
    const parts = [];
    if (fuelPrice !== null) parts.push(`${fmt(fuelPrice)} zł`);
    if (fuelLiters !== null) parts.push(`${fmt(fuelLiters)} l`);
    if (distance !== null) parts.push(`${fmt(distance)} km`);
    lines.push(`• *Paliwo:* ${parts.join(' / ')}`);
  }
  if (burn !== null) lines.push(`• *Spalanie:* ${fmt(burn)} l/100km`);

  if (walletTxs.length > 0) {
    lines.push('', '📥 *Portfel Glovo:*');
    walletTxs.forEach(t => lines.push(`• ${t.type}: ${fmt(t.amount)} zł (${t.time})`));
  }

  return lines.length > 2 ? lines.join('\n') : `ℹ️ Brak wpisów na dzień ${dateStr}.`;
}

export async function getWeekSummaryText(telegramId: number, offsetWeeks: number = 0): Promise<string> {
  const now = new Date();
  const day = (now.getDay() + 6) % 7; // Poniedziałek = 0
  const monday = new Date(now);
  monday.setDate(monday.getDate() - day + offsetWeeks * 7);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);

  const fromStr = monday.toISOString().slice(0, 10);
  const toStr = sunday.toISOString().slice(0, 10);

  const records = await db.select().from(dailyRecords).where(
    and(eq(dailyRecords.telegramId, telegramId), gte(dailyRecords.date, fromStr), lte(dailyRecords.date, toStr))
  );

  const tips = await db.select().from(cashTips).where(
    and(eq(cashTips.telegramId, telegramId), gte(cashTips.date, fromStr), lte(cashTips.date, toStr))
  );

  const header = offsetWeeks === 0 ? `📅 *TEN TYDZIEŃ* (${fromStr} — ${toStr})` : `📅 *POPRZEDNI TYDZIEŃ* (${fromStr} — ${toStr})`;
  if (!records.length && !tips.length) return `${header}\n\nℹ️ Brak wpisów w wybranym tygodniu.`;

  let gross = 0, fuel = 0, liters = 0, km = 0, hours = 0;
  records.forEach(r => {
    gross += r.grossEarnings ? parseFloat(r.grossEarnings) : 0;
    fuel += r.fuelPrice ? parseFloat(r.fuelPrice) : 0;
    liters += r.fuelLiters ? parseFloat(r.fuelLiters) : 0;
    km += r.fuelDistance ? parseFloat(r.fuelDistance) : 0;
    hours += r.workHours ? parseFloat(r.workHours) : 0;
  });

  const tipTotal = tips.reduce((a, c) => a + parseFloat(c.amount), 0);
  const tax = round2(gross * CFG.TAX_FACTOR);
  const net = round2(gross * CFG.NETTO_FACTOR + tipTotal);

  const out = [
    header, '',
    '📊 *ZAROBKI*',
    `• Brutto: ${fmt(gross)} zł`,
    `• Składki i podatek: ${fmt(tax)} zł`,
    tipTotal > 0 ? `• Napiwki (gotówka): ${fmt(tipTotal)} zł` : '',
    `• Netto: ${fmt(net)} zł`,
    '',
    '⏱ *CZAS I DYSTANS*',
    `• Dni z wpisem: ${records.length}`,
    hours > 0 ? `• Godziny: ${fmt(hours)} h (${fmt(gross / hours)} zł brutto/h | ${fmt(net / hours)} zł netto/h)` : '',
    km > 0 ? `• Dystans: ${fmt(km)} km (${fmt(gross / km)} zł brutto/km | ${fmt(net / km)} zł netto/km)` : '',
    fuel > 0 ? `• Paliwo: ${fmt(fuel)} zł / ${fmt(liters)} l` : '',
    (km > 0 && liters > 0) ? `• Średnie spalanie: ${fmt((liters / km) * 100)} l/100km` : '',
    '',
    `💰 *Netto po paliwie:* ${fmt(net - fuel)} zł`
  ].filter(Boolean);

  return out.join('\n');
}
export async function saveCourseOffer(params: {
  telegramId: number;
  date: string;
  time: string;
  grossAmount: number;
  netAmount: number;
  totalDistance: number | null;
  netRatePerKm: number | null;
  isProfitable: boolean | null;
  pointsJson: any;
  verificationText: string | null;
}) {
  await db.insert(courseOffers).values({
    telegramId: params.telegramId,
    date: params.date,
    time: params.time,
    grossAmount: params.grossAmount.toString(),
    netAmount: params.netAmount.toString(),
    totalDistance: params.totalDistance !== null ? params.totalDistance.toString() : null,
    netRatePerKm: params.netRatePerKm !== null ? params.netRatePerKm.toString() : null,
    isProfitable: params.isProfitable,
    pointsJson: params.pointsJson,
    verificationText: params.verificationText,
  });
}