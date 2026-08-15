import { db } from '../db';
import {
  dailyRecords,
  cashTips,
  walletTransactions,
  balanceCheckpoints,
  courseOffers,
  earningTargets,
} from '../db/schema';
import { eq, and, gte, lte, sql, desc } from 'drizzle-orm';
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
  workFrom: string | null;
  workTo: string | null;
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
  accepted: number;
  rejected: number;
  pending: number;
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
    const hour = parseInt(timeStr.split(':')[0] || '0', 10);
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
    if (fH === undefined || fM === undefined || tH === undefined || tM === undefined) return 0;

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
  ): Promise<number> {
    const now = new Date();
    const date = this.getEffectiveDate(now);
    const time = now.toTimeString().slice(0, 5);

    const [inserted] = await db
      .insert(courseOffers)
      .values({
        telegramId: String(telegramId),
        date,
        time,
        grossAmount: data.grossAmount.toFixed(2),
        netAmount: data.netAmount.toFixed(2),
        totalDistance: data.totalDistance.toFixed(2),
        netRatePerKm: data.netRatePerKm.toFixed(2),
        isProfitable: data.isProfitable,
        status: 'PENDING',
        pointsJson: JSON.stringify({
          pickup: data.pickupAddress,
          delivery: data.deliveryAddress,
        }),
        verificationText: data.verificationText || null,
      })
      .returning({ id: courseOffers.id });

    if (!inserted) {
      throw new Error('Nie udało się zapisać oferty w bazie.');
    }

    return inserted.id;
  }

  async updateCourseOfferStatus(
    offerId: number,
    telegramId: string | number,
    status: 'ACCEPTED' | 'REJECTED'
  ): Promise<boolean> {
    const result = await db
      .update(courseOffers)
      .set({ status })
      .where(and(eq(courseOffers.id, offerId), eq(courseOffers.telegramId, String(telegramId))))
      .returning({ id: courseOffers.id });

    return result.length > 0;
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

  async finishShift(
    telegramId: string | number,
    data: {
      date: string;
      workTo?: string | null;
      fuelDistance?: number | null;
      walletCash?: number | null;
    }
  ): Promise<DailySummary> {
    const tId = String(telegramId);
    const date = data.date;

    const [existing] = await db
      .select()
      .from(dailyRecords)
      .where(and(eq(dailyRecords.telegramId, tId), eq(dailyRecords.date, date)))
      .limit(1);

    const workFrom = existing?.workFrom || null;
    const workTo = data.workTo || existing?.workTo || null;
    let workHoursStr: string | null = existing?.workHours || null;

    if (workFrom && workTo) {
      const calcH = this.calculateHours(workFrom, workTo);
      workHoursStr = calcH > 0 ? calcH.toString() : null;
    }

    await db
      .insert(dailyRecords)
      .values({
        telegramId: tId,
        date,
        workFrom,
        workTo,
        workHours: workHoursStr,
        fuelDistance: data.fuelDistance != null ? data.fuelDistance : (existing?.fuelDistance ?? null),
      })
      .onConflictDoUpdate({
        target: [dailyRecords.telegramId, dailyRecords.date],
        set: {
          ...(workTo && { workTo }),
          ...(workHoursStr && { workHours: workHoursStr }),
          ...(data.fuelDistance != null && { fuelDistance: data.fuelDistance }),
        },
      });

    if (data.walletCash != null) {
      await this.setBalanceCheckpoint(tId, date, data.walletCash);
    }

    return this.getDailySummary(tId, date);
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
      workFrom: record?.workFrom || null,
      workTo: record?.workTo || null,
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
    let accepted = 0;
    let rejected = 0;
    let pending = 0;
    let sumRates = 0;
    let bestRate = 0;
    let worstRate = 999;
    let totalGross = 0;
    let totalDistanceKm = 0;

    for (const o of offers) {
      if (o.isProfitable) profitable++;
      else unprofitable++;

      if (o.status === 'ACCEPTED') accepted++;
      else if (o.status === 'REJECTED') rejected++;
      else pending++;

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
      accepted,
      rejected,
      pending,
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