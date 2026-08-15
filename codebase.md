

# Plik: package.json
```typescript
{
  "name": "telegram-bot",
  "version": "1.0.0",
  "description": "",
  "main": "index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest",
    "db:push": "drizzle-kit push",
    "db:studio": "drizzle-kit studio"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "type": "commonjs",
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
```typescript
{
  // Visit https://aka.ms/tsconfig to read more about this file
  "compilerOptions": {
    // File Layout
    "rootDir": "src",
    "outDir": "dist",

    // Environment Settings
    // See also https://aka.ms/tsconfig/module
    "module": "nodenext",
    "target": "es2022",
    "types": [],
    // For nodejs:
    // "lib": ["esnext"],
    // "types": ["node"],
    // and npm install -D @types/node

    // Other Outputs
    "sourceMap": true,
    "declaration": true,
    "declarationMap": true,

    // Stricter Typechecking Options
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,

    // Style Options
    // "noImplicitReturns": true,
    // "noImplicitOverride": true,
    // "noUnusedLocals": true,
    // "noUnusedParameters": true,
    // "noFallthroughCasesInSwitch": true,
    // "noPropertyAccessFromIndexSignature": true,

    // Recommended Options
    "strict": true,
    "jsx": "react-jsx",
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "noUncheckedSideEffectImports": true,
    "moduleDetection": "force",
    "skipLibCheck": true,

    "moduleResolution": "nodenext",
    "esModuleInterop": true,
  }
}

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


# Plik: src/index.ts
```typescript
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { registerBotHandlers } from './services/bot';

const botToken = process.env.BOT_TOKEN;
if (!botToken) {
  throw new Error('Brak zmiennej BOT_TOKEN w pliku .env!');
}

const bot = new Telegraf(botToken);

// Rejestracja wszystkich komend, nasłuchu audio, zdjęć i lokalizacji
registerBotHandlers(bot);

// Uruchomienie bota
bot.launch().then(() => {
  console.log('🤖 Bot kurierski wystartował pomyślnie...');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
```


# Plik: src/gemini.ts
```typescript
import { GoogleGenAI, Type } from '@google/genai';
import { z } from 'zod';
import 'dotenv/config';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export const BotResponseSchema = z.object({
  action: z.enum(['SUMMARY', 'TASK', 'GENERAL']),
  reply: z.string(),
  sentiment: z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE']),
});

export type BotResponse = z.infer<typeof BotResponseSchema>;

export async function processUserMessage(prompt: string): Promise<BotResponse> {
  const response = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: prompt,
    config: {
      systemInstruction:
        'Jesteś pomocnym asystentem w bocie Telegram. Zwracaj odpowiedź wyłącznie w formacie JSON zgodnym ze schematem. Klasyfikuj zadania i sentyment wypowiedzi użytkownika.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          action: {
            type: Type.STRING,
            enum: ['SUMMARY', 'TASK', 'GENERAL'],
          },
          reply: {
            type: Type.STRING,
          },
          sentiment: {
            type: Type.STRING,
            enum: ['POSITIVE', 'NEUTRAL', 'NEGATIVE'],
          },
        },
        required: ['action', 'reply', 'sentiment'],
      },
    },
  });

  const rawJson = JSON.parse(response.text || '{}');
  return BotResponseSchema.parse(rawJson);
}
```


# Plik: src/services/finance.service.ts
```typescript
import { db } from '../db';
import {
  dailyRecords,
  cashTips,
  walletTransactions,
  balanceCheckpoints,
  courseOffers,
  earningTargets,
} from '../db/schema';
import { eq, and, gte, lte, sql, desc, inArray } from 'drizzle-orm';
import { NETTO_FACTOR } from '../config';
import { VoiceExtractedData, WalletTransactionItem } from './gemini.service';

export interface DailySummary {
  date: string;
  grossEarnings: number;
  netEarnings: number;
  cashTipsTotal: number;
  totalNetto: number;
  walletPayouts: number;
  walletCollections: number;
  doPrzelewu: number;
  workHours: number;
  hourlyRateNetto: number;
  fuelPrice: number;
  fuelLiters: number;
  fuelDistance: number | null;
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
  estimatedHoursRemaining: number;
  hoursPerDayRequired: number;
  isCompleted: boolean;
}

export interface CourseOfferStats {
  date: string;
  totalOffers: number;
  profitable: number;
  unprofitable: number;
  avgNetRatePerKm: number;
  bestNetRate: number;
  worstNetRate: number;
  totalGross: number;
  totalDistanceKm: number;
}

export class FinanceService {
  getEffectiveDate(d = new Date()): string {
    const target = new Date(d);
    if (target.getHours() < 4) {
      target.setDate(target.getDate() - 1);
    }
    return target.toISOString().slice(0, 10);
  }

  adjustDateForNightShift(dateStr: string, timeStr?: string): string {
    if (!timeStr) return dateStr;
    const hour = parseInt(timeStr.split(':')[0], 10);
    if (hour >= 0 && hour < 4) {
      const d = new Date(`${dateStr}T12:00:00`);
      d.setDate(d.getDate() - 1);
      return d.toISOString().slice(0, 10);
    }
    return dateStr;
  }

  resolveTargetDate(targetDateStr?: string | null): string {
    if (!targetDateStr) return this.getEffectiveDate();
    const upper = targetDateStr.toUpperCase();
    if (upper === 'TODAY' || upper === 'DZISIAJ' || upper === 'DZIŚ') {
      return this.getEffectiveDate();
    }
    if (upper === 'YESTERDAY' || upper === 'WCZORAJ') {
      const d = new Date();
      if (d.getHours() < 4) d.setDate(d.getDate() - 2);
      else d.setDate(d.getDate() - 1);
      return d.toISOString().slice(0, 10);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(targetDateStr)) {
      return targetDateStr;
    }
    return this.getEffectiveDate();
  }

  calculateHours(fromStr: string, toStr: string): number {
    const [fH, fM] = fromStr.split(':').map(Number);
    const [tH, tM] = toStr.split(':').map(Number);
    let diffMinutes = tH * 60 + tM - (fH * 60 + fM);
    if (diffMinutes < 0) diffMinutes += 24 * 60;
    const hours = Math.round((diffMinutes / 60) * 100) / 100;
    return hours >= 0.25 ? hours : 0;
  }

  getWeekNumber(d: Date): number {
    const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = target.getUTCDay() || 7;
    target.setUTCDate(target.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
    return Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }

  getWeekRange(offsetWeeks = 0): { startDate: string; endDate: string } {
    const now = new Date();
    const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay();
    const monday = new Date(now);
    monday.setDate(monday.getDate() - (dayOfWeek - 1) + offsetWeeks * 7);
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    return {
      startDate: monday.toISOString().slice(0, 10),
      endDate: sunday.toISOString().slice(0, 10),
    };
  }

  async saveCashTip(telegramId: string | number, date: string, amount: number): Promise<void> {
    await db.insert(cashTips).values({
      telegramId: String(telegramId),
      date,
      amount: amount.toFixed(2),
    });
  }

  async saveFuelReceipt(telegramId: string | number, date: string, price: number, liters: number | null): Promise<void> {
    const tId = String(telegramId);
    await db
      .insert(dailyRecords)
      .values({
        telegramId: tId,
        date,
        fuelPrice: price.toFixed(2),
        fuelLiters: liters != null ? liters.toString() : null,
      })
      .onConflictDoUpdate({
        target: [dailyRecords.telegramId, dailyRecords.date],
        set: {
          fuelPrice: price.toFixed(2),
          ...(liters != null && { fuelLiters: liters.toString() }),
        },
      });
  }

  async saveCourseOffer(
    telegramId: string | number,
    data: {
      grossAmount: number;
      netAmount: number;
      totalDistance: number;
      netRatePerKm: number;
      isProfitable: boolean;
      pickupAddress: string;
      deliveryAddress: string;
      verificationText?: string;
    }
  ): Promise<void> {
    const now = new Date();
    const date = this.getEffectiveDate(now);
    const time = now.toTimeString().slice(0, 5);

    await db.insert(courseOffers).values({
      telegramId: String(telegramId),
      date,
      time,
      grossAmount: data.grossAmount.toFixed(2),
      netAmount: data.netAmount.toFixed(2),
      totalDistance: data.totalDistance.toFixed(2),
      netRatePerKm: data.netRatePerKm.toFixed(2),
      isProfitable: data.isProfitable,
      pointsJson: JSON.stringify({
        pickup: data.pickupAddress,
        delivery: data.deliveryAddress,
      }),
      verificationText: data.verificationText || null,
    });
  }

  async previewWalletImport(
    telegramId: string | number,
    transactions: WalletTransactionItem[]
  ): Promise<{
    newTransactions: WalletTransactionItem[];
    existingCount: number;
    totalAmountDelta: number;
    dates: string[];
  }> {
    const tId = String(telegramId);
    const newItems: WalletTransactionItem[] = [];
    let existingCount = 0;
    let totalDelta = 0;
    const datesSet = new Set<string>();

    for (const t of transactions) {
      const adjustedDate = this.adjustDateForNightShift(t.date, t.time);
      datesSet.add(adjustedDate);

      const existing = await db
        .select()
        .from(walletTransactions)
        .where(
          and(
            eq(walletTransactions.telegramId, tId),
            eq(walletTransactions.date, adjustedDate),
            eq(walletTransactions.time, t.time),
            eq(walletTransactions.type, t.type),
            eq(walletTransactions.amount, t.amount.toFixed(2))
          )
        )
        .limit(1);

      if (existing.length > 0) {
        existingCount++;
      } else {
        newItems.push({ ...t, date: adjustedDate });
        totalDelta += t.amount;
      }
    }

    return {
      newTransactions: newItems,
      existingCount,
      totalAmountDelta: Math.round(totalDelta * 100) / 100,
      dates: Array.from(datesSet).sort(),
    };
  }

  async saveWalletTransactions(
    telegramId: string | number,
    transactions: WalletTransactionItem[]
  ): Promise<{ added: number; dates: string[] }> {
    const tId = String(telegramId);
    const preview = await this.previewWalletImport(tId, transactions);

    if (preview.newTransactions.length > 0) {
      await db.insert(walletTransactions).values(
        preview.newTransactions.map((t) => ({
          telegramId: tId,
          date: t.date,
          time: t.time,
          type: t.type,
          amount: t.amount.toFixed(2),
          externalId: t.externalId || null,
        }))
      );
    }

    return {
      added: preview.newTransactions.length,
      dates: preview.dates,
    };
  }

  async saveVoiceEvent(
    telegramId: string | number,
    data: VoiceExtractedData
  ): Promise<{ date: string; hasDailyUpdate: boolean; hasTip: boolean }> {
    const tId = String(telegramId);
    const date = this.resolveTargetDate(data.targetDate);
    let hasDailyUpdate = false;
    let hasTip = false;

    if (data.cashTip && data.cashTip > 0) {
      await this.saveCashTip(tId, date, data.cashTip);
      hasTip = true;
    }

    const hasFuel = data.fuelPrice != null || data.fuelLiters != null || data.fuelDistance != null;
    const hasEarnings = data.grossEarnings != null;
    const hasShift = Boolean(data.workFrom && data.workTo);

    if (hasFuel || hasEarnings || hasShift) {
      hasDailyUpdate = true;
      let calculatedHours: string | null = null;
      if (data.workFrom && data.workTo) {
        calculatedHours = this.calculateHours(data.workFrom, data.workTo).toString();
      }

      await db
        .insert(dailyRecords)
        .values({
          telegramId: tId,
          date,
          fuelPrice: data.fuelPrice != null ? data.fuelPrice.toString() : null,
          fuelLiters: data.fuelLiters != null ? data.fuelLiters.toString() : null,
          fuelDistance: data.fuelDistance != null ? data.fuelDistance : null,
          grossEarnings: data.grossEarnings != null ? data.grossEarnings.toString() : null,
          workFrom: data.workFrom || null,
          workTo: data.workTo || null,
          workHours: calculatedHours,
        })
        .onConflictDoUpdate({
          target: [dailyRecords.telegramId, dailyRecords.date],
          set: {
            ...(data.fuelPrice != null && { fuelPrice: data.fuelPrice.toString() }),
            ...(data.fuelLiters != null && { fuelLiters: data.fuelLiters.toString() }),
            ...(data.fuelDistance != null && { fuelDistance: data.fuelDistance }),
            ...(data.grossEarnings != null && { grossEarnings: data.grossEarnings.toString() }),
            ...(data.workFrom && { workFrom: data.workFrom }),
            ...(data.workTo && { workTo: data.workTo }),
            ...(calculatedHours && { workHours: calculatedHours }),
          },
        });
    }

    return { date, hasDailyUpdate, hasTip };
  }

  async handleVoiceDeletion(
    telegramId: string | number,
    target: 'LAST_TIP' | 'ALL_TIPS' | 'FUEL' | 'HOURS' | 'EARNINGS' | 'ALL_DAY',
    targetDateStr?: string | null
  ): Promise<{ success: boolean; message: string; date: string }> {
    const tId = String(telegramId);
    const date = this.resolveTargetDate(targetDateStr);

    switch (target) {
      case 'LAST_TIP': {
        const [lastTip] = await db
          .select()
          .from(cashTips)
          .where(and(eq(cashTips.telegramId, tId), eq(cashTips.date, date)))
          .orderBy(desc(cashTips.createdAt))
          .limit(1);

        if (!lastTip) {
          return { success: false, message: `Brak napiwków do usunięcia z dnia \`${date}\`.`, date };
        }

        await db.delete(cashTips).where(eq(cashTips.id, lastTip.id));
        return {
          success: true,
          message: `Usunięto ostatni napiwek: *${parseFloat(lastTip.amount).toFixed(2)} zł* z dnia \`${date}\`.`,
          date,
        };
      }
      case 'ALL_TIPS': {
        const deleted = await db
          .delete(cashTips)
          .where(and(eq(cashTips.telegramId, tId), eq(cashTips.date, date)))
          .returning();
        if (!deleted.length) return { success: false, message: `Brak napiwków na \`${date}\`.`, date };
        return { success: true, message: `Skasowano wszystkie napiwki (${deleted.length} szt.) z dnia \`${date}\`.`, date };
      }
      case 'FUEL': {
        await db
          .update(dailyRecords)
          .set({ fuelPrice: null, fuelLiters: null, fuelDistance: null })
          .where(and(eq(dailyRecords.telegramId, tId), eq(dailyRecords.date, date)));
        return { success: true, message: `Wyczyszczono dane paliwa na \`${date}\`.`, date };
      }
      case 'HOURS': {
        await db
          .update(dailyRecords)
          .set({ workFrom: null, workTo: null, workHours: null })
          .where(and(eq(dailyRecords.telegramId, tId), eq(dailyRecords.date, date)));
        return { success: true, message: `Wyczyszczono czas pracy na \`${date}\`.`, date };
      }
      case 'EARNINGS': {
        await db
          .update(dailyRecords)
          .set({ grossEarnings: null })
          .where(and(eq(dailyRecords.telegramId, tId), eq(dailyRecords.date, date)));
        return { success: true, message: `Wyczyszczono zarobek brutto na \`${date}\`.`, date };
      }
      case 'ALL_DAY': {
        await db.delete(dailyRecords).where(and(eq(dailyRecords.telegramId, tId), eq(dailyRecords.date, date)));
        await db.delete(cashTips).where(and(eq(cashTips.telegramId, tId), eq(cashTips.date, date)));
        return { success: true, message: `Usunięto cały wpis i napiwki z dnia \`${date}\`.`, date };
      }
      default:
        return { success: false, message: 'Nie rozpoznano elementu do usunięcia.', date };
    }
  }

  async getDailySummary(telegramId: string | number, date: string): Promise<DailySummary> {
    const tId = String(telegramId);

    const [record] = await db
      .select()
      .from(dailyRecords)
      .where(and(eq(dailyRecords.telegramId, tId), eq(dailyRecords.date, date)))
      .limit(1);

    const tips = await db
      .select({ total: sql<string>`coalesce(sum(amount), 0)` })
      .from(cashTips)
      .where(and(eq(cashTips.telegramId, tId), eq(cashTips.date, date)));

    const txs = await db
      .select()
      .from(walletTransactions)
      .where(and(eq(walletTransactions.telegramId, tId), eq(walletTransactions.date, date)));

    let walletPayouts = 0;
    let walletCollections = 0;
    for (const tx of txs) {
      const val = parseFloat(tx.amount);
      if (tx.type === 'wyplata' || tx.type === 'wyplata_gotowka') {
        walletPayouts += Math.abs(val);
      } else if (tx.type === 'pobranie') {
        walletCollections += val;
      }
    }

    const gross = record?.grossEarnings ? parseFloat(record.grossEarnings) : 0;
    const netEarnings = Math.round(gross * NETTO_FACTOR * 100) / 100;
    const cashTipsTotal = tips[0]?.total ? parseFloat(tips[0].total) : 0;
    const totalNetto = Math.round((netEarnings + cashTipsTotal) * 100) / 100;
    const doPrzelewu = Math.max(0, Math.round((totalNetto - cashTipsTotal - walletPayouts) * 100) / 100);
    const workHours = record?.workHours ? parseFloat(record.workHours) : 0;
    const hourlyRateNetto = workHours > 0 ? Math.round((totalNetto / workHours) * 100) / 100 : 0;

    return {
      date,
      grossEarnings: gross,
      netEarnings,
      cashTipsTotal,
      totalNetto,
      walletPayouts,
      walletCollections,
      doPrzelewu,
      workHours,
      hourlyRateNetto,
      fuelPrice: record?.fuelPrice ? parseFloat(record.fuelPrice) : 0,
      fuelLiters: record?.fuelLiters ? parseFloat(record.fuelLiters) : 0,
      fuelDistance: record?.fuelDistance ?? null,
    };
  }

  async getPeriodSummary(
    telegramId: string | number,
    startDate: string,
    endDate: string
  ): Promise<{
    startDate: string;
    endDate: string;
    totalGross: number;
    totalNettoEarnings: number;
    totalCashTips: number;
    grandTotalNetto: number;
    totalWalletPayouts: number;
    totalDoPrzelewu: number;
    totalWorkHours: number;
    avgHourlyRateNetto: number;
    totalFuelCost: number;
    totalDistanceKm: number;
  }> {
    const tId = String(telegramId);

    const records = await db
      .select()
      .from(dailyRecords)
      .where(and(eq(dailyRecords.telegramId, tId), gte(dailyRecords.date, startDate), lte(dailyRecords.date, endDate)));

    const tips = await db
      .select({ total: sql<string>`coalesce(sum(amount), 0)` })
      .from(cashTips)
      .where(and(eq(cashTips.telegramId, tId), gte(cashTips.date, startDate), lte(cashTips.date, endDate)));

    const txs = await db
      .select()
      .from(walletTransactions)
      .where(
        and(eq(walletTransactions.telegramId, tId), gte(walletTransactions.date, startDate), lte(walletTransactions.date, endDate))
      );

    let totalGross = 0;
    let totalWorkHours = 0;
    let totalFuelCost = 0;
    let totalDistanceKm = 0;

    for (const r of records) {
      if (r.grossEarnings) totalGross += parseFloat(r.grossEarnings);
      if (r.workHours) totalWorkHours += parseFloat(r.workHours);
      if (r.fuelPrice) totalFuelCost += parseFloat(r.fuelPrice);
      if (r.fuelDistance) totalDistanceKm += r.fuelDistance;
    }

    let totalWalletPayouts = 0;
    for (const tx of txs) {
      if (tx.type === 'wyplata' || tx.type === 'wyplata_gotowka') {
        totalWalletPayouts += Math.abs(parseFloat(tx.amount));
      }
    }

    const totalNettoEarnings = Math.round(totalGross * NETTO_FACTOR * 100) / 100;
    const totalCashTips = tips[0]?.total ? parseFloat(tips[0].total) : 0;
    const grandTotalNetto = Math.round((totalNettoEarnings + totalCashTips) * 100) / 100;
    const totalDoPrzelewu = Math.max(0, Math.round((grandTotalNetto - totalCashTips - totalWalletPayouts) * 100) / 100);
    const avgHourlyRateNetto = totalWorkHours > 0 ? Math.round((grandTotalNetto / totalWorkHours) * 100) / 100 : 0;

    return {
      startDate,
      endDate,
      totalGross,
      totalNettoEarnings,
      totalCashTips,
      grandTotalNetto,
      totalWalletPayouts,
      totalDoPrzelewu,
      totalWorkHours,
      avgHourlyRateNetto,
      totalFuelCost,
      totalDistanceKm,
    };
  }

  async getCourseOfferStats(telegramId: string | number, date: string): Promise<CourseOfferStats> {
    const tId = String(telegramId);
    const offers = await db
      .select()
      .from(courseOffers)
      .where(and(eq(courseOffers.telegramId, tId), eq(courseOffers.date, date)));

    let profitable = 0;
    let unprofitable = 0;
    let sumRates = 0;
    let bestRate = 0;
    let worstRate = 999;
    let totalGross = 0;
    let totalDistanceKm = 0;

    for (const o of offers) {
      if (o.isProfitable) profitable++;
      else unprofitable++;

      const rate = parseFloat(o.netRatePerKm);
      sumRates += rate;
      if (rate > bestRate) bestRate = rate;
      if (rate < worstRate) worstRate = rate;

      totalGross += parseFloat(o.grossAmount);
      totalDistanceKm += parseFloat(o.totalDistance);
    }

    return {
      date,
      totalOffers: offers.length,
      profitable,
      unprofitable,
      avgNetRatePerKm: offers.length > 0 ? Math.round((sumRates / offers.length) * 100) / 100 : 0,
      bestNetRate: bestRate,
      worstNetRate: worstRate === 999 ? 0 : worstRate,
      totalGross: Math.round(totalGross * 100) / 100,
      totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
    };
  }

  async setEarningTarget(
    telegramId: string | number,
    periodType: 'MONTHLY' | 'WEEKLY',
    targetAmount: number
  ): Promise<{ year: number; periodValue: number; targetAmount: number }> {
    const tId = String(telegramId);
    const effDate = new Date(this.getEffectiveDate());
    const year = effDate.getFullYear();
    const periodValue = periodType === 'MONTHLY' ? effDate.getMonth() + 1 : this.getWeekNumber(effDate);

    await db
      .insert(earningTargets)
      .values({
        telegramId: tId,
        periodType,
        targetAmount: targetAmount.toFixed(2),
        year,
        periodValue,
      })
      .onConflictDoUpdate({
        target: [
          earningTargets.telegramId,
          earningTargets.periodType,
          earningTargets.year,
          earningTargets.periodValue,
        ],
        set: { targetAmount: targetAmount.toFixed(2) },
      });

    return { year, periodValue, targetAmount };
  }

  async getTargetProgress(telegramId: string | number, periodType: 'MONTHLY' | 'WEEKLY'): Promise<TargetProgress | null> {
    const tId = String(telegramId);
    const effDateStr = this.getEffectiveDate();
    const effDate = new Date(effDateStr);
    const year = effDate.getFullYear();
    const periodValue = periodType === 'MONTHLY' ? effDate.getMonth() + 1 : this.getWeekNumber(effDate);

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
    let startDate = '';
    let daysRemaining = 1;

    if (periodType === 'MONTHLY') {
      startDate = `${year}-${String(periodValue).padStart(2, '0')}-01`;
      const lastDayOfMonth = new Date(year, periodValue, 0).getDate();
      daysRemaining = Math.max(1, lastDayOfMonth - effDate.getDate() + 1);
    } else {
      const dayOfWeek = effDate.getDay() === 0 ? 7 : effDate.getDay();
      const monday = new Date(effDate);
      monday.setDate(monday.getDate() - (dayOfWeek - 1));
      startDate = monday.toISOString().slice(0, 10);
      daysRemaining = Math.max(1, 7 - dayOfWeek + 1);
    }

    const summary = await this.getPeriodSummary(tId, startDate, effDateStr);
    const currentNetto = summary.grandTotalNetto;
    const remainingNetto = Math.max(0, Math.round((targetAmount - currentNetto) * 100) / 100);
    const progressPercent = Math.min(100, Math.round((currentNetto / targetAmount) * 1000) / 10);
    const dailyRequiredNetto = remainingNetto > 0 ? Math.round((remainingNetto / daysRemaining) * 100) / 100 : 0;
    const avgHourlyRate = summary.avgHourlyRateNetto > 0 ? summary.avgHourlyRateNetto : 35.0;
    const estimatedHoursRemaining = remainingNetto > 0 ? Math.round((remainingNetto / avgHourlyRate) * 10) / 10 : 0;
    const hoursPerDayRequired = estimatedHoursRemaining > 0 ? Math.round((estimatedHoursRemaining / daysRemaining) * 10) / 10 : 0;

    return {
      periodType,
      targetAmount,
      currentNetto,
      remainingNetto,
      progressPercent,
      daysRemaining,
      dailyRequiredNetto,
      avgHourlyRate,
      estimatedHoursRemaining,
      hoursPerDayRequired,
      isCompleted: currentNetto >= targetAmount,
    };
  }

  async getRollingBalance(
    telegramId: string | number,
    targetDate = this.getEffectiveDate()
  ): Promise<{ balance: number; checkpointDate: string | null }> {
    const tId = String(telegramId);

    const [checkpoint] = await db
      .select()
      .from(balanceCheckpoints)
      .where(and(eq(balanceCheckpoints.telegramId, tId), lte(balanceCheckpoints.date, targetDate)))
      .orderBy(desc(balanceCheckpoints.date))
      .limit(1);

    const baseBalance = checkpoint ? parseFloat(checkpoint.balanceValue) : 0;
    const checkpointDate = checkpoint ? checkpoint.date : '1970-01-01';

    const txs = await db
      .select({ total: sql<string>`coalesce(sum(amount), 0)` })
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.telegramId, tId),
          gte(walletTransactions.date, checkpointDate),
          lte(walletTransactions.date, targetDate)
        )
      );

    const delta = txs[0]?.total ? parseFloat(txs[0].total) : 0;
    return {
      balance: Math.round((baseBalance + delta) * 100) / 100,
      checkpointDate: checkpoint ? checkpoint.date : null,
    };
  }

  async setBalanceCheckpoint(telegramId: string | number, date: string, balanceValue: number): Promise<void> {
    const tId = String(telegramId);
    await db
      .insert(balanceCheckpoints)
      .values({
        telegramId: tId,
        date,
        balanceValue: balanceValue.toFixed(2),
      })
      .onConflictDoUpdate({
        target: [balanceCheckpoints.telegramId, balanceCheckpoints.date],
        set: { balanceValue: balanceValue.toFixed(2) },
      });
  }
}

export const financeService = new FinanceService();
```


# Plik: src/services/gemini.service.ts
```typescript
import { GoogleGenAI, Type, Schema } from '@google/genai';

export interface VoiceExtractedData {
  transcription: string;
  action: 'UPSERT' | 'DELETE';
  deleteTarget?: 'LAST_TIP' | 'ALL_TIPS' | 'FUEL' | 'HOURS' | 'EARNINGS' | 'ALL_DAY' | null;
  targetDate?: string | null;
  fuelPrice?: number | null;
  fuelLiters?: number | null;
  fuelDistance?: number | null;
  grossEarnings?: number | null;
  workFrom?: string | null;
  workTo?: string | null;
  cashTip?: number | null;
}

export interface FuelReceiptExtractedData {
  date?: string | null;
  fuelPrice?: number | null;
  fuelLiters?: number | null;
}

export interface CourseOfferExtractedData {
  grossAmount: number;
  pickupAddress: string;
  deliveryAddress: string;
  appDistanceKm?: number | null;
}

export interface WalletTransactionItem {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  type: 'pobranie' | 'wyplata' | 'wyplata_gotowka' | 'platnosc_punkt' | 'korekta';
  amount: number;
  externalId?: string | null;
}

const voiceExtractionSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    transcription: {
      type: Type.STRING,
      description: 'Dosłowna transkrypcja wypowiedzi w języku polskim.',
    },
    action: {
      type: Type.STRING,
      enum: ['UPSERT', 'DELETE'],
    },
    deleteTarget: {
      type: Type.STRING,
      enum: ['LAST_TIP', 'ALL_TIPS', 'FUEL', 'HOURS', 'EARNINGS', 'ALL_DAY'],
      nullable: true,
    },
    targetDate: {
      type: Type.STRING,
      nullable: true,
    },
    fuelPrice: { type: Type.NUMBER, nullable: true },
    fuelLiters: { type: Type.NUMBER, nullable: true },
    fuelDistance: { type: Type.INTEGER, nullable: true },
    grossEarnings: { type: Type.NUMBER, nullable: true },
    workFrom: { type: Type.STRING, nullable: true },
    workTo: { type: Type.STRING, nullable: true },
    cashTip: { type: Type.NUMBER, nullable: true },
  },
  required: ['transcription', 'action'],
};

const fuelReceiptSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    date: { type: Type.STRING, nullable: true },
    fuelPrice: { type: Type.NUMBER, nullable: true },
    fuelLiters: { type: Type.NUMBER, nullable: true },
  },
  required: ['fuelPrice'],
};

const courseOfferSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    grossAmount: { type: Type.NUMBER },
    pickupAddress: { type: Type.STRING },
    deliveryAddress: { type: Type.STRING },
    appDistanceKm: { type: Type.NUMBER, nullable: true },
  },
  required: ['grossAmount', 'pickupAddress', 'deliveryAddress'],
};

const walletScreenSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    transactions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          date: {
            type: Type.STRING,
            description: 'Data w formacie YYYY-MM-DD na podstawie nagłówka sekcji (np. "czw., 6 sierpnia" -> 2026-08-06).',
          },
          time: {
            type: Type.STRING,
            description: 'Godzina transakcji w formacie HH:MM (np. 15:50).',
          },
          type: {
            type: Type.STRING,
            enum: ['pobranie', 'wyplata', 'wyplata_gotowka', 'platnosc_punkt', 'korekta'],
            description: 'Dokładny typ: "Pobranie gotówki od klienta" -> pobranie, "Wypłata" -> wyplata, "Wypłata w gotówce" -> wyplata_gotowka, "Płatność w punkcie" -> platnosc_punkt, "Korekta" -> korekta.',
          },
          amount: {
            type: Type.NUMBER,
            description: 'Kwota ze znakiem (ujemna jeśli jest minus, np. -180.60 dla wypłaty, 63.34 dla pobrania).',
          },
          externalId: {
            type: Type.STRING,
            nullable: true,
            description: 'Identyfikator transakcji (długi ciąg cyfr, np. 101735350998).',
          },
        },
        required: ['date', 'time', 'type', 'amount'],
      },
    },
  },
  required: ['transactions'],
};

export class GeminiService {
  private ai: GoogleGenAI;
  private model: string;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this.model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  }

  async parseVoiceNote(audioBuffer: Buffer, mimeType = 'audio/ogg'): Promise<VoiceExtractedData> {
    const base64Audio = audioBuffer.toString('base64');
    const prompt = `
Jesteś asystentem kuriera. Przeanalizuj nagranie audio.
Rozpoznaj akcję:
- UPSERT: tankowanie (koszt, litry, licznik), godziny od-do, zarobki brutto, napiwek gotówkowy.
- DELETE: 'LAST_TIP', 'ALL_TIPS', 'FUEL', 'HOURS', 'EARNINGS', 'ALL_DAY'.
Ignoruj szum wiatru i wydechu motocykla.
`;

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: base64Audio } },
            { text: prompt },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: voiceExtractionSchema,
        temperature: 0.1,
      },
    });

    return JSON.parse(response.text || '{}') as VoiceExtractedData;
  }

  async extractFuelReceipt(imageBuffer: Buffer, mimeType = 'image/jpeg'): Promise<FuelReceiptExtractedData> {
    const base64Image = imageBuffer.toString('base64');
    const prompt = `
Przeanalizuj paragon paliwowy. Wyciągnij: łączną kwotę w PLN, ilość litrów, datę (YYYY-MM-DD).
Ignoruj kody CN, numery stacji i oznaczenia 95/98.
`;

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: base64Image } },
            { text: prompt },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: fuelReceiptSchema,
        temperature: 0.1,
      },
    });

    return JSON.parse(response.text || '{}') as FuelReceiptExtractedData;
  }

  async analyzeCourseOffer(imageBuffer: Buffer, mimeType = 'image/jpeg'): Promise<CourseOfferExtractedData> {
    const base64Image = imageBuffer.toString('base64');
    const prompt = `
Przeanalizuj ofertę kursu Glovo.
Wyciągnij: kwotę brutto za kurs (ignoruj "POTRZEBNA GOTÓWKA" i "ZAPŁAĆ"), adres odbioru, adres klienta, szacowany dystans km.
`;

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: base64Image } },
            { text: prompt },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: courseOfferSchema,
        temperature: 0.1,
      },
    });

    return JSON.parse(response.text || '{}') as CourseOfferExtractedData;
  }

  /**
   * Vision: OCR zrzutów ekranu Portfela Glovo (lista transakcji).
   */
  async analyzeWalletScreenshot(
    imageBuffer: Buffer,
    currentYear = new Date().getFullYear(),
    mimeType = 'image/jpeg'
  ): Promise<WalletTransactionItem[]> {
    const base64Image = imageBuffer.toString('base64');
    const prompt = `
Przeanalizuj zrzut ekranu "Portfel" z aplikacji Glovo. Bieżący rok to ${currentYear}.
Wyodrębnij wszystkie widoczne transakcje z listy:
- Nagłówek dnia (np. "Dzisiaj, 11 sierpnia" -> ${currentYear}-08-11, "czw., 6 sierpnia" -> ${currentYear}-08-06, "niedz., 26 lipca" -> ${currentYear}-07-26).
- Typ pozycji:
  • "Pobranie gotówki od klienta" -> pobranie (kwota dodatnia, np. 35.99)
  • "Wypłata" -> wyplata (kwota ujemna, np. -174.89)
  • "Wypłata w gotówce" -> wyplata_gotowka (kwota ujemna, np. -100.00)
  • "Płatność w punkcie" -> platnosc_punkt (kwota ujemna, np. -255.69)
  • "Korekta" -> korekta (kwota ze znakiem, np. -2.78)
- Godzina: format HH:MM pod nazwą.
- ID transakcji: ciąg cyfr po kropce obok godziny (np. 101735350998). Jeśli brak, zwróć null.
- IGNORUJ wiersze podsumowania "Łączna kwota w gotówce".
`;

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: base64Image } },
            { text: prompt },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: walletScreenSchema,
        temperature: 0.1,
      },
    });

    const parsed = JSON.parse(response.text || '{}') as { transactions?: WalletTransactionItem[] };
    return parsed.transactions || [];
  }

  /**
   * Automatyczna klasyfikacja rodzaju przesłanego obrazu.
   */
  async classifyImage(imageBuffer: Buffer, caption = '', mimeType = 'image/jpeg'): Promise<'WALLET' | 'FUEL' | 'OFFER'> {
    const lowerCaption = caption.toLowerCase();
    if (lowerCaption.includes('portfel')) return 'WALLET';
    if (lowerCaption.includes('paragon') || lowerCaption.includes('paliwo') || lowerCaption.includes('stacja')) return 'FUEL';

    const base64Image = imageBuffer.toString('base64');
    const prompt = `
Rozpoznaj typ ekranu:
- WALLET (ekran z nagłówkiem "Portfel", listą transakcji: Pobranie gotówki, Wypłata, Płatność w punkcie)
- FUEL (paragon ze stacji paliw, faktura Orlen/CircleK/itp.)
- OFFER (nowa oferta zlecenia Glovo z mapą, trasą i zieloną kwotą)
Zwróć obiekt JSON z polem "category": "WALLET" | "FUEL" | "OFFER".
`;

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: base64Image } },
            { text: prompt },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            category: { type: Type.STRING, enum: ['WALLET', 'FUEL', 'OFFER'] },
          },
          required: ['category'],
        },
        temperature: 0.0,
      },
    });

    const res = JSON.parse(response.text || '{}') as { category?: 'WALLET' | 'FUEL' | 'OFFER' };
    return res.category || 'OFFER';
  }
}

export const geminiService = new GeminiService();
```


# Plik: src/services/bot.ts
```typescript
import { Telegraf, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { geminiService, WalletTransactionItem } from './gemini.service';
import { financeService, TargetProgress } from './finance.service';
import { mapsService } from './maps.service';
import { NETTO_FACTOR, MIN_STAWKA_NETTO_KM } from '../config';

interface CourierLocation {
  latitude: number;
  longitude: number;
  updatedAt: number;
}

const lastCourierLocation: Map<string, CourierLocation> = new Map();
const pendingWalletImports: Map<string, { transactions: WalletTransactionItem[]; expiresAt: number }> = new Map();

function generateProgressBar(percent: number, totalBlocks = 10): string {
  const filledBlocks = Math.min(totalBlocks, Math.max(0, Math.round((percent / 100) * totalBlocks)));
  const emptyBlocks = totalBlocks - filledBlocks;
  return `[${'█'.repeat(filledBlocks)}${'░'.repeat(emptyBlocks)}]`;
}

function formatTargetCard(progress: TargetProgress): string {
  const isMonth = progress.periodType === 'MONTHLY';
  const header = isMonth ? '🎯 *Miesięczny Cel Zarobkowy*' : '🎯 *Tygodniowy Cel Zarobkowy*';
  const bar = generateProgressBar(progress.progressPercent);

  if (progress.isCompleted) {
    return [
      header,
      `${bar} *${progress.progressPercent.toFixed(1)}%*`,
      '',
      `🏆 *CEL OSIĄGNIĘTY!*`,
      `💰 *Zarobione netto:* *${progress.currentNetto.toFixed(2)} zł* / *${progress.targetAmount.toFixed(2)} zł*`,
      `📈 *Nadwyżka:* *+${(progress.currentNetto - progress.targetAmount).toFixed(2)} zł*`,
    ].join('\n');
  }

  return [
    header,
    `${bar} *${progress.progressPercent.toFixed(1)}%*`,
    '',
    `💰 *Postęp:* *${progress.currentNetto.toFixed(2)} zł* z *${progress.targetAmount.toFixed(2)} zł* netto`,
    `⏳ *Brakuje:* *${progress.remainingNetto.toFixed(2)} zł*`,
    `📅 *Pozostało dni:* *${progress.daysRemaining}*`,
    '',
    '📊 *Wymagane tempo:*',
    ` • Dziennie: *${progress.dailyRequiredNetto.toFixed(2)} zł netto / dzień*`,
    ` • Czas pracy: *~${progress.estimatedHoursRemaining.toFixed(1)} h* (${progress.hoursPerDayRequired.toFixed(1)} h / dzień)`,
  ].join('\n');
}

export function registerBotHandlers(bot: Telegraf): void {
  // 1. Pomoc i Menu
  bot.command(['start', 'pomoc', 'help'], async (ctx) => {
    const text = [
      '🤖 *GlovoBot – Asystent Kuriera*',
      '',
      '📍 *Lokalizacja:*',
      ' • `/lokalizacja` – wywołaj przycisk wysłania pinezki GPS.',
      '',
      '🎯 *Cele zarobkowe:*',
      ' • `/cel 4500` – ustaw cel miesięczny netto.',
      ' • `/cel tydzien 1200` – ustaw cel tygodniowy netto.',
      ' • `/cele` – sprawdź postęp i wymagane tempo.',
      '',
      '📊 *Raporty i historia:*',
      ' • `/dzis` – podsumowanie dzisiejszej zmiany.',
      ' • `/dzien 2026-08-06` – podsumowanie konkretnego dnia.',
      ' • `/tydzien` – bieżący tydzień (pon–ndz).',
      ' • `/ptydzien` – poprzedni tydzień (pon–ndz).',
      ' • `/miesiac` lub `/miesiac 2026-07` – podsumowanie miesiąca.',
      ' • `/statystyki` lub `/statystyki 2026-08-06` – statystyki ofert Glovo.',
      ' • `/saldo` lub `/saldo 150.00` – podgląd / ustawienie salda Glovo.',
      '',
      '🎙️ *Głos (Voice-to-Data):* Notatki tankowania, zarobków i cofania.',
      '📸 *Zdjęcia:* Zrzuty Portfela, paragony paliwowe, oferty zleceń.',
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // 2. Przycisk geolokalizacji na żądanie
  bot.command('lokalizacja', async (ctx) => {
    await ctx.reply(
      '📍 *Kliknij przycisk poniżej*, aby udostępnić lokalizację GPS. Będzie używana do weryfikacji tras ofert Glovo przez 30 minut.',
      {
        parse_mode: 'Markdown',
        ...Markup.keyboard([[Markup.button.locationRequest('📍 Wyślij moją pozycję GPS')]])
          .resize()
          .oneTime(),
      }
    );
  });

  // 3. Obsługa lokalizacji
  bot.on(message('location'), async (ctx) => {
    const { latitude, longitude } = ctx.message.location;
    lastCourierLocation.set(String(ctx.from.id), {
      latitude,
      longitude,
      updatedAt: Date.now(),
    });
    await ctx.reply('✅ *Pozycja GPS zapisana.* Weryfikacja tras Glovo aktywna na 30 minut.', {
      parse_mode: 'Markdown',
      ...Markup.removeKeyboard(),
    });
  });

  // 4. Raport: /dzis oraz /dzien [RRRR-MM-DD]
  bot.command(['dzis', 'dzien'], async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const date = parts.length > 1 && /^\d{4}-\d{2}-\d{2}$/.test(parts[1]) ? parts[1] : financeService.getEffectiveDate();
    const summary = await financeService.getDailySummary(ctx.from.id, date);

    const text = [
      `📅 *Raport dzienny:* \`${summary.date}\``,
      '',
      `💰 *Brutto:* *${summary.grossEarnings.toFixed(2)} zł*`,
      `💵 *Netto z zleceń (81.4%):* *${summary.netEarnings.toFixed(2)} zł*`,
      `🪙 *Napiwki gotówka:* *+${summary.cashTipsTotal.toFixed(2)} zł*`,
      `🏁 *Netto łącznie:* *${summary.totalNetto.toFixed(2)} zł*`,
      summary.walletPayouts > 0 ? `🏧 *Wypłaty z portfela:* *-${summary.walletPayouts.toFixed(2)} zł*` : '',
      `💳 *Do przelewu (bez gotówki):* *${summary.doPrzelewu.toFixed(2)} zł*`,
      '',
      summary.workHours > 0
        ? `⏱️ *Czas pracy:* *${summary.workHours.toFixed(2)} h* (Stawka: *${summary.hourlyRateNetto.toFixed(2)} zł netto/h*)`
        : '⏱️ *Czas pracy:* _Brak wpisu_',
      '',
      summary.fuelPrice > 0
        ? `⛽ *Paliwo:* *${summary.fuelPrice.toFixed(2)} zł* (${summary.fuelLiters.toFixed(2)} L)`
        : '⛽ *Paliwo:* _Brak wpisu_',
      summary.fuelDistance ? `🚗 *Przebieg:* *${summary.fuelDistance} km*` : '',
    ]
      .filter(Boolean)
      .join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // 5. Raport: /tydzien oraz /ptydzien
  bot.command(['tydzien', 'ptydzien'], async (ctx) => {
    const isPrevious = ctx.message.text.toLowerCase().includes('ptydzien');
    const { startDate, endDate } = financeService.getWeekRange(isPrevious ? -1 : 0);

    const summary = await financeService.getPeriodSummary(ctx.from.id, startDate, endDate);
    const weeklyTarget = !isPrevious ? await financeService.getTargetProgress(ctx.from.id, 'WEEKLY') : null;

    const text = [
      `📊 *${isPrevious ? 'Poprzedni tydzień' : 'Bieżący tydzień'} (${summary.startDate} - ${summary.endDate}):*`,
      '',
      `💰 *Brutto łączne:* *${summary.totalGross.toFixed(2)} zł*`,
      `💵 *Netto z zleceń:* *${summary.totalNettoEarnings.toFixed(2)} zł*`,
      `🪙 *Napiwki gotówkowe:* *+${summary.totalCashTips.toFixed(2)} zł*`,
      `🏁 *Netto całkowite:* *${summary.grandTotalNetto.toFixed(2)} zł*`,
      summary.totalWalletPayouts > 0 ? `🏧 *Wypłaty portfel:* *-${summary.totalWalletPayouts.toFixed(2)} zł*` : '',
      `💳 *Do przelewu:* *${summary.totalDoPrzelewu.toFixed(2)} zł*`,
      '',
      `⏱️ *Godziny:* *${summary.totalWorkHours.toFixed(2)} h* (Śr. *${summary.avgHourlyRateNetto.toFixed(2)} zł netto/h*)`,
      `⛽ *Koszty paliwa:* *${summary.totalFuelCost.toFixed(2)} zł*`,
      summary.totalDistanceKm > 0 ? `🚗 *Dystans:* *${summary.totalDistanceKm} km*` : '',
      ...(weeklyTarget
        ? [
            '',
            '────────────────',
            `🎯 *Cel tygodnia:* ${generateProgressBar(weeklyTarget.progressPercent)} *${weeklyTarget.progressPercent.toFixed(1)}%*`,
            `⏳ Brakuje: *${weeklyTarget.remainingNetto.toFixed(2)} zł* (*${weeklyTarget.dailyRequiredNetto.toFixed(2)} zł/dzień*)`,
          ]
        : []),
    ]
      .filter(Boolean)
      .join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // 6. Raport: /miesiac [RRRR-MM]
  bot.command('miesiac', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    let startDate = '';
    let endDate = '';

    if (parts.length > 1 && /^\d{4}-\d{2}$/.test(parts[1])) {
      const [year, month] = parts[1].split('-').map(Number);
      startDate = `${parts[1]}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      endDate = `${parts[1]}-${String(lastDay).padStart(2, '0')}`;
    } else {
      const now = new Date();
      startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      endDate = financeService.getEffectiveDate(now);
    }

    const summary = await financeService.getPeriodSummary(ctx.from.id, startDate, endDate);
    const monthlyTarget = await financeService.getTargetProgress(ctx.from.id, 'MONTHLY');

    const text = [
      `🗓️ *Podsumowanie miesiąca (${summary.startDate} - ${summary.endDate}):*`,
      '',
      `💰 *Brutto:* *${summary.totalGross.toFixed(2)} zł*`,
      `💵 *Netto:* *${summary.totalNettoEarnings.toFixed(2)} zł*`,
      `🪙 *Napiwki:* *+${summary.totalCashTips.toFixed(2)} zł*`,
      `🏁 *Czyste Netto:* *${summary.grandTotalNetto.toFixed(2)} zł*`,
      summary.totalWalletPayouts > 0 ? `🏧 *Wypłaty portfel:* *-${summary.totalWalletPayouts.toFixed(2)} zł*` : '',
      `💳 *Do przelewu:* *${summary.totalDoPrzelewu.toFixed(2)} zł*`,
      '',
      `⏱️ *Godziny:* *${summary.totalWorkHours.toFixed(2)} h* (Śr. *${summary.avgHourlyRateNetto.toFixed(2)} zł/h*)`,
      `⛽ *Paliwo:* *${summary.totalFuelCost.toFixed(2)} zł*`,
      ...(monthlyTarget
        ? [
            '',
            '────────────────',
            `🎯 *Cel miesiąca:* ${generateProgressBar(monthlyTarget.progressPercent)} *${monthlyTarget.progressPercent.toFixed(1)}%*`,
            `⏳ Brakuje: *${monthlyTarget.remainingNetto.toFixed(2)} zł*`,
          ]
        : []),
    ]
      .filter(Boolean)
      .join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // 7. Statystyki ofert Glovo: /statystyki [RRRR-MM-DD]
  bot.command('statystyki', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const date = parts.length > 1 && /^\d{4}-\d{2}-\d{2}$/.test(parts[1]) ? parts[1] : financeService.getEffectiveDate();
    const stats = await financeService.getCourseOfferStats(ctx.from.id, date);

    if (stats.totalOffers === 0) {
      await ctx.reply(`ℹ️ *Brak zapisanych ofert kursów w dniu* \`${date}\`.`, { parse_mode: 'Markdown' });
      return;
    }

    const text = [
      `📊 *Statystyki ofert Glovo (${stats.date}):*`,
      '',
      `• *Sprawdzonych zleceń:* *${stats.totalOffers}*`,
      `• ✅ *Opłacalne (≥${MIN_STAWKA_NETTO_KM.toFixed(2)} zł/km):* *${stats.profitable}*`,
      `• ❌ *Nieopłacalne:* *${stats.unprofitable}*`,
      '',
      `📈 *Średnia stawka:* *${stats.avgNetRatePerKm.toFixed(2)} zł netto/km*`,
      `🥇 *Najlepsza:* *${stats.bestNetRate.toFixed(2)} zł/km*  |  🥉 *Najgorsza:* *${stats.worstNetRate.toFixed(2)} zł/km*`,
      `🛣️ *Łączny dystans ofert:* *${stats.totalDistanceKm.toFixed(1)} km*`,
      `💰 *Suma stawek brutto:* *${stats.totalGross.toFixed(2)} zł*`,
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // 8. Saldo Portfela Glovo: /saldo [kwota bazowa]
  bot.command('saldo', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);

    if (parts.length > 1) {
      const val = parseFloat(parts[1].replace(',', '.'));
      if (!isNaN(val)) {
        const effDate = financeService.getEffectiveDate();
        await financeService.setBalanceCheckpoint(ctx.from.id, effDate, val);
        await ctx.reply(`💳 *Ustawiono nowy punkt bazowy salda:* *${val.toFixed(2)} zł* na dzień \`${effDate}\`.`, {
          parse_mode: 'Markdown',
        });
        return;
      }
    }

    const balanceInfo = await financeService.getRollingBalance(ctx.from.id);
    const text = [
      '💼 *Saldo Portfela Glovo:*',
      `💵 *Aktualny stan:* *${balanceInfo.balance.toFixed(2)} zł*`,
      balanceInfo.checkpointDate
        ? `📍 _Ostatni punkt bazowy: ${balanceInfo.checkpointDate}_`
        : '⚠️ _Brak checkpointu – liczone z historii transakcji._',
      '',
      '💡 Aby ustawić nowy punkt odniesienia, wpisz np. `/saldo 127.50`.',
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // 9. Cele zarobkowe: /cel [kwota] | /cel tydzien [kwota] | /cele
  bot.command(['cel', 'target', 'cele'], async (ctx) => {
    const textParts = ctx.message.text.trim().split(/\s+/);

    if (textParts.length === 1) {
      const monthlyProgress = await financeService.getTargetProgress(ctx.from.id, 'MONTHLY');
      const weeklyProgress = await financeService.getTargetProgress(ctx.from.id, 'WEEKLY');

      if (!monthlyProgress && !weeklyProgress) {
        await ctx.reply('🎯 *Brak celów.* Ustaw cel wpisując np. `/cel 4000` lub `/cel tydzien 1200`.', {
          parse_mode: 'Markdown',
        });
        return;
      }

      const cards: string[] = [];
      if (monthlyProgress) cards.push(formatTargetCard(monthlyProgress));
      if (weeklyProgress) cards.push(formatTargetCard(weeklyProgress));

      await ctx.reply(cards.join('\n\n────────────────\n\n'), { parse_mode: 'Markdown' });
      return;
    }

    let periodType: 'MONTHLY' | 'WEEKLY' = 'MONTHLY';
    let amountStr = textParts[1];

    if (textParts.length >= 3) {
      if (['tydzien', 'week', 'w'].includes(textParts[1].toLowerCase())) {
        periodType = 'WEEKLY';
      }
      amountStr = textParts[2];
    }

    const targetAmount = parseFloat(amountStr.replace(',', '.'));
    if (isNaN(targetAmount) || targetAmount <= 0) {
      await ctx.reply('❌ Błędna kwota. Użyj np. `/cel 4000` lub `/cel tydzien 1200`.');
      return;
    }

    await financeService.setEarningTarget(ctx.from.id, periodType, targetAmount);
    const progress = await financeService.getTargetProgress(ctx.from.id, periodType);

    if (progress) {
      await ctx.reply(`✅ *Cel zapisany!*\n\n${formatTargetCard(progress)}`, { parse_mode: 'Markdown' });
    }
  });

  // 10. Szybkie napiwki (Regex: "n 5.5", "np 3", "napiwek 10")
  bot.hears(/^(?:n|np|napiwek)\s+(\d+(?:[.,]\d+)?)$/i, async (ctx) => {
    const rawAmount = ctx.match[1].replace(',', '.');
    const tipAmount = parseFloat(rawAmount);

    if (isNaN(tipAmount) || tipAmount <= 0) return;

    const effectiveDate = financeService.getEffectiveDate();
    await financeService.saveCashTip(ctx.from.id, effectiveDate, tipAmount);

    await ctx.reply(`💵 *Dodano napiwek:* \`+${tipAmount.toFixed(2)} zł\`\n📅 *Data:* \`${effectiveDate}\``, {
      parse_mode: 'Markdown',
    });
  });

  // 11. Potwierdzenie importu Portfela tekstowo ("tak" / "nie")
  bot.hears(/^(tak|t|zapisz|ok|yes|y|nie|n|anuluj)$/i, async (ctx) => {
    const pending = pendingWalletImports.get(String(ctx.from.id));
    if (!pending || Date.now() > pending.expiresAt) return;

    const text = ctx.match[1].toLowerCase();
    pendingWalletImports.delete(String(ctx.from.id));

    if (['nie', 'n', 'anuluj'].includes(text)) {
      await ctx.reply('✖️ *Anulowano import Portfela.* Nic nie zostało zapisane.', { parse_mode: 'Markdown' });
      return;
    }

    const saveResult = await financeService.saveWalletTransactions(ctx.from.id, pending.transactions);
    await ctx.reply(
      `✅ *Zapisano ${saveResult.added} transakcji do bazy.*\n📅 *Dotknięte dni:* \`${saveResult.dates.join(', ')}\``,
      { parse_mode: 'Markdown' }
    );
  });

  // 12. Przyciski Inline (Potwierdzenie importu Portfela)
  bot.action(/^wallet_(confirm|cancel)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const action = ctx.match[1];
    const pending = pendingWalletImports.get(String(ctx.from.id));

    if (!pending || Date.now() > pending.expiresAt) {
      await ctx.editMessageText('⌛ *Ta prośba o potwierdzenie wygasła.* Wyślij zrzut ponownie.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    pendingWalletImports.delete(String(ctx.from.id));

    if (action === 'cancel') {
      await ctx.editMessageText('✖️ *Anulowano import.* Nic nie zmieniono.', { parse_mode: 'Markdown' });
      return;
    }

    const saveResult = await financeService.saveWalletTransactions(ctx.from.id, pending.transactions);
    await ctx.editMessageText(
      `✅ *Zapisano ${saveResult.added} transakcji do bazy.*\n📅 *Zaktualizowane dni:* \`${saveResult.dates.join(', ')}\``,
      { parse_mode: 'Markdown' }
    );
  });

  // 13. Voice-to-Data (Audio / Głos)
  bot.on([message('voice'), message('audio')], async (ctx) => {
    const voiceMsg = 'voice' in ctx.message ? ctx.message.voice : ctx.message.audio;
    if (!voiceMsg) return;

    const processingMsg = await ctx.reply('🎙️ *Przetwarzam notatkę głosową...*', { parse_mode: 'Markdown' });

    try {
      const fileLink = await ctx.telegram.getFileLink(voiceMsg.file_id);
      const res = await fetch(fileLink.href);
      const audioBuffer = Buffer.from(await res.arrayBuffer());

      const mimeType = 'mime_type' in voiceMsg && voiceMsg.mime_type ? voiceMsg.mime_type : 'audio/ogg';
      const extracted = await geminiService.parseVoiceNote(audioBuffer, mimeType);

      if (extracted.action === 'DELETE' && extracted.deleteTarget) {
        const delResult = await financeService.handleVoiceDeletion(
          ctx.from.id,
          extracted.deleteTarget,
          extracted.targetDate
        );
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          processingMsg.message_id,
          undefined,
          `🗣️ _"${extracted.transcription}"_\n\n${delResult.success ? '🗑️' : '⚠️'} ${delResult.message}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const result = await financeService.saveVoiceEvent(ctx.from.id, extracted);
      const lines: string[] = [
        `🗣️ *Transkrypcja:* _"${extracted.transcription}"_`,
        `📅 *Data wpisu:* \`${result.date}\``,
        '',
      ];

      if (extracted.fuelPrice != null || extracted.fuelLiters != null || extracted.fuelDistance != null) {
        lines.push('⛽ *Zaktualizowano paliwo:*');
        if (extracted.fuelPrice != null) lines.push(` • Koszt: *${extracted.fuelPrice.toFixed(2)} zł*`);
        if (extracted.fuelLiters != null) lines.push(` • Ilość: *${extracted.fuelLiters} L*`);
        if (extracted.fuelDistance != null) lines.push(` • Licznik: *${extracted.fuelDistance} km*`);
      }

      if (extracted.grossEarnings != null) lines.push(`💰 *Zarobek brutto:* *${extracted.grossEarnings.toFixed(2)} zł*`);
      if (extracted.workFrom && extracted.workTo) lines.push(`⏱️ *Godziny:* \`${extracted.workFrom} - ${extracted.workTo}\``);
      if (extracted.cashTip != null) lines.push(`💵 *Napiwek gotówkowy:* *+${extracted.cashTip.toFixed(2)} zł*`);

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        lines.join('\n'),
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('[VoiceHandler Error]:', err);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        '❌ *Błąd przetwarzania audio.* Spróbuj ponownie.',
        { parse_mode: 'Markdown' }
      );
    }
  });

  // 14. Vision: Zdjęcia (Portfel Glovo, Paragony Paliwowe, Oferty Zleceń)
  bot.on(message('photo'), async (ctx) => {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const caption = ctx.message.caption || '';
    const processingMsg = await ctx.reply('🔍 *Analizuję obraz...*', { parse_mode: 'Markdown' });

    try {
      const fileLink = await ctx.telegram.getFileLink(photo.file_id);
      const res = await fetch(fileLink.href);
      const imageBuffer = Buffer.from(await res.arrayBuffer());

      const category = await geminiService.classifyImage(imageBuffer, caption);

      // Ścieżka 1: Zrzut ekranu Portfela Glovo
      if (category === 'WALLET') {
        const transactions = await geminiService.analyzeWalletScreenshot(imageBuffer);

        if (!transactions.length) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            processingMsg.message_id,
            undefined,
            '⚠️ *Nie rozpoznano żadnych pozycji w zrzucie Portfela.*',
            { parse_mode: 'Markdown' }
          );
          return;
        }

        const preview = await financeService.previewWalletImport(ctx.from.id, transactions);

        if (preview.newTransactions.length === 0) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            processingMsg.message_id,
            undefined,
            `ℹ️ *Wszystkie ${transactions.length} transakcji z tego zrzutu są już zapisane w bazie.* (Brak duplikatów).`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        pendingWalletImports.set(String(ctx.from.id), {
          transactions: preview.newTransactions,
          expiresAt: Date.now() + 15 * 60 * 1000,
        });

        const lines: string[] = [
          '📥 *Rozpoznano transakcje Portfela Glovo:*',
          '',
          ...preview.newTransactions.map(
            (t) => `• \`${t.date} ${t.time}\` *${t.type}* ➔ *${t.amount > 0 ? '+' : ''}${t.amount.toFixed(2)} zł*`
          ),
          '',
          `➕ *Nowe:* ${preview.newTransactions.length} szt.  |  ⏭ *Pominięte duplikaty:* ${preview.existingCount}`,
          `💵 *Wpływ na saldo:* *${preview.totalAmountDelta > 0 ? '+' : ''}${preview.totalAmountDelta.toFixed(2)} zł*`,
        ];

        await ctx.telegram.editMessageText(
          ctx.chat.id,
          processingMsg.message_id,
          undefined,
          lines.join('\n'),
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('✅ Zapisz transakcje', 'wallet_confirm'),
                Markup.button.callback('✖️ Anuluj', 'wallet_cancel'),
              ],
            ]),
          }
        );
        return;
      }

      // Ścieżka 2: Paragon paliwowy
      if (category === 'FUEL') {
        const receipt = await geminiService.extractFuelReceipt(imageBuffer);
        const effectiveDate = receipt.date || financeService.getEffectiveDate();

        await financeService.saveFuelReceipt(
          ctx.from.id,
          effectiveDate,
          receipt.fuelPrice || 0,
          receipt.fuelLiters || null
        );

        const lines = [
          '🧾 *Zarejestrowano paragon paliwowy:*',
          `📅 *Data:* \`${effectiveDate}\``,
          `💰 *Kwota:* *${receipt.fuelPrice ? receipt.fuelPrice.toFixed(2) : '0.00'} zł*`,
        ];
        if (receipt.fuelLiters) lines.push(`⛽ *Litry:* *${receipt.fuelLiters} L*`);

        await ctx.telegram.editMessageText(
          ctx.chat.id,
          processingMsg.message_id,
          undefined,
          lines.join('\n'),
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Ścieżka 3: Oferta kursu Glovo
      const offer = await geminiService.analyzeCourseOffer(imageBuffer);
      const userLoc = lastCourierLocation.get(String(ctx.from.id));
      const hasRecentLocation = userLoc && Date.now() - userLoc.updatedAt <= 30 * 60 * 1000;

      let totalKm = offer.appDistanceKm || 0;
      let calculatedViaMaps = false;

      if (hasRecentLocation && userLoc) {
        const origin = `${userLoc.latitude},${userLoc.longitude}`;
        const routeData = await mapsService.calculateFullDeliveryRoute(
          origin,
          offer.pickupAddress,
          offer.deliveryAddress
        );
        if (routeData) {
          totalKm = routeData.totalDistanceKm;
          calculatedViaMaps = true;
        }
      }

      const netAmount = Math.round(offer.grossAmount * NETTO_FACTOR * 100) / 100;
      const netRatePerKm = totalKm > 0 ? Math.round((netAmount / totalKm) * 100) / 100 : 0;
      const isProfitable = netRatePerKm >= MIN_STAWKA_NETTO_KM;

      await financeService.saveCourseOffer(ctx.from.id, {
        grossAmount: offer.grossAmount,
        netAmount,
        totalDistance: totalKm,
        netRatePerKm,
        isProfitable,
        pickupAddress: offer.pickupAddress,
        deliveryAddress: offer.deliveryAddress,
      });

      const responseLines = [
        isProfitable ? '✅ *KURS OPŁACALNY*' : '❌ *KURS SŁABY / ODRZUĆ*',
        '',
        `💵 *Stawka:* *${offer.grossAmount.toFixed(2)} zł brutto* ➔ *${netAmount.toFixed(2)} zł netto*`,
        `📍 *Trasa:* \`${offer.pickupAddress}\` ➔ \`${offer.deliveryAddress}\``,
        `🛣️ *Dystans:* *${totalKm.toFixed(1)} km* ${calculatedViaMaps ? '_(zweryfikowany Google Maps)_' : '_(z aplikacji)_'}`,
        `📊 *Stawka netto/km:* *${netRatePerKm.toFixed(2)} zł / km* (Min: ${MIN_STAWKA_NETTO_KM.toFixed(2)} zł)`,
      ];

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        responseLines.join('\n'),
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('[PhotoHandler Error]:', err);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        '❌ *Błąd analizy obrazu.* Spróbuj ponownie.',
        { parse_mode: 'Markdown' }
      );
    }
  });
}
```


# Plik: src/services/maps.service.ts
```typescript
import 'dotenv/config';
import { CFG } from '../config.js';

interface LatLng {
  lat: number;
  lng: number;
}

const geoCache = new Map<string, LatLng>();

export async function geocodeAddress(address: string): Promise<LatLng | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  if (geoCache.has(address)) return geoCache.get(address)!;

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;

  const data = await res.json();
  if (data.status !== 'OK' || !data.results?.[0]?.geometry?.location) return null;

  const loc: LatLng = data.results[0].geometry.location;
  geoCache.set(address, loc);
  return loc;
}

export async function getRoadDistanceKm(origin: LatLng, dest: LatLng): Promise<number | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin.lat},${origin.lng}&destinations=${dest.lat},${dest.lng}&mode=driving&units=metric&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;

  const data = await res.json();
  const element = data.rows?.[0]?.elements?.[0];
  if (!element || element.status !== 'OK' || !element.distance?.value) return null;

  return Math.round((element.distance.value / 1000) * 100) / 100;
}

export async function verifyOfferDistance(
  userLoc: { lat: number; lng: number; ts: number } | null,
  points: Array<{ rodzaj: string; nazwa?: string | null; adres?: string | null; dystans_km?: number | null }>
) {
  if (!userLoc || (Date.now() - userLoc.ts) > CFG.LOCATION_MAX_AGE_MS) {
    return { available: false, results: [] };
  }

  const results: Array<{ name: string; reported: number | null; actual: number | null; diff: number | null; error?: string }> = [];

  for (const p of points) {
    if (p.rodzaj !== 'odbior' || !p.adres) continue;

    const geo = await geocodeAddress(p.adres);
    if (!geo) {
      results.push({ name: p.nazwa || p.adres, reported: p.dystans_km || null, actual: null, diff: null, error: 'Błąd geokodowania adresu' });
      continue;
    }

    const actual = await getRoadDistanceKm({ lat: userLoc.lat, lng: userLoc.lng }, geo);
    if (actual === null) {
      results.push({ name: p.nazwa || p.adres, reported: p.dystans_km || null, actual: null, diff: null, error: 'Błąd wyznaczenia trasy' });
      continue;
    }

    const reported = p.dystans_km || null;
    const diff = reported !== null ? Math.round((actual - reported) * 100) / 100 : null;

    results.push({ name: p.nazwa || p.adres, reported, actual, diff });
  }

  return {
    available: true,
    ageMin: Math.max(0, Math.round((Date.now() - userLoc.ts) / 60000)),
    results
  };
}
```


# Plik: src/scripts/import-sheets.ts
```typescript
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
```


# Plik: src/config.ts
```typescript
export const CFG = {
  TAX_FACTOR: 0.186,          // 18,6% składki i podatek (UoP >26 lat)
  NETTO_FACTOR: 0.814,        // 81,4% kwoty brutto -> netto
  MIN_STAWKA_NETTO_KM: 2.0,   // Próg opłacalności kursu (zł netto / km)
  TOLERANCJA_KM: 0.3,         // Dopuszczalna rozbieżność trasy (km)
  LOCATION_MAX_AGE_MS: 30 * 60 * 1000, // Ważność lokalizacji (30 min)
  MAX_AUDIO_BYTES: 15 * 1024 * 1024,
  MAX_PHOTO_BYTES: 20 * 1024 * 1024,
  HISTORY_LEN: 5,
};
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
```


# Plik: src/db/index.ts
```typescript
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });
```
