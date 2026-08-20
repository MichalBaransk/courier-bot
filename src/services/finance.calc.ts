import { CFG } from '../config.js';
import { calculateHours, normalizeTime } from '../utils/datetime.js';

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

// =============================================================================
// ZMIANY W CIAGU DOBY (work_sessions)
// =============================================================================

/**
 * Jedna zmiana. `do === null` znaczy, ze zmiana TRWA.
 *
 * `id` jest opcjonalne, bo ta sama struktura opisuje zarowno wiersz z bazy,
 * jak i zmiane dopiero proponowana do zapisu.
 */
export interface Sesja {
  id?: number;
  /** Godzina wyjazdu `GG:MM`. */
  od: string;
  /** Godzina zjazdu `GG:MM` albo `null`, gdy zmiana trwa. */
  do: string | null;
}

/** Zmiana ulozona na osi minut liczonej od polnocy DOBY WYJAZDU. */
export interface ZakresSesji {
  start: number;
  /** `Infinity` dla zmiany trwajacej — patrz `zakresSesji`. */
  koniec: number;
}

const MINUT_W_DOBIE = 1440;

/** `'09:05'` -> `545`. `null` przy zlym formacie. */
export function minutyOdPolnocy(godzina: string): number | null {
  const t = normalizeTime(godzina);
  if (!t) return null;
  const [h, m] = t.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/**
 * Zmiana jako przedzial minut `[start, koniec)` na osi doby wyjazdu.
 *
 * Trzy rzeczy, ktore ta funkcja rozstrzyga i ktore latwo przeoczyc:
 *
 * 1. **Przejscie przez polnoc.** Zjazd wczesniejszy albo rowny wyjazdowi znaczy
 *    nastepny dzien, wiec `koniec` moze przekroczyc 1440. Zmiana 23:50 -> 02:10
 *    to `[1430, 1570)`, a nie dwa kawalki w dwoch dobach.
 * 2. **Zmiana trwajaca konczy sie w nieskonczonosci.** Nie wiemy, kiedy sie
 *    skonczy, wiec zajmuje cala os az do konca. Dzieki temu dopisanie zmiany
 *    PO trwajacej zostanie wykryte jako nakladanie, a dopisanie WCZESNIEJSZEJ
 *    (np. porannej, o ktorej zapomnialem) przejdzie bez przeszkody.
 * 3. **Przesuniecie dobowe.** `przesuniecieDni: -1` uklada zmiane z doby
 *    poprzedniej na tej samej osi, co dzisiejsze. Bez tego zmiana 18.08
 *    23:00 -> 02:00 i zmiana 19.08 01:00 -> 05:00 wygladalyby na rozlaczne,
 *    a w rzeczywistosci nachodza na siebie o godzine.
 */
export function zakresSesji(sesja: Sesja, przesuniecieDni = 0): ZakresSesji | null {
  const start = minutyOdPolnocy(sesja.od);
  if (start === null) return null;

  const przesuniecie = przesuniecieDni * MINUT_W_DOBIE;

  if (sesja.do === null) {
    return { start: start + przesuniecie, koniec: Number.POSITIVE_INFINITY };
  }

  const koniecSurowy = minutyOdPolnocy(sesja.do);
  if (koniecSurowy === null) return null;

  // `<`, nie `<=` — rowne godziny to zmiana ZEROWEJ dlugosci, nie doba.
  // Ta sama poprawka co w `calculateHours`; obie musza mowic to samo.
  const koniec = koniecSurowy < start ? koniecSurowy + MINUT_W_DOBIE : koniecSurowy;
  return { start: start + przesuniecie, koniec: koniec + przesuniecie };
}

/**
 * Czy dwa przedzialy zachodza na siebie.
 *
 * Styk NIE jest nakladaniem: zmiana konczaca sie o 14:00 i zaczynajaca o 14:00
 * to dwie zmiany pod rzad, a nie konflikt. Stad ostre nierownosci.
 */
export function nakladajaSie(a: ZakresSesji, b: ZakresSesji): boolean {
  return a.start < b.koniec && b.start < a.koniec;
}

/**
 * Dlugosc jednej zmiany w godzinach.
 *
 * Zmiana TRWAJACA liczy sie jako **0 h**, a nie „od wyjazdu do teraz".
 * Gdyby liczyla do teraz, stawka zl/h zmienialaby sie co minute, a to samo
 * `/tydzien` wywolane dwa razy dawaloby dwie rozne liczby.
 *
 * Zmiana dluzsza niz `MAX_SHIFT_HOURS` tez daje 0 — `calculateHours` zwraca
 * wtedy `null`. W praktyce takiej zmiany nie da sie zapisac, bo `walidujSesje`
 * ja odrzuca; to zabezpieczenie na wypadek recznej poprawki w bazie.
 *
 * ⚠️ Zmiana KROTKA liczy sie normalnie. Do 20.08 dolny prog 0,25 h sprawial,
 * ze pieciominutowa zmiana wchodzila do bazy (przez reczna poprawke) i wnosila
 * `0 h` do sumy — czyli zarobek byl, godzin nie bylo, a stawka zl/h szla
 * w gore bez powodu. Prog zniknal i ten cichy rozjazd razem z nim.
 */
export function dlugoscSesjiH(sesja: Sesja): number {
  if (sesja.do === null) return 0;
  return calculateHours(sesja.od, sesja.do).hours ?? 0;
}

/** Suma godzin z listy zmian. Trwajaca zmiana wnosi 0. */
export function sumaGodzinDoby(sesje: readonly Sesja[]): number {
  let suma = 0;
  for (const s of sesje) suma += dlugoscSesjiH(s);
  return round2(suma);
}

export interface WalidacjaSesjiInput {
  /** Zmiany juz zapisane na TEJ dobie. */
  istniejace: readonly Sesja[];
  /** Zmiana dodawana albo poprawiana. Przy poprawce ma `id`. */
  nowa: Sesja;
  /**
   * Ostatnia zmiana z doby POPRZEDNIEJ, jesli przechodzi przez polnoc.
   * Serwis podaje ja tylko wtedy, gdy istnieje — patrz `zakresSesji` pkt 3.
   */
  zPoprzedniejDoby?: Sesja | null;
}

export type WynikWalidacji = { ok: true } | { ok: false; komunikat: string };

/**
 * Czy nowa zmiana moze wejsc do tej doby.
 *
 * Cztery kontrole, kazda z konkretnego powodu:
 *
 * 1. **Format godzin** — bez tego reszta liczy smieci.
 * 2. **Dlugosc pojedynczej zmiany** do `MAX_SHIFT_HOURS`. Wolana przez
 *    `calculateHours`, zeby limit istnial w JEDNYM miejscu. Dolnej granicy
 *    nie ma — zmiana zerowa jest poprawna.
 * 3. **Nakladanie sie zmian** — dwie zmiany na tych samych godzinach
 *    liczylyby te godziny dwa razy.
 * 4. **Suma doby** rowniez w limicie `MAX_SHIFT_HOURS`. Ta kontrola NIE
 *    wynika z poprzedniej: dziesiec zmian po dwie godziny to dwadziescia
 *    godzin pracy w dobie, a kazda z nich z osobna przechodzi bez mrugniecia.
 *
 * Kolejnosc nie jest przypadkowa — komunikat ma wskazywac PIERWSZA rzecz
 * do poprawienia, a nie najbardziej ogolna.
 */
export function walidujSesje(input: WalidacjaSesjiInput): WynikWalidacji {
  const zakresNowej = zakresSesji(input.nowa);
  if (!zakresNowej) {
    return { ok: false, komunikat: 'Nieprawidłowy format godziny (oczekiwano GG:MM).' };
  }

  if (input.nowa.do !== null) {
    const { error } = calculateHours(input.nowa.od, input.nowa.do);
    if (error) return { ok: false, komunikat: error };
  }

  // Poprawka zmiany nie moze kolidowac sama ze soba.
  const inne = input.istniejace.filter((s) => input.nowa.id === undefined || s.id !== input.nowa.id);

  for (const s of inne) {
    const z = zakresSesji(s);
    if (z && nakladajaSie(zakresNowej, z)) {
      return {
        ok: false,
        komunikat:
          s.do === null
            ? `Zmiana od ${s.od} jeszcze trwa — najpierw ją zamknij.`
            : `Ta zmiana nachodzi na ${s.od}–${s.do}.`,
      };
    }
  }

  if (input.zPoprzedniejDoby) {
    const z = zakresSesji(input.zPoprzedniejDoby, -1);
    if (z && nakladajaSie(zakresNowej, z)) {
      return {
        ok: false,
        komunikat: `Ta zmiana nachodzi na wczorajszą (${input.zPoprzedniejDoby.od}–${input.zPoprzedniejDoby.do ?? 'trwa'}).`,
      };
    }
  }

  const suma = round2(sumaGodzinDoby(inne) + dlugoscSesjiH(input.nowa));
  if (suma > CFG.MAX_SHIFT_HOURS) {
    return {
      ok: false,
      komunikat: `Razem wyszłoby ${suma.toFixed(2)} h w jednej dobie (limit ${CFG.MAX_SHIFT_HOURS} h).`,
    };
  }

  return { ok: true };
}
