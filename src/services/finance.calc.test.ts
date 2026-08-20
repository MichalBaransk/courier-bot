import { describe, expect, it } from 'vitest';
import {
  computeDailyTotals,
  computeOfferRate,
  computeOfferStats,
  partitionNewTransactions,
  sumWalletPayouts,
  walletBalanceFrom,
  walletKey,
  zakresSesji,
  nakladajaSie,
  dlugoscSesjiH,
  sumaGodzinDoby,
  walidujSesje,
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

describe('zakresSesji — zmiana na osi minut', () => {
  it('zwykła zmiana w obrębie doby', () => {
    expect(zakresSesji({ od: '10:00', do: '14:00' })).toEqual({ start: 600, koniec: 840 });
  });

  it('przejście przez północ przedłuża oś, nie dzieli zmiany na dwie doby', () => {
    expect(zakresSesji({ od: '23:50', do: '02:10' })).toEqual({ start: 1430, koniec: 1570 });
  });

  it('równe godziny to zmiana ZEROWEJ długości, nie doba', () => {
    // Regresja z 19.08: serwer liczył tu 24 h, aplikacja 0. Ta rozbieżność
    // wychodziła przy dwukrotnym dotknięciu przycisku w tej samej minucie.
    expect(zakresSesji({ od: '10:00', do: '10:00' })).toEqual({ start: 600, koniec: 600 });
  });

  it('zmiana trwająca zajmuje oś aż do końca', () => {
    expect(zakresSesji({ od: '17:30', do: null })).toEqual({ start: 1050, koniec: Infinity });
  });

  it('przesunięcie o dobę wstecz układa wczorajszą zmianę na tej samej osi', () => {
    expect(zakresSesji({ od: '23:00', do: '02:00' }, -1)).toEqual({ start: -60, koniec: 120 });
  });

  it('zły format to null, nie zgadywanie', () => {
    expect(zakresSesji({ od: 'abc', do: '14:00' })).toBeNull();
    expect(zakresSesji({ od: '10:00', do: '25:00' })).toBeNull();
  });
});

describe('nakladajaSie', () => {
  it('styk NIE jest nakładaniem — 14:00 kończy jedną i zaczyna drugą', () => {
    const a = zakresSesji({ od: '10:00', do: '14:00' })!;
    const b = zakresSesji({ od: '14:00', do: '18:00' })!;
    expect(nakladajaSie(a, b)).toBe(false);
  });

  it('wspólna godzina to nakładanie', () => {
    const a = zakresSesji({ od: '10:00', do: '14:00' })!;
    const b = zakresSesji({ od: '13:00', do: '18:00' })!;
    expect(nakladajaSie(a, b)).toBe(true);
  });

  it('zmiana zawarta w drugiej', () => {
    const a = zakresSesji({ od: '10:00', do: '20:00' })!;
    const b = zakresSesji({ od: '12:00', do: '13:00' })!;
    expect(nakladajaSie(a, b)).toBe(true);
  });
});

describe('dlugoscSesjiH i sumaGodzinDoby', () => {
  it('zmiana przez północ liczy się poprawnie', () => {
    expect(dlugoscSesjiH({ od: '22:00', do: '02:00' })).toBe(4);
  });

  it('TRWAJĄCA zmiana to 0 h, a nie „do teraz"', () => {
    expect(dlugoscSesjiH({ od: '17:30', do: null })).toBe(0);
  });

  it('zmiana spoza limitu 2.9 wnosi 0 zamiast fałszywej liczby', () => {
    expect(dlugoscSesjiH({ od: '10:00', do: '09:00' })).toBe(0);
  });

  it('dwie zmiany w dobie sumują się — to jest cel całej tabeli', () => {
    const suma = sumaGodzinDoby([
      { od: '10:00', do: '14:00' },
      { od: '17:30', do: '23:30' },
    ]);
    expect(suma).toBe(10);
  });

  it('suma z trwającą zmianą liczy tylko zamknięte', () => {
    expect(sumaGodzinDoby([{ od: '10:00', do: '14:00' }, { od: '17:30', do: null }])).toBe(4);
  });

  it('pusta doba to zero, nie NaN', () => {
    expect(sumaGodzinDoby([])).toBe(0);
  });
});

describe('walidujSesje', () => {
  it('pierwsza zmiana w pustej dobie przechodzi', () => {
    expect(walidujSesje({ istniejace: [], nowa: { od: '10:00', do: '14:00' } })).toEqual({ ok: true });
  });

  it('druga zmiana po pierwszej przechodzi — to jest sedno work_sessions', () => {
    const wynik = walidujSesje({
      istniejace: [{ id: 1, od: '10:00', do: '14:00' }],
      nowa: { od: '17:30', do: '23:30' },
    });
    expect(wynik).toEqual({ ok: true });
  });

  it('zmiana nachodząca na istniejącą jest odrzucana z podaniem tej drugiej', () => {
    const wynik = walidujSesje({
      istniejace: [{ id: 1, od: '10:00', do: '14:00' }],
      nowa: { od: '13:00', do: '18:00' },
    });
    expect(wynik.ok).toBe(false);
    if (!wynik.ok) expect(wynik.komunikat).toContain('10:00–14:00');
  });

  it('trwająca zmiana blokuje dopisanie PÓŹNIEJSZEJ', () => {
    const wynik = walidujSesje({
      istniejace: [{ id: 1, od: '17:30', do: null }],
      nowa: { od: '19:00', do: '20:00' },
    });
    expect(wynik.ok).toBe(false);
    if (!wynik.ok) expect(wynik.komunikat).toContain('jeszcze trwa');
  });

  it('trwająca zmiana NIE blokuje dopisania wcześniejszej, o której zapomniałem', () => {
    const wynik = walidujSesje({
      istniejace: [{ id: 1, od: '17:30', do: null }],
      nowa: { od: '08:00', do: '12:00' },
    });
    expect(wynik).toEqual({ ok: true });
  });

  it('poprawka zmiany nie koliduje sama ze sobą', () => {
    const wynik = walidujSesje({
      istniejace: [{ id: 7, od: '10:00', do: '14:00' }],
      nowa: { id: 7, od: '10:15', do: '14:30' },
    });
    expect(wynik).toEqual({ ok: true });
  });

  it('zmiana krótsza niż 15 minut PRZECHODZI — dolnego progu nie ma', () => {
    expect(walidujSesje({ istniejace: [], nowa: { od: '10:00', do: '10:10' } })).toEqual({
      ok: true,
    });
  });

  it('zmiana zerowa też przechodzi i wnosi 0 h do sumy', () => {
    expect(walidujSesje({ istniejace: [], nowa: { od: '10:00', do: '10:00' } })).toEqual({
      ok: true,
    });
    expect(dlugoscSesjiH({ od: '10:00', do: '10:00' })).toBe(0);
  });

  it('krótka zmiana wnosi do sumy swoją PRAWDZIWĄ długość', () => {
    // Nie zero. Przed 20.08 `calculateHours` zwracał tu `null`, a `?? 0`
    // zamieniało to w ciche zero godzin przy niezerowym zarobku.
    expect(dlugoscSesjiH({ od: '10:00', do: '10:10' })).toBeCloseTo(0.17, 2);
  });

  it('pojedyncza zmiana dłuższa niż 16 h odpada', () => {
    const wynik = walidujSesje({ istniejace: [], nowa: { od: '06:00', do: '23:30' } });
    expect(wynik.ok).toBe(false);
    if (!wynik.ok) expect(wynik.komunikat).toContain('limit 16 h');
  });

  it('SUMA doby powyżej 16 h odpada, choć każda zmiana z osobna jest w porządku', () => {
    // To jest kontrola, której nie da się zastąpić limitem pojedynczej zmiany.
    const wynik = walidujSesje({
      istniejace: [
        { id: 1, od: '00:00', do: '06:00' },
        { id: 2, od: '06:00', do: '12:00' },
      ],
      nowa: { od: '12:00', do: '18:30' },
    });
    expect(wynik.ok).toBe(false);
    if (!wynik.ok) expect(wynik.komunikat).toContain('18.50 h w jednej dobie');
  });

  it('dokładnie 16 h w dobie jeszcze przechodzi', () => {
    const wynik = walidujSesje({
      istniejace: [{ id: 1, od: '00:00', do: '08:00' }],
      nowa: { od: '08:00', do: '16:00' },
    });
    expect(wynik).toEqual({ ok: true });
  });

  it('zmiana nachodząca na WCZORAJSZĄ, która przeszła przez północ', () => {
    const wynik = walidujSesje({
      istniejace: [],
      nowa: { od: '01:00', do: '05:00' },
      zPoprzedniejDoby: { id: 9, od: '23:00', do: '02:00' },
    });
    expect(wynik.ok).toBe(false);
    if (!wynik.ok) expect(wynik.komunikat).toContain('wczorajszą');
  });

  it('wczorajsza zmiana kończąca się przed północą niczego nie blokuje', () => {
    const wynik = walidujSesje({
      istniejace: [],
      nowa: { od: '01:00', do: '05:00' },
      zPoprzedniejDoby: { id: 9, od: '16:00', do: '23:00' },
    });
    expect(wynik).toEqual({ ok: true });
  });

  it('zły format godziny zatrzymuje walidację na pierwszym kroku', () => {
    const wynik = walidujSesje({ istniejace: [], nowa: { od: '10:00', do: 'ćwierć po' } });
    expect(wynik.ok).toBe(false);
    if (!wynik.ok) expect(wynik.komunikat).toContain('GG:MM');
  });
});
