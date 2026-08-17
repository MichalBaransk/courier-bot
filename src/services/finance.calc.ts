import { CFG } from '../config.js';

/**
 * Czysta arytmetyka rozliczen — bez bazy, w calosci testowalna.
 * `finance.service.ts` tylko dostarcza tu dane z Postgresa.
 */

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export const WALLET_PAYOUT_TYPES = ['wyplata', 'wyplata_gotowka'] as const;

export interface DailyTotalsInput {
  grossEarnings: number;
  cashTipsTotal: number;
  walletPayouts: number;
  workHours: number;
}

export interface DailyTotals {
  netEarnings: number;
  totalNetto: number;
  doPrzelewu: number;
  hourlyRateNetto: number;
}

/**
 * Model rozliczenia (2.4) — zapisany wprost, zeby nie trzeba go bylo
 * odtwarzac z jednego dlugiego wyrazenia:
 *
 *   netEarnings  = brutto ze zlecen × NETTO_FACTOR      (trafi na konto)
 *   cashTips     = napiwki gotowkowe                    (juz w kieszeni)
 *   totalNetto   = netEarnings + cashTips               (ile kurier zarobil)
 *   walletPayouts= wyplata + wyplata_gotowka            (juz wyszlo z portfela)
 *   doPrzelewu   = netEarnings - walletPayouts          (co jeszcze przyjdzie)
 *
 * Napiwki NIE wchodza do `doPrzelewu`, bo sa gotowkowe i nikt ich nie przeleje.
 * Stary wzor dodawal je do `totalNetto` i zaraz odejmowal — wychodzilo to samo,
 * ale nie dalo sie tego przeczytac.
 *
 * `pobranie` i `platnosc_punkt` nie wystepuja tutaj w ogole: pierwsze tylko
 * podnosi saldo portfela, drugie tylko je obniza.
 *
 * Brak `Math.max(0, ...)` — ujemny wynik ma byc widoczny.
 */
export function computeDailyTotals(input: DailyTotalsInput): DailyTotals {
  const netEarnings = round2(input.grossEarnings * CFG.NETTO_FACTOR);
  const totalNetto = round2(netEarnings + input.cashTipsTotal);
  const doPrzelewu = round2(netEarnings - input.walletPayouts);

  return {
    netEarnings,
    totalNetto,
    doPrzelewu,
    hourlyRateNetto: input.workHours > 0 ? round2(totalNetto / input.workHours) : 0,
  };
}

/** Suma wyplat (gotowkowych i przelewem) z listy transakcji portfela. */
export function sumWalletPayouts(txs: Array<{ type: string; amount: string | number }>): number {
  let total = 0;
  for (const tx of txs) {
    if ((WALLET_PAYOUT_TYPES as readonly string[]).includes(tx.type)) {
      total += Math.abs(typeof tx.amount === 'string' ? parseFloat(tx.amount) : tx.amount);
    }
  }
  return round2(total);
}

/**
 * Saldo portfela = suma kwot ZE ZNAKIEM (2.2).
 * pobranie (+), wyplata (-), wyplata_gotowka (-), platnosc_punkt (-), korekta (+/-).
 */
export function walletBalanceFrom(txs: Array<{ amount: string | number }>): number {
  let total = 0;
  for (const tx of txs) {
    total += typeof tx.amount === 'string' ? parseFloat(tx.amount) : tx.amount;
  }
  return round2(total);
}

export interface WalletKeyParts {
  date: string;
  time: string;
  type: string;
  amount: number;
  externalId: string;
}

/**
 * Klucz deduplikacji (2.5).
 * MUSI zawierac dokladnie te kolumny co unikalny indeks `wallet_tx_dedup_idx`,
 * inaczej podglad importu i baza maja dwie rozne definicje "tej samej transakcji".
 */
export function walletKey(t: WalletKeyParts): string {
  return [t.date, t.time, t.type, t.amount.toFixed(2), t.externalId].join('|');
}

export interface PartitionResult<T> {
  newItems: T[];
  duplicates: number;
  totalDelta: number;
}

/**
 * Dzieli transakcje ze zrzutu na nowe i duplikaty.
 * Wykrywa takze powtorzenia w obrebie samego zrzutu.
 */
export function partitionNewTransactions<T extends WalletKeyParts>(
  incoming: T[],
  existingKeys: ReadonlySet<string>
): PartitionResult<T> {
  const seen = new Set<string>();
  const newItems: T[] = [];
  let duplicates = 0;
  let totalDelta = 0;

  for (const item of incoming) {
    const key = walletKey(item);
    if (existingKeys.has(key) || seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    newItems.push(item);
    totalDelta += item.amount;
  }

  return { newItems, duplicates, totalDelta: round2(totalDelta) };
}

export interface OfferRateInput {
  grossAmount: number;
  totalKm: number;
}

export interface OfferRate {
  netAmount: number;
  netRatePerKm: number;
  isProfitable: boolean;
}

/** Stawka kursu liczona z CALEJ trasy (dojazd + dostawa) — patrz 2.3. */
export function computeOfferRate(input: OfferRateInput): OfferRate {
  const netAmount = round2(input.grossAmount * CFG.NETTO_FACTOR);
  const netRatePerKm = input.totalKm > 0 ? round2(netAmount / input.totalKm) : 0;
  return {
    netAmount,
    netRatePerKm,
    isProfitable: input.totalKm > 0 && netRatePerKm >= CFG.MIN_STAWKA_NETTO_KM,
  };
}

export interface OfferStatsInput {
  isProfitable: boolean;
  status: string;
  netRatePerKm: number;
  grossAmount: number;
  netAmount: number;
  distanceTotalKm: number;
}

export interface OfferStats {
  totalOffers: number;
  profitable: number;
  unprofitable: number;
  accepted: number;
  rejected: number;
  pending: number;
  /** Ile ofert weszlo do sredniej i do skrajnych wartosci. */
  ratedOffers: number;
  avgNetRatePerKm: number | null;
  weightedNetRatePerKm: number | null;
  bestNetRate: number | null;
  worstNetRate: number | null;
  totalGross: number;
  totalNet: number;
  totalDistanceKm: number;
}

/**
 * Statystyki ofert z jednego dnia.
 *
 * OFERTY BEZ DYSTANSU SA POMIJANE w sredniej i w skrajnych wartosciach.
 *
 * Powod jest ten sam co w 8f: gdy ekran oferty nie pokazuje adresu klienta,
 * `isSpecificAddress()` slusznie odmawia geokodowania, `rateBasis` konczy jako
 * `'NONE'`, a `netRatePerKm` wynosi 0 — nie dlatego, ze kurs byl darmowy, tylko
 * dlatego, ze nie ma z czego liczyc. Wliczenie takiego zera ustawialo
 * "najgorsza stawke" na 0,00 zl/km i cicho zanizalo srednia.
 *
 * Do LICZNIKOW i do SUM te oferty nadal wchodza — zostaly sprawdzone, a ich
 * kwota brutto jest prawdziwa. `ratedOffers` mowi, ile z nich mialo dystans,
 * zeby roznica miedzy "sprawdzonych 7" a "srednia z 5" nie byla niewidoczna.
 *
 * Ta funkcja jest odpowiednikiem `policzOferty` z aplikacji mobilnej
 * (`src/statystykiOfert.ts`). Obie musza dawac te same liczby — wczesniej
 * dawaly rozne i to byl blad serwera, nie aplikacji.
 */
export function computeOfferStats(offers: readonly OfferStatsInput[]): OfferStats {
  let profitable = 0;
  let accepted = 0;
  let rejected = 0;
  let pending = 0;
  let sumRates = 0;
  let ratedOffers = 0;
  let totalGross = 0;
  let totalNet = 0;
  let totalDistanceKm = 0;

  // FIX (5.5): zamiast sentinela 999 uzywamy null — przy stawce > 999 zl/km
  // albo ujemnej stary kod pokazywal bzdury.
  let bestNetRate: number | null = null;
  let worstNetRate: number | null = null;

  for (const o of offers) {
    if (o.isProfitable) profitable++;
    if (o.status === 'ACCEPTED') accepted++;
    else if (o.status === 'REJECTED') rejected++;
    else pending++;

    totalGross += o.grossAmount;
    totalNet += o.netAmount;
    totalDistanceKm += o.distanceTotalKm;

    if (o.distanceTotalKm > 0 && o.netRatePerKm > 0) {
      sumRates += o.netRatePerKm;
      ratedOffers++;
      if (bestNetRate === null || o.netRatePerKm > bestNetRate) bestNetRate = o.netRatePerKm;
      if (worstNetRate === null || o.netRatePerKm < worstNetRate) worstNetRate = o.netRatePerKm;
    }
  }

  return {
    totalOffers: offers.length,
    profitable,
    unprofitable: offers.length - profitable,
    accepted,
    rejected,
    pending,
    ratedOffers,
    // FIX (5.4): dwie rozne metryki, obie pokazywane w /statystyki.
    avgNetRatePerKm: ratedOffers > 0 ? round2(sumRates / ratedOffers) : null,
    weightedNetRatePerKm: totalDistanceKm > 0 ? round2(totalNet / totalDistanceKm) : null,
    bestNetRate,
    worstNetRate,
    totalGross: round2(totalGross),
    totalNet: round2(totalNet),
    totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
  };
}
