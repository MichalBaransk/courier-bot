import { db } from '../db/index.js';
import {
  dailyRecords,
  cashTips,
  fuelReceipts,
  walletTransactions,
  courseOffers,
  earningTargets,
} from '../db/schema.js';
import { eq, and, gte, lte, inArray, sql, desc } from 'drizzle-orm';
import { CFG } from '../config.js';
import {
  todayWarsaw,
  nowTimeWarsaw,
  addDays,
  daysInMonth,
  isoDayOfWeek,
  isoWeek,
  isValidDateStr,
  normalizeTime,
  splitDate,
  weekRange,
  weekRangeFor,
  calculateHours,
  type DateRange,
} from '../utils/datetime.js';
import {
  computeDailyTotals,
  partitionNewTransactions,
  round2,
  sumWalletPayouts,
  walletKey,
} from './finance.calc.js';
import type { VoiceExtractedData, WalletTransactionItem } from './gemini.service.js';

export interface DailySummary {
  date: string;
  grossEarnings: number;
  netEarnings: number;
  cashTipsTotal: number;
  totalNetto: number;
  walletPayouts: number;
  doPrzelewu: number;
  workFrom: string | null;
  workTo: string | null;
  workHours: number;
  hourlyRateNetto: number;
  fuelCost: number;
  fuelLiters: number;
  fuelPricePerLiter: number | null;
  fuelReceiptCount: number;
  distanceKm: number | null;
}

export interface PeriodSummary extends DateRange {
  totalGross: number;
  totalNettoEarnings: number;
  totalCashTips: number;
  grandTotalNetto: number;
  totalWalletPayouts: number;
  totalDoPrzelewu: number;
  totalWorkHours: number;
  avgHourlyRateNetto: number;
  totalFuelCost: number;
  totalFuelLiters: number;
  avgPricePerLiter: number | null;
  totalDistanceKm: number;
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
  usedFallbackRate: boolean;
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
  /** Srednia arytmetyczna stawek pojedynczych ofert - "jakie oferty przychodza". */
  avgNetRatePerKm: number | null;
  /** Suma netto / suma km - "ile realnie wychodzi na kilometr". */
  weightedNetRatePerKm: number | null;
  bestNetRate: number | null;
  worstNetRate: number | null;
  totalGross: number;
  totalDistanceKm: number;
}

export interface WalletImportPreview {
  newTransactions: WalletTransactionItem[];
  existingCount: number;
  totalAmountDelta: number;
  dates: string[];
}

const num = (v: string | null | undefined): number => (v ? parseFloat(v) : 0);
const numOrNull = (v: string | null | undefined): number | null => (v ? parseFloat(v) : null);

export class FinanceService {
  // --- Daty -----------------------------------------------------------------

  /**
   * Data, do ktorej trafiaja wpisy robione "teraz".
   *
   * FIX (2.1): to po prostu dzisiejsza data kalendarzowa w Europe/Warsaw.
   * Doba konczy sie o polnocy - wpis o 01:00 nalezy do nowego dnia.
   * Poprzednia wersja mieszala `getHours()` (czas lokalny serwera) z
   * `toISOString()` (UTC) i na serwerze w UTC cofala date w godzinach 04:00-06:00.
   */
  getEffectiveDate(): string {
    return todayWarsaw();
  }

  resolveTargetDate(targetDateStr?: string | null): string {
    if (!targetDateStr) return this.getEffectiveDate();

    const upper = targetDateStr.trim().toUpperCase();
    if (['TODAY', 'DZISIAJ', 'DZIS', 'DZIŚ'].includes(upper)) return this.getEffectiveDate();
    if (['YESTERDAY', 'WCZORAJ'].includes(upper)) return addDays(this.getEffectiveDate(), -1);
    if (isValidDateStr(targetDateStr)) return targetDateStr;

    return this.getEffectiveDate();
  }

  getWeekRange(offsetWeeks = 0): DateRange {
    return weekRange(this.getEffectiveDate(), offsetWeeks);
  }

  // --- Zmiana ---------------------------------------------------------------

  async setShiftStart(
    telegramId: string | number,
    date: string,
    workFrom: string
  ): Promise<{ summary: DailySummary; hoursError: string | null }> {
    const tId = String(telegramId);
    const from = normalizeTime(workFrom);
    if (!from) throw new Error('Nieprawidłowy format godziny wyjazdu.');

    const existing = await this.getDailyRecord(tId, date);

    let hours: number | null = null;
    let hoursError: string | null = null;
    if (existing?.workTo) {
      const res = calculateHours(from, existing.workTo);
      hours = res.hours;
      hoursError = res.error;
    }

    await db
      .insert(dailyRecords)
      .values({
        telegramId: tId,
        date,
        workFrom: from,
        workTo: existing?.workTo ?? null,
        workHours: hours !== null ? hours.toFixed(2) : null,
      })
      .onConflictDoUpdate({
        target: [dailyRecords.telegramId, dailyRecords.date],
        set: {
          workFrom: from,
          // Godziny przeliczamy zawsze gdy da sie je policzyc - takze na null,
          // zeby po poprawce wyjazdu nie zostawala stara, nieaktualna wartosc.
          ...(existing?.workTo ? { workHours: hours !== null ? hours.toFixed(2) : null } : {}),
        },
      });

    return { summary: await this.getDailySummary(tId, date), hoursError };
  }

  async setShiftEnd(
    telegramId: string | number,
    date: string,
    data: { workTo?: string | null; distanceKm?: number | null }
  ): Promise<{ summary: DailySummary; hoursError: string | null }> {
    const tId = String(telegramId);
    const existing = await this.getDailyRecord(tId, date);

    const workFrom = existing?.workFrom ?? null;
    const workTo = data.workTo ? normalizeTime(data.workTo) : (existing?.workTo ?? null);
    if (data.workTo && !workTo) throw new Error('Nieprawidłowy format godziny zjazdu.');

    let hours: number | null = existing?.workHours ? parseFloat(existing.workHours) : null;
    let hoursError: string | null = null;
    if (workFrom && workTo) {
      const res = calculateHours(workFrom, workTo);
      hours = res.hours;
      hoursError = res.error;
    }

    await db
      .insert(dailyRecords)
      .values({
        telegramId: tId,
        date,
        workFrom,
        workTo,
        workHours: hours !== null ? hours.toFixed(2) : null,
        distanceKm: data.distanceKm != null ? data.distanceKm.toFixed(2) : null,
      })
      .onConflictDoUpdate({
        target: [dailyRecords.telegramId, dailyRecords.date],
        set: {
          ...(workTo ? { workTo } : {}),
          ...(workFrom && workTo ? { workHours: hours !== null ? hours.toFixed(2) : null } : {}),
          ...(data.distanceKm != null ? { distanceKm: data.distanceKm.toFixed(2) } : {}),
        },
      });

    return { summary: await this.getDailySummary(tId, date), hoursError };
  }

  private async getDailyRecord(tId: string, date: string) {
    const [record] = await db
      .select()
      .from(dailyRecords)
      .where(and(eq(dailyRecords.telegramId, tId), eq(dailyRecords.date, date)))
      .limit(1);
    return record;
  }

  // --- Napiwki i paliwo -----------------------------------------------------

  async saveCashTip(telegramId: string | number, date: string, amount: number): Promise<void> {
    await db.insert(cashTips).values({
      telegramId: String(telegramId),
      date,
      amount: amount.toFixed(2),
    });
  }

  /**
   * FIX (2.8): kazdy paragon to osobny wiersz. Drugie tankowanie tego samego dnia
   * dodaje sie do sumy zamiast nadpisywac pierwsze.
   * FIX (5.3): trzymamy koszt calosci ORAZ cene za litr.
   */
  async saveFuelReceipt(
    telegramId: string | number,
    date: string,
    data: { totalCost: number; liters?: number | null; pricePerLiter?: number | null }
  ): Promise<void> {
    const liters = data.liters ?? null;
    const pricePerLiter =
      data.pricePerLiter ?? (liters && liters > 0 ? round2(data.totalCost / liters) : null);

    await db.insert(fuelReceipts).values({
      telegramId: String(telegramId),
      date,
      totalCost: data.totalCost.toFixed(2),
      liters: liters != null ? liters.toFixed(2) : null,
      pricePerLiter: pricePerLiter != null ? pricePerLiter.toFixed(3) : null,
    });
  }

  async setDailyDistance(telegramId: string | number, date: string, distanceKm: number): Promise<void> {
    const tId = String(telegramId);
    await db
      .insert(dailyRecords)
      .values({ telegramId: tId, date, distanceKm: distanceKm.toFixed(2) })
      .onConflictDoUpdate({
        target: [dailyRecords.telegramId, dailyRecords.date],
        set: { distanceKm: distanceKm.toFixed(2) },
      });
  }

  async setGrossEarnings(telegramId: string | number, date: string, gross: number): Promise<void> {
    const tId = String(telegramId);
    await db
      .insert(dailyRecords)
      .values({ telegramId: tId, date, grossEarnings: gross.toFixed(2) })
      .onConflictDoUpdate({
        target: [dailyRecords.telegramId, dailyRecords.date],
        set: { grossEarnings: gross.toFixed(2) },
      });
  }

  // --- Portfel Glovo --------------------------------------------------------

  /**
   * FIX (2.2): saldo to po prostu suma kwot wszystkich transakcji.
   * Nie ma juz tabeli `balance_checkpoints`, ktora dublowala transakcje z dnia
   * checkpointu (warunek `gte` obejmowal takze operacje sprzed jego zapisania).
   *
   * Znaki: pobranie (+), wyplata (-), wyplata_gotowka (-), platnosc_punkt (-), korekta (+/-).
   */
  async getWalletBalance(
    telegramId: string | number,
    toDate?: string
  ): Promise<{ balance: number; transactionCount: number; lastDate: string | null }> {
    const tId = String(telegramId);
    const conditions = [eq(walletTransactions.telegramId, tId)];
    if (toDate) conditions.push(lte(walletTransactions.date, toDate));

    const [row] = await db
      .select({
        total: sql<string>`coalesce(sum(${walletTransactions.amount}), 0)`,
        count: sql<number>`count(*)::int`,
        lastDate: sql<string | null>`max(${walletTransactions.date})`,
      })
      .from(walletTransactions)
      .where(and(...conditions));

    return {
      balance: round2(num(row?.total)),
      transactionCount: row?.count ?? 0,
      lastDate: row?.lastDate ?? null,
    };
  }

  /**
   * Reczne wyrownanie salda do podanej wartosci.
   * Zapisuje sie jako transakcja 'korekta', wiec saldo dalej jest wylacznie
   * suma transakcji, a historia pozostaje audytowalna.
   */
  async adjustWalletBalance(
    telegramId: string | number,
    date: string,
    targetBalance: number
  ): Promise<{ delta: number; balance: number }> {
    const tId = String(telegramId);
    const { balance: current } = await this.getWalletBalance(tId);
    const delta = round2(targetBalance - current);

    if (Math.abs(delta) >= 0.01) {
      await db
        .insert(walletTransactions)
        .values({
          telegramId: tId,
          date,
          time: nowTimeWarsaw(),
          type: 'korekta',
          amount: delta.toFixed(2),
          externalId: `manual-${Date.now()}`,
          source: 'MANUAL',
        })
        .onConflictDoNothing();
    }

    return { delta, balance: targetBalance };
  }

  /**
   * FIX (2.6): jedno zapytanie zamiast N.
   * FIX (2.5): klucz porownania jest identyczny z kolumnami unikalnego indeksu.
   */
  async previewWalletImport(
    telegramId: string | number,
    transactions: WalletTransactionItem[]
  ): Promise<WalletImportPreview> {
    const tId = String(telegramId);

    const normalized = transactions.map((t) => ({
      ...t,
      time: normalizeTime(t.time) ?? t.time,
      externalId: t.externalId ?? '',
    }));

    const dates = Array.from(new Set(normalized.map((t) => t.date))).sort();
    if (dates.length === 0) {
      return { newTransactions: [], existingCount: 0, totalAmountDelta: 0, dates: [] };
    }

    const existingRows = await db
      .select({
        date: walletTransactions.date,
        time: walletTransactions.time,
        type: walletTransactions.type,
        amount: walletTransactions.amount,
        externalId: walletTransactions.externalId,
      })
      .from(walletTransactions)
      .where(and(eq(walletTransactions.telegramId, tId), inArray(walletTransactions.date, dates)));

    const existingKeys = new Set(
      existingRows.map((r) =>
        walletKey({
          date: r.date,
          time: r.time,
          type: r.type,
          amount: parseFloat(r.amount),
          externalId: r.externalId,
        })
      )
    );

    const { newItems, duplicates, totalDelta } = partitionNewTransactions(normalized, existingKeys);

    return {
      newTransactions: newItems,
      existingCount: duplicates,
      totalAmountDelta: totalDelta,
      dates,
    };
  }

  async saveWalletTransactions(
    telegramId: string | number,
    transactions: WalletTransactionItem[]
  ): Promise<{ added: number; skipped: number; dates: string[]; balance: number }> {
    const tId = String(telegramId);
    const preview = await this.previewWalletImport(tId, transactions);

    if (preview.newTransactions.length > 0) {
      await db
        .insert(walletTransactions)
        .values(
          preview.newTransactions.map((t) => ({
            telegramId: tId,
            date: t.date,
            time: t.time,
            type: t.type,
            amount: t.amount.toFixed(2),
            externalId: t.externalId ?? '',
            source: 'OCR',
          }))
        )
        // FIX (2.5): przy dwoch zrzutach pod rzad wyscig nie wywala juz handlera.
        .onConflictDoNothing();
    }

    const { balance } = await this.getWalletBalance(tId);

    return {
      added: preview.newTransactions.length,
      skipped: preview.existingCount,
      dates: preview.dates,
      balance,
    };
  }

  // --- Oferty kursow --------------------------------------------------------

  async saveCourseOffer(
    telegramId: string | number,
    data: {
      grossAmount: number;
      netAmount: number;
      distancePickupKm: number | null;
      distanceDeliveryKm: number | null;
      distanceTotalKm: number;
      distanceSource: 'MAPS' | 'APP';
      netRatePerKm: number;
      isProfitable: boolean;
      pickupAddress: string;
      deliveryAddress: string;
    }
  ): Promise<number> {
    const [inserted] = await db
      .insert(courseOffers)
      .values({
        telegramId: String(telegramId),
        date: this.getEffectiveDate(),
        time: nowTimeWarsaw(),
        grossAmount: data.grossAmount.toFixed(2),
        netAmount: data.netAmount.toFixed(2),
        distancePickupKm: data.distancePickupKm != null ? data.distancePickupKm.toFixed(2) : null,
        distanceDeliveryKm: data.distanceDeliveryKm != null ? data.distanceDeliveryKm.toFixed(2) : null,
        distanceTotalKm: data.distanceTotalKm.toFixed(2),
        distanceSource: data.distanceSource,
        netRatePerKm: data.netRatePerKm.toFixed(2),
        isProfitable: data.isProfitable,
        status: 'PENDING',
        pickupAddress: data.pickupAddress,
        deliveryAddress: data.deliveryAddress,
      })
      .returning({ id: courseOffers.id });

    if (!inserted) throw new Error('Błąd zapisu oferty kursu.');
    return inserted.id;
  }

  /**
   * FIX (3.7): zwraca zaktualizowany wiersz (albo null), zeby bot mial
   * z czego przerysowac karte i nie potwierdzal zapisu, ktorego nie bylo.
   */
  async updateCourseOfferStatus(
    offerId: number,
    telegramId: string | number,
    status: 'ACCEPTED' | 'REJECTED'
  ): Promise<typeof courseOffers.$inferSelect | null> {
    const [updated] = await db
      .update(courseOffers)
      .set({ status })
      .where(and(eq(courseOffers.id, offerId), eq(courseOffers.telegramId, String(telegramId))))
      .returning();

    return updated ?? null;
  }

  // --- Wpisy glosowe --------------------------------------------------------

  async saveVoiceEvent(
    telegramId: string | number,
    data: VoiceExtractedData
  ): Promise<{ date: string; hasDailyUpdate: boolean; hasTip: boolean; hasFuel: boolean; hoursError: string | null }> {
    const tId = String(telegramId);
    const date = this.resolveTargetDate(data.targetDate);
    let hasDailyUpdate = false;
    let hasTip = false;
    let hasFuel = false;
    let hoursError: string | null = null;

    if (data.cashTip != null && data.cashTip > 0) {
      await this.saveCashTip(tId, date, data.cashTip);
      hasTip = true;
    }

    if (data.fuelTotalCost != null && data.fuelTotalCost > 0) {
      await this.saveFuelReceipt(tId, date, {
        totalCost: data.fuelTotalCost,
        liters: data.fuelLiters,
        pricePerLiter: data.fuelPricePerLiter,
      });
      hasFuel = true;
    }

    const workFrom = data.workFrom ? normalizeTime(data.workFrom) : null;
    const workTo = data.workTo ? normalizeTime(data.workTo) : null;

    let hours: number | null = null;
    if (workFrom && workTo) {
      const res = calculateHours(workFrom, workTo);
      hours = res.hours;
      hoursError = res.error;
    }

    if (data.grossEarnings != null || data.distanceKm != null || workFrom || workTo) {
      hasDailyUpdate = true;
      await db
        .insert(dailyRecords)
        .values({
          telegramId: tId,
          date,
          grossEarnings: data.grossEarnings != null ? data.grossEarnings.toFixed(2) : null,
          distanceKm: data.distanceKm != null ? data.distanceKm.toFixed(2) : null,
          workFrom,
          workTo,
          workHours: hours !== null ? hours.toFixed(2) : null,
        })
        .onConflictDoUpdate({
          target: [dailyRecords.telegramId, dailyRecords.date],
          set: {
            ...(data.grossEarnings != null ? { grossEarnings: data.grossEarnings.toFixed(2) } : {}),
            ...(data.distanceKm != null ? { distanceKm: data.distanceKm.toFixed(2) } : {}),
            ...(workFrom ? { workFrom } : {}),
            ...(workTo ? { workTo } : {}),
            ...(workFrom && workTo ? { workHours: hours !== null ? hours.toFixed(2) : null } : {}),
          },
        });
    }

    return { date, hasDailyUpdate, hasTip, hasFuel, hoursError };
  }

  async handleVoiceDeletion(
    telegramId: string | number,
    target: 'LAST_TIP' | 'ALL_TIPS' | 'FUEL' | 'HOURS' | 'EARNINGS' | 'DISTANCE' | 'ALL_DAY',
    targetDateStr?: string | null
  ): Promise<{ success: boolean; message: string; date: string }> {
    const tId = String(telegramId);
    const date = this.resolveTargetDate(targetDateStr);
    const scope = and(eq(dailyRecords.telegramId, tId), eq(dailyRecords.date, date));

    switch (target) {
      case 'LAST_TIP': {
        const [lastTip] = await db
          .select()
          .from(cashTips)
          .where(and(eq(cashTips.telegramId, tId), eq(cashTips.date, date)))
          .orderBy(desc(cashTips.createdAt), desc(cashTips.id))
          .limit(1);

        if (!lastTip) return { success: false, message: `Brak napiwków do usunięcia z dnia ${date}.`, date };

        await db.delete(cashTips).where(eq(cashTips.id, lastTip.id));
        return {
          success: true,
          message: `Usunięto ostatni napiwek: ${parseFloat(lastTip.amount).toFixed(2)} zł z dnia ${date}.`,
          date,
        };
      }

      case 'ALL_TIPS': {
        const deleted = await db
          .delete(cashTips)
          .where(and(eq(cashTips.telegramId, tId), eq(cashTips.date, date)))
          .returning({ id: cashTips.id });
        if (!deleted.length) return { success: false, message: `Brak napiwków na ${date}.`, date };
        return { success: true, message: `Skasowano wszystkie napiwki (${deleted.length} szt.) z dnia ${date}.`, date };
      }

      case 'FUEL': {
        const deleted = await db
          .delete(fuelReceipts)
          .where(and(eq(fuelReceipts.telegramId, tId), eq(fuelReceipts.date, date)))
          .returning({ id: fuelReceipts.id });
        if (!deleted.length) return { success: false, message: `Brak wpisów paliwowych na ${date}.`, date };
        return { success: true, message: `Usunięto ${deleted.length} paragon(y) paliwowe z dnia ${date}.`, date };
      }

      case 'HOURS': {
        const updated = await db
          .update(dailyRecords)
          .set({ workFrom: null, workTo: null, workHours: null })
          .where(scope)
          .returning({ id: dailyRecords.id });
        return this.deletionResult(updated.length, `czas pracy na ${date}`, date);
      }

      case 'EARNINGS': {
        const updated = await db
          .update(dailyRecords)
          .set({ grossEarnings: null })
          .where(scope)
          .returning({ id: dailyRecords.id });
        return this.deletionResult(updated.length, `zarobek brutto na ${date}`, date);
      }

      case 'DISTANCE': {
        const updated = await db
          .update(dailyRecords)
          .set({ distanceKm: null })
          .where(scope)
          .returning({ id: dailyRecords.id });
        return this.deletionResult(updated.length, `dystans na ${date}`, date);
      }

      case 'ALL_DAY': {
        const removedRecords = await db.delete(dailyRecords).where(scope).returning({ id: dailyRecords.id });
        const removedTips = await db
          .delete(cashTips)
          .where(and(eq(cashTips.telegramId, tId), eq(cashTips.date, date)))
          .returning({ id: cashTips.id });
        const removedFuel = await db
          .delete(fuelReceipts)
          .where(and(eq(fuelReceipts.telegramId, tId), eq(fuelReceipts.date, date)))
          .returning({ id: fuelReceipts.id });

        const total = removedRecords.length + removedTips.length + removedFuel.length;
        if (total === 0) return { success: false, message: `Brak jakichkolwiek danych na ${date}.`, date };
        return {
          success: true,
          message: `Usunięto dzień ${date}: wpis dnia, ${removedTips.length} napiwk(ów), ${removedFuel.length} paragon(ów).`,
          date,
        };
      }

      default:
        return { success: false, message: 'Nie rozpoznano elementu do usunięcia.', date };
    }
  }

  /** Brak zaktualizowanych wierszy = nie bylo czego kasowac. Bez cichego "sukcesu". */
  private deletionResult(count: number, what: string, date: string) {
    return count > 0
      ? { success: true, message: `Wyczyszczono ${what}.`, date }
      : { success: false, message: `Brak wpisu, z którego można wyczyścić ${what}.`, date };
  }

  // --- Raporty --------------------------------------------------------------

  async getDailySummary(telegramId: string | number, date: string): Promise<DailySummary> {
    const tId = String(telegramId);

    const [record, tipsRow, fuelRow, txs] = await Promise.all([
      this.getDailyRecord(tId, date),
      db
        .select({ total: sql<string>`coalesce(sum(${cashTips.amount}), 0)` })
        .from(cashTips)
        .where(and(eq(cashTips.telegramId, tId), eq(cashTips.date, date)))
        .then((r) => r[0]),
      db
        .select({
          cost: sql<string>`coalesce(sum(${fuelReceipts.totalCost}), 0)`,
          liters: sql<string>`coalesce(sum(${fuelReceipts.liters}), 0)`,
          count: sql<number>`count(*)::int`,
        })
        .from(fuelReceipts)
        .where(and(eq(fuelReceipts.telegramId, tId), eq(fuelReceipts.date, date)))
        .then((r) => r[0]),
      db
        .select({ type: walletTransactions.type, amount: walletTransactions.amount })
        .from(walletTransactions)
        .where(and(eq(walletTransactions.telegramId, tId), eq(walletTransactions.date, date))),
    ]);

    // `pobranie` NIE wchodzi do rozliczenia dnia - aktualizuje wylacznie saldo (2.4).
    const walletPayouts = sumWalletPayouts(txs);

    const gross = num(record?.grossEarnings);
    const cashTipsTotal = round2(num(tipsRow?.total));
    const workHours = num(record?.workHours);

    const { netEarnings, totalNetto, doPrzelewu, hourlyRateNetto } = computeDailyTotals({
      grossEarnings: gross,
      cashTipsTotal,
      walletPayouts,
      workHours,
    });

    const fuelCost = round2(num(fuelRow?.cost));
    const fuelLiters = round2(num(fuelRow?.liters));

    return {
      date,
      grossEarnings: gross,
      netEarnings,
      cashTipsTotal,
      totalNetto,
      walletPayouts,
      doPrzelewu,
      workFrom: record?.workFrom ?? null,
      workTo: record?.workTo ?? null,
      workHours,
      hourlyRateNetto,
      fuelCost,
      fuelLiters,
      fuelPricePerLiter: fuelLiters > 0 ? round2(fuelCost / fuelLiters) : null,
      fuelReceiptCount: fuelRow?.count ?? 0,
      distanceKm: numOrNull(record?.distanceKm),
    };
  }

  async getPeriodSummary(telegramId: string | number, startDate: string, endDate: string): Promise<PeriodSummary> {
    const tId = String(telegramId);

    const [records, tipsRow, fuelRow, txs] = await Promise.all([
      db
        .select()
        .from(dailyRecords)
        .where(
          and(eq(dailyRecords.telegramId, tId), gte(dailyRecords.date, startDate), lte(dailyRecords.date, endDate))
        ),
      db
        .select({ total: sql<string>`coalesce(sum(${cashTips.amount}), 0)` })
        .from(cashTips)
        .where(and(eq(cashTips.telegramId, tId), gte(cashTips.date, startDate), lte(cashTips.date, endDate)))
        .then((r) => r[0]),
      db
        .select({
          cost: sql<string>`coalesce(sum(${fuelReceipts.totalCost}), 0)`,
          liters: sql<string>`coalesce(sum(${fuelReceipts.liters}), 0)`,
        })
        .from(fuelReceipts)
        .where(
          and(eq(fuelReceipts.telegramId, tId), gte(fuelReceipts.date, startDate), lte(fuelReceipts.date, endDate))
        )
        .then((r) => r[0]),
      db
        .select({ type: walletTransactions.type, amount: walletTransactions.amount })
        .from(walletTransactions)
        .where(
          and(
            eq(walletTransactions.telegramId, tId),
            gte(walletTransactions.date, startDate),
            lte(walletTransactions.date, endDate)
          )
        ),
    ]);

    let totalGross = 0;
    let totalWorkHours = 0;
    let totalDistanceKm = 0;

    for (const r of records) {
      totalGross += num(r.grossEarnings);
      totalWorkHours += num(r.workHours);
      totalDistanceKm += num(r.distanceKm);
    }

    const totalWalletPayouts = sumWalletPayouts(txs);
    const totalCashTips = round2(num(tipsRow?.total));

    const totals = computeDailyTotals({
      grossEarnings: totalGross,
      cashTipsTotal: totalCashTips,
      walletPayouts: totalWalletPayouts,
      workHours: totalWorkHours,
    });

    const totalNettoEarnings = totals.netEarnings;
    const grandTotalNetto = totals.totalNetto;
    const totalFuelCost = round2(num(fuelRow?.cost));
    const totalFuelLiters = round2(num(fuelRow?.liters));

    return {
      startDate,
      endDate,
      totalGross: round2(totalGross),
      totalNettoEarnings,
      totalCashTips,
      grandTotalNetto,
      totalWalletPayouts,
      totalDoPrzelewu: totals.doPrzelewu,
      totalWorkHours: round2(totalWorkHours),
      avgHourlyRateNetto: totals.hourlyRateNetto,
      totalFuelCost,
      totalFuelLiters,
      avgPricePerLiter: totalFuelLiters > 0 ? Math.round((totalFuelCost / totalFuelLiters) * 1000) / 1000 : null,
      totalDistanceKm: round2(totalDistanceKm),
    };
  }

  async getCourseOfferStats(telegramId: string | number, date: string): Promise<CourseOfferStats> {
    const tId = String(telegramId);
    const offers = await db
      .select()
      .from(courseOffers)
      .where(and(eq(courseOffers.telegramId, tId), eq(courseOffers.date, date)));

    let profitable = 0;
    let accepted = 0;
    let rejected = 0;
    let pending = 0;
    let sumRates = 0;
    let totalGross = 0;
    let totalNet = 0;
    let totalDistanceKm = 0;

    // FIX (5.5): zamiast sentinela 999 uzywamy null - przy stawce > 999 zl/km
    // albo ujemnej stary kod pokazywal bzdury.
    let bestNetRate: number | null = null;
    let worstNetRate: number | null = null;

    for (const o of offers) {
      if (o.isProfitable) profitable++;
      if (o.status === 'ACCEPTED') accepted++;
      else if (o.status === 'REJECTED') rejected++;
      else pending++;

      const rate = parseFloat(o.netRatePerKm);
      sumRates += rate;
      if (bestNetRate === null || rate > bestNetRate) bestNetRate = rate;
      if (worstNetRate === null || rate < worstNetRate) worstNetRate = rate;

      totalGross += parseFloat(o.grossAmount);
      totalNet += parseFloat(o.netAmount);
      totalDistanceKm += parseFloat(o.distanceTotalKm);
    }

    return {
      date,
      totalOffers: offers.length,
      profitable,
      unprofitable: offers.length - profitable,
      accepted,
      rejected,
      pending,
      // FIX (5.4): dwie rozne metryki, obie pokazywane w /statystyki.
      avgNetRatePerKm: offers.length > 0 ? round2(sumRates / offers.length) : null,
      weightedNetRatePerKm: totalDistanceKm > 0 ? round2(totalNet / totalDistanceKm) : null,
      bestNetRate,
      worstNetRate,
      totalGross: round2(totalGross),
      totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
    };
  }

  // --- Cele -----------------------------------------------------------------

  /**
   * FIX (2.10): cele tygodniowe kluczowane ROKIEM ISO.
   * Przy roku kalendarzowym cel zapisany 30 grudnia (tydzien ISO 1 roku
   * nastepnego) trafial pod inny klucz niz odczyt z 2 stycznia.
   */
  private periodKey(periodType: 'MONTHLY' | 'WEEKLY', date: string): { year: number; periodValue: number } {
    if (periodType === 'WEEKLY') {
      const { year, week } = isoWeek(date);
      return { year, periodValue: week };
    }
    const { year, month } = splitDate(date);
    return { year, periodValue: month };
  }

  async setEarningTarget(
    telegramId: string | number,
    periodType: 'MONTHLY' | 'WEEKLY',
    targetAmount: number
  ): Promise<{ year: number; periodValue: number; targetAmount: number }> {
    const tId = String(telegramId);
    const { year, periodValue } = this.periodKey(periodType, this.getEffectiveDate());

    await db
      .insert(earningTargets)
      .values({ telegramId: tId, periodType, targetAmount: targetAmount.toFixed(2), year, periodValue })
      .onConflictDoUpdate({
        target: [earningTargets.telegramId, earningTargets.periodType, earningTargets.year, earningTargets.periodValue],
        set: { targetAmount: targetAmount.toFixed(2) },
      });

    return { year, periodValue, targetAmount };
  }

  async getTargetProgress(
    telegramId: string | number,
    periodType: 'MONTHLY' | 'WEEKLY'
  ): Promise<TargetProgress | null> {
    const tId = String(telegramId);
    const today = this.getEffectiveDate();
    const { year, periodValue } = this.periodKey(periodType, today);

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
    let startDate: string;
    let daysRemaining: number;

    if (periodType === 'MONTHLY') {
      const { day } = splitDate(today);
      startDate = `${year}-${String(periodValue).padStart(2, '0')}-01`;
      daysRemaining = Math.max(1, daysInMonth(year, periodValue) - day + 1);
    } else {
      startDate = weekRangeFor(year, periodValue).startDate;
      daysRemaining = Math.max(1, 7 - isoDayOfWeek(today) + 1);
    }

    const summary = await this.getPeriodSummary(tId, startDate, today);
    const currentNetto = summary.grandTotalNetto;
    const remainingNetto = round2(targetAmount - currentNetto);
    const progressPercent = targetAmount > 0 ? Math.round((currentNetto / targetAmount) * 1000) / 10 : 0;

    const usedFallbackRate = summary.avgHourlyRateNetto <= 0;
    const avgHourlyRate = usedFallbackRate ? CFG.FALLBACK_HOURLY_RATE_NETTO : summary.avgHourlyRateNetto;

    const estimatedHoursRemaining = remainingNetto > 0 ? Math.round((remainingNetto / avgHourlyRate) * 10) / 10 : 0;

    return {
      periodType,
      targetAmount,
      currentNetto,
      remainingNetto: Math.max(0, remainingNetto),
      progressPercent: Math.min(100, Math.max(0, progressPercent)),
      daysRemaining,
      dailyRequiredNetto: remainingNetto > 0 ? round2(remainingNetto / daysRemaining) : 0,
      avgHourlyRate,
      usedFallbackRate,
      estimatedHoursRemaining,
      hoursPerDayRequired: estimatedHoursRemaining > 0 ? Math.round((estimatedHoursRemaining / daysRemaining) * 10) / 10 : 0,
      isCompleted: currentNetto >= targetAmount,
    };
  }
}

export const financeService = new FinanceService();
