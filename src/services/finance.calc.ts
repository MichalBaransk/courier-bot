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
