import { db } from '../db';
import {
  dailyRecords,
  cashTips,
  walletTransactions,
  balanceCheckpoints,
  courseOffers,
} from '../db/schema';
import { eq, and, gte, lte, sql, desc } from 'drizzle-orm';
import { NETTO_FACTOR } from '../config';
import { VoiceExtractedData } from './gemini.service';

export interface DailySummary {
  date: string;
  grossEarnings: number;
  netEarnings: number;
  cashTipsTotal: number;
  totalNetto: number;
  workHours: number;
  hourlyRateNetto: number;
  fuelPrice: number;
  fuelLiters: number;
  fuelDistance: number | null;
}

export class FinanceService {
  /**
   * Reguła nocnej zmiany (00:00 - 03:59 -> wczorajsza data).
   */
  getEffectiveDate(d = new Date()): string {
    const target = new Date(d);
    if (target.getHours() < 4) {
      target.setDate(target.getDate() - 1);
    }
    return target.toISOString().slice(0, 10);
  }

  resolveTargetDate(targetDateStr?: string | null): string {
    if (!targetDateStr) return this.getEffectiveDate();
    const upper = targetDateStr.toUpperCase();
    if (upper === 'TODAY' || upper === 'DZISIAJ' || upper === 'DZIŚ') {
      return this.getEffectiveDate();
    }
    if (upper === 'YESTERDAY' || upper === 'WCZORAJ') {
      const d = new Date();
      if (d.getHours() < 4) {
        d.setDate(d.getDate() - 2);
      } else {
        d.setDate(d.getDate() - 1);
      }
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

  async saveCashTip(telegramId: string | number, date: string, amount: number): Promise<void> {
    await db.insert(cashTips).values({
      telegramId: String(telegramId),
      date,
      amount: amount.toFixed(2),
    });
  }

  async saveFuelReceipt(
    telegramId: string | number,
    date: string,
    price: number,
    liters: number | null
  ): Promise<void> {
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
          const [anyLastTip] = await db
            .select()
            .from(cashTips)
            .where(eq(cashTips.telegramId, tId))
            .orderBy(desc(cashTips.createdAt))
            .limit(1);

          if (!anyLastTip) {
            return { success: false, message: 'Nie znaleziono żadnych napiwków do usunięcia.', date };
          }

          await db.delete(cashTips).where(eq(cashTips.id, anyLastTip.id));
          return {
            success: true,
            message: `Usunięto ostatni zarejestrowany napiwek: *${parseFloat(anyLastTip.amount).toFixed(2)} zł* (z dnia \`${anyLastTip.date}\`).`,
            date: anyLastTip.date,
          };
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

        if (deleted.length === 0) {
          return { success: false, message: `Brak napiwków do skasowania w dniu \`${date}\`.`, date };
        }

        const totalAmount = deleted.reduce((sum, item) => sum + parseFloat(item.amount), 0);
        return {
          success: true,
          message: `Skasowano wszystkie napiwki (${deleted.length} szt., łącznie *${totalAmount.toFixed(2)} zł*) z dnia \`${date}\`.`,
          date,
        };
      }

      case 'FUEL': {
        const [existing] = await db
          .select()
          .from(dailyRecords)
          .where(and(eq(dailyRecords.telegramId, tId), eq(dailyRecords.date, date)))
          .limit(1);

        if (!existing || (!existing.fuelPrice && !existing.fuelLiters && !existing.fuelDistance)) {
          return { success: false, message: `Brak wpisów paliwowych do wyczyszczenia w dniu \`${date}\`.`, date };
        }

        await db
          .update(dailyRecords)
          .set({ fuelPrice: null, fuelLiters: null, fuelDistance: null })
          .where(and(eq(dailyRecords.telegramId, tId), eq(dailyRecords.date, date)));

        return {
          success: true,
          message: `Wyczyszczono dane tankowania i licznika z dnia \`${date}\`.`,
          date,
        };
      }

      case 'HOURS': {
        const [existing] = await db
          .select()
          .from(dailyRecords)
          .where(and(eq(dailyRecords.telegramId, tId), eq(dailyRecords.date, date)))
          .limit(1);

        if (!existing || (!existing.workFrom && !existing.workTo && !existing.workHours)) {
          return { success: false, message: `Brak wpisów godzin pracy w dniu \`${date}\`.`, date };
        }

        await db
          .update(dailyRecords)
          .set({ workFrom: null, workTo: null, workHours: null })
          .where(and(eq(dailyRecords.telegramId, tId), eq(dailyRecords.date, date)));

        return {
          success: true,
          message: `Wyczyszczono godziny pracy z dnia \`${date}\`.`,
          date,
        };
      }

      case 'EARNINGS': {
        const [existing] = await db
          .select()
          .from(dailyRecords)
          .where(and(eq(dailyRecords.telegramId, tId), eq(dailyRecords.date, date)))
          .limit(1);

        if (!existing || !existing.grossEarnings) {
          return { success: false, message: `Brak wpisu zarobków brutto w dniu \`${date}\`.`, date };
        }

        await db
          .update(dailyRecords)
          .set({ grossEarnings: null })
          .where(and(eq(dailyRecords.telegramId, tId), eq(dailyRecords.date, date)));

        return {
          success: true,
          message: `Wyczyszczono zarobek brutto z dnia \`${date}\`.`,
          date,
        };
      }

      case 'ALL_DAY': {
        await db
          .delete(dailyRecords)
          .where(and(eq(dailyRecords.telegramId, tId), eq(dailyRecords.date, date)));
        await db
          .delete(cashTips)
          .where(and(eq(cashTips.telegramId, tId), eq(cashTips.date, date)));

        return {
          success: true,
          message: `Usunięto cały rekord dzienny oraz powiązane napiwki z dnia \`${date}\`.`,
          date,
        };
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

    const gross = record?.grossEarnings ? parseFloat(record.grossEarnings) : 0;
    const netEarnings = Math.round(gross * NETTO_FACTOR * 100) / 100;
    const cashTipsTotal = tips[0]?.total ? parseFloat(tips[0].total) : 0;
    const totalNetto = Math.round((netEarnings + cashTipsTotal) * 100) / 100;
    const workHours = record?.workHours ? parseFloat(record.workHours) : 0;
    const hourlyRateNetto = workHours > 0 ? Math.round((totalNetto / workHours) * 100) / 100 : 0;

    return {
      date,
      grossEarnings: gross,
      netEarnings,
      cashTipsTotal,
      totalNetto,
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
    totalWorkHours: number;
    avgHourlyRateNetto: number;
    totalFuelCost: number;
  }> {
    const tId = String(telegramId);

    const records = await db
      .select()
      .from(dailyRecords)
      .where(
        and(
          eq(dailyRecords.telegramId, tId),
          gte(dailyRecords.date, startDate),
          lte(dailyRecords.date, endDate)
        )
      );

    const tips = await db
      .select({ total: sql<string>`coalesce(sum(amount), 0)` })
      .from(cashTips)
      .where(
        and(
          eq(cashTips.telegramId, tId),
          gte(cashTips.date, startDate),
          lte(cashTips.date, endDate)
        )
      );

    let totalGross = 0;
    let totalWorkHours = 0;
    let totalFuelCost = 0;

    for (const r of records) {
      if (r.grossEarnings) totalGross += parseFloat(r.grossEarnings);
      if (r.workHours) totalWorkHours += parseFloat(r.workHours);
      if (r.fuelPrice) totalFuelCost += parseFloat(r.fuelPrice);
    }

    const totalNettoEarnings = Math.round(totalGross * NETTO_FACTOR * 100) / 100;
    const totalCashTips = tips[0]?.total ? parseFloat(tips[0].total) : 0;
    const grandTotalNetto = Math.round((totalNettoEarnings + totalCashTips) * 100) / 100;
    const avgHourlyRateNetto =
      totalWorkHours > 0 ? Math.round((grandTotalNetto / totalWorkHours) * 100) / 100 : 0;

    return {
      startDate,
      endDate,
      totalGross,
      totalNettoEarnings,
      totalCashTips,
      grandTotalNetto,
      totalWorkHours,
      avgHourlyRateNetto,
      totalFuelCost,
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
      .where(
        and(
          eq(balanceCheckpoints.telegramId, tId),
          lte(balanceCheckpoints.date, targetDate)
        )
      )
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
}

export const financeService = new FinanceService();