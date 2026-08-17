import { describe, expect, it } from 'vitest';
import {
  computeDailyTotals,
  computeOfferRate,
  computeOfferStats,
  partitionNewTransactions,
  sumWalletPayouts,
  walletBalanceFrom,
  walletKey,
} from './finance.calc.js';

describe('computeDailyTotals (FIX 2.4)', () => {
  it('napiwki wchodzą do zarobku, ale NIE do przelewu', () => {
    const totals = computeDailyTotals({
      grossEarnings: 400,
      cashTipsTotal: 50,
      walletPayouts: 0,
      workHours: 8,
    });

    expect(totals.netEarnings).toBe(325.6); // 400 × 0.814
    expect(totals.totalNetto).toBe(375.6); // + 50 napiwków
    expect(totals.doPrzelewu).toBe(325.6); // napiwki są gotówkowe
  });

  it('wypłaty z portfela pomniejszają to, co jeszcze przyjdzie', () => {
    const totals = computeDailyTotals({
      grossEarnings: 400,
      cashTipsTotal: 0,
      walletPayouts: 100,
      workHours: 0,
    });
    expect(totals.doPrzelewu).toBe(225.6);
  });

  it('ujemne do przelewu jest widoczne, nie ucinane do zera', () => {
    const totals = computeDailyTotals({
      grossEarnings: 100,
      cashTipsTotal: 0,
      walletPayouts: 250,
      workHours: 0,
    });
    expect(totals.doPrzelewu).toBeLessThan(0);
    expect(totals.doPrzelewu).toBe(-168.6);
  });

  it('stawka godzinowa liczy się z całego zarobku netto', () => {
    const totals = computeDailyTotals({
      grossEarnings: 400,
      cashTipsTotal: 50,
      walletPayouts: 0,
      workHours: 8,
    });
    expect(totals.hourlyRateNetto).toBe(46.95);
  });

  it('zero godzin nie wywala dzielenia', () => {
    expect(computeDailyTotals({ grossEarnings: 0, cashTipsTotal: 0, walletPayouts: 0, workHours: 0 })).toEqual({
      netEarnings: 0,
      totalNetto: 0,
      doPrzelewu: 0,
      hourlyRateNetto: 0,
    });
  });
});

describe('saldo portfela (FIX 2.2)', () => {
  const txs = [
    { type: 'pobranie', amount: '63.34' },
    { type: 'pobranie', amount: '35.99' },
    { type: 'wyplata', amount: '-174.89' },
    { type: 'wyplata_gotowka', amount: '-100.00' },
    { type: 'platnosc_punkt', amount: '-255.69' },
    { type: 'korekta', amount: '-2.78' },
  ];

  it('saldo to suma kwot ze znakiem', () => {
    expect(walletBalanceFrom(txs)).toBe(-434.03);
  });

  it('wypłaty to tylko wyplata i wyplata_gotowka', () => {
    // platnosc_punkt i pobranie nie wchodzą do rozliczenia dnia.
    expect(sumWalletPayouts(txs)).toBe(274.89);
  });
});

describe('deduplikacja transakcji (FIX 2.5 / 2.6)', () => {
  const tx = (over: Partial<Parameters<typeof walletKey>[0]> = {}) => ({
    date: '2026-08-11',
    time: '15:50',
    type: 'pobranie',
    amount: 63.34,
    externalId: '101735350998',
    ...over,
  });

  it('rozpoznaje transakcję już zapisaną w bazie', () => {
    const existing = new Set([walletKey(tx())]);
    const result = partitionNewTransactions([tx()], existing);
    expect(result.newItems).toHaveLength(0);
    expect(result.duplicates).toBe(1);
  });

  it('transakcje bez externalId też są deduplikowane', () => {
    // Wcześniej pusty externalId był NULL-em, a NULL != NULL w Postgresie,
    // więc unikalny indeks w ogóle nie blokował duplikatów.
    const noId = tx({ externalId: '' });
    const existing = new Set([walletKey(noId)]);
    expect(partitionNewTransactions([noId], existing).duplicates).toBe(1);
  });

  it('wyłapuje powtórzenia w obrębie jednego zrzutu', () => {
    const result = partitionNewTransactions([tx(), tx(), tx({ amount: 10 })], new Set());
    expect(result.newItems).toHaveLength(2);
    expect(result.duplicates).toBe(1);
  });

  it('różna kwota to inna transakcja', () => {
    const existing = new Set([walletKey(tx())]);
    const result = partitionNewTransactions([tx({ amount: 63.35 })], existing);
    expect(result.newItems).toHaveLength(1);
  });

  it('delta salda liczy tylko nowe pozycje', () => {
    const existing = new Set([walletKey(tx())]);
    const result = partitionNewTransactions([tx(), tx({ amount: -50, externalId: 'x' })], existing);
    expect(result.totalDelta).toBe(-50);
  });
});

describe('computeOfferRate (FIX 2.3)', () => {
  it('stawka liczona z całej trasy, nie z samego dojazdu', () => {
    // 20 zł brutto, dojazd 2 km + dostawa 6 km = 8 km.
    const rate = computeOfferRate({ grossAmount: 20, totalKm: 8 });
    expect(rate.netAmount).toBe(16.28);
    expect(rate.netRatePerKm).toBe(2.04);
    expect(rate.isProfitable).toBe(true);
  });

  it('licząc tylko dojazd stawka byłaby zawyżona czterokrotnie', () => {
    const onlyPickup = computeOfferRate({ grossAmount: 20, totalKm: 2 });
    expect(onlyPickup.netRatePerKm).toBe(8.14);
  });

  it('zerowy dystans nie jest opłacalnym kursem', () => {
    const rate = computeOfferRate({ grossAmount: 20, totalKm: 0 });
    expect(rate.netRatePerKm).toBe(0);
    expect(rate.isProfitable).toBe(false);
  });

  it('kurs poniżej progu jest odrzucany', () => {
    expect(computeOfferRate({ grossAmount: 10, totalKm: 8 }).isProfitable).toBe(false);
  });
});

/**
 * Statystyki ofert.
 *
 * Sedno tych testów to jedna oferta bez dystansu. Realny przypadek z §8f:
 * ekran oferty nie pokazuje adresu klienta, `isSpecificAddress()` odmawia
 * geokodowania, `rateBasis` kończy jako `'NONE'`, a `netRatePerKm` wynosi 0.
 * Zero nie znaczy „kurs za darmo", tylko „nie ma z czego liczyć" — i właśnie
 * ta różnica ginęła w średniej.
 */

const oferta = (over: Partial<Parameters<typeof computeOfferStats>[0][number]> = {}) => ({
  isProfitable: true,
  status: 'PENDING',
  netRatePerKm: 3,
  grossAmount: 24.57,
  netAmount: 20,
  distanceTotalKm: 6.67,
  ...over,
});

describe('computeOfferStats', () => {
  it('brak ofert nie daje NaN, tylko null', () => {
    const s = computeOfferStats([]);
    expect(s.totalOffers).toBe(0);
    expect(s.ratedOffers).toBe(0);
    expect(s.avgNetRatePerKm).toBeNull();
    expect(s.weightedNetRatePerKm).toBeNull();
    expect(s.bestNetRate).toBeNull();
    expect(s.worstNetRate).toBeNull();
  });

  it('oferta bez dystansu NIE zaniża średniej ani nie zostaje „najgorszą"', () => {
    const s = computeOfferStats([
      oferta({ netRatePerKm: 3, distanceTotalKm: 6 }),
      oferta({ netRatePerKm: 2, distanceTotalKm: 10 }),
      oferta({ netRatePerKm: 0, distanceTotalKm: 0, isProfitable: false }),
    ]);

    // Średnia z DWÓCH, nie z trzech: (3 + 2) / 2.
    expect(s.avgNetRatePerKm).toBe(2.5);
    expect(s.worstNetRate).toBe(2);
    expect(s.bestNetRate).toBe(3);
    expect(s.ratedOffers).toBe(2);
  });

  it('ale ta oferta nadal się liczy — była sprawdzona i ma prawdziwą kwotę', () => {
    const s = computeOfferStats([
      oferta({ grossAmount: 10, netAmount: 8.14, distanceTotalKm: 4 }),
      oferta({ grossAmount: 22.04, netAmount: 17.94, distanceTotalKm: 0, netRatePerKm: 0, isProfitable: false }),
    ]);

    expect(s.totalOffers).toBe(2);
    expect(s.ratedOffers).toBe(1);
    expect(s.totalGross).toBe(32.04);
    expect(s.unprofitable).toBe(1);
  });

  it('ujemna stawka nie jest „najlepszą" — sentinel 999 dawał tu bzdury (FIX 5.5)', () => {
    const s = computeOfferStats([
      oferta({ netRatePerKm: -1, distanceTotalKm: 5 }),
      oferta({ netRatePerKm: 1200, distanceTotalKm: 0.01 }),
    ]);

    // Ujemna wypada razem z zerem: `netRatePerKm > 0` odsiewa oba.
    expect(s.ratedOffers).toBe(1);
    expect(s.bestNetRate).toBe(1200);
    expect(s.worstNetRate).toBe(1200);
  });

  it('średnia ważona to co innego niż arytmetyczna', () => {
    const s = computeOfferStats([
      oferta({ netAmount: 10, distanceTotalKm: 2, netRatePerKm: 5 }),
      oferta({ netAmount: 10, distanceTotalKm: 10, netRatePerKm: 1 }),
    ]);

    // Arytmetyczna: (5 + 1) / 2 = 3 — „jakie oferty przychodzą".
    expect(s.avgNetRatePerKm).toBe(3);
    // Ważona: 20 zł / 12 km = 1,67 — „ile realnie wychodzi na km".
    expect(s.weightedNetRatePerKm).toBe(1.67);
  });

  it('statusy: wszystko, co nie jest ACCEPTED ani REJECTED, jest „bez decyzji"', () => {
    const s = computeOfferStats([
      oferta({ status: 'ACCEPTED' }),
      oferta({ status: 'REJECTED' }),
      oferta({ status: 'PENDING' }),
      oferta({ status: 'COS_NOWEGO' }),
    ]);

    expect(s.accepted).toBe(1);
    expect(s.rejected).toBe(1);
    expect(s.pending).toBe(2);
  });

  it('daje te same liczby co `policzOferty` w aplikacji — to był cel tej zmiany', () => {
    // Ten sam zestaw danych po obu stronach musi dawać ten sam wynik,
    // inaczej `/statystyki` i zakładka Oferty znowu się rozjadą.
    const s = computeOfferStats([
      oferta({ netRatePerKm: 2.81, distanceTotalKm: 6.38, netAmount: 17.94, grossAmount: 22.04 }),
      oferta({ netRatePerKm: 0, distanceTotalKm: 0, netAmount: 8.14, grossAmount: 10, isProfitable: false }),
    ]);

    expect(s.avgNetRatePerKm).toBe(2.81);
    expect(s.ratedOffers).toBe(1);
    expect(s.totalOffers).toBe(2);
  });
});
