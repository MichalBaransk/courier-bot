import { CFG } from '../config.js';

/**
 * Cala arytmetyka dat w projekcie opiera sie na stringach `YYYY-MM-DD`
 * interpretowanych jako data kalendarzowa w strefie Europe/Warsaw.
 *
 * Zasada (ustalona 2.1): doba konczy sie o polnocy. Wpis zrobiony o 01:00
 * nalezy juz do NOWEGO dnia. Nie ma zadnego cofania nocnych zmian.
 *
 * Operacje na dniach robimy na UTC-polnocy, zeby DST nigdy nie przesunelo wyniku.
 */

const DAY_MS = 86_400_000;

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: CFG.TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: CFG.TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Dzisiejsza data kalendarzowa w Warszawie, `YYYY-MM-DD`. */
export function todayWarsaw(now: Date = new Date()): string {
  return dateFmt.format(now);
}

/** Biezaca godzina w Warszawie, `HH:MM`. */
export function nowTimeWarsaw(now: Date = new Date()): string {
  return timeFmt.format(now);
}

export function isValidDateStr(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && toDateStr(new Date(t)) === s;
}

export function isValidTimeStr(s: unknown): s is string {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** `9:05` -> `09:05`. Zwraca null gdy format jest nieprawidlowy. */
export function normalizeTime(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toUtcMidnight(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`);
}

export function addDays(dateStr: string, days: number): string {
  return toDateStr(new Date(toUtcMidnight(dateStr).getTime() + days * DAY_MS));
}

/** Liczba dni od `a` do `b` (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcMidnight(b).getTime() - toUtcMidnight(a).getTime()) / DAY_MS);
}

/** Numer dnia tygodnia wg ISO: poniedzialek = 1 ... niedziela = 7. */
export function isoDayOfWeek(dateStr: string): number {
  return toUtcMidnight(dateStr).getUTCDay() || 7;
}

/**
 * Tydzien ISO 8601 wraz z ROKIEM ISO (2.10).
 * Rok ISO potrafi rozniac sie od kalendarzowego na przelomie roku:
 * 2025-12-29 -> { year: 2026, week: 1 }, 2027-01-01 -> { year: 2026, week: 53 }.
 * Wlasnie dlatego cele tygodniowe musza byc kluczowane rokiem ISO.
 */
export function isoWeek(dateStr: string): { year: number; week: number } {
  const d = toUtcMidnight(dateStr);
  // Przesuwamy sie na czwartek biezacego tygodnia - jego rok to rok ISO.
  d.setUTCDate(d.getUTCDate() + 4 - isoDayOfWeek(dateStr));
  const year = d.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d.getTime() - jan1) / DAY_MS + 1) / 7);
  return { year, week };
}

/** Poniedzialek tygodnia ISO o podanym numerze. */
export function isoWeekStart(year: number, week: number): string {
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Dow = new Date(jan4).getUTCDay() || 7;
  const week1Monday = jan4 - (jan4Dow - 1) * DAY_MS;
  return toDateStr(new Date(week1Monday + (week - 1) * 7 * DAY_MS));
}

export interface DateRange {
  startDate: string;
  endDate: string;
}

/** Zakres pon-niedz tygodnia ISO zawierajacego `dateStr`, przesuniety o `offsetWeeks`. */
export function weekRange(dateStr: string, offsetWeeks = 0): DateRange {
  const { year, week } = isoWeek(dateStr);
  const monday = addDays(isoWeekStart(year, week), offsetWeeks * 7);
  return { startDate: monday, endDate: addDays(monday, 6) };
}

/** Zakres tygodnia ISO wskazanego wprost przez (rok ISO, numer tygodnia). */
export function weekRangeFor(year: number, week: number): DateRange {
  const monday = isoWeekStart(year, week);
  return { startDate: monday, endDate: addDays(monday, 6) };
}

export function monthRange(year: number, month: number): DateRange {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { startDate: start, endDate: `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function splitDate(dateStr: string): { year: number; month: number; day: number } {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { year: y ?? 0, month: m ?? 0, day: d ?? 0 };
}

export interface ShiftHours {
  hours: number | null;
  error: string | null;
}

/**
 * Dlugosc zmiany w godzinach (2.9).
 *
 * Stary kod przy ujemnej roznicy dodawal po cichu 24 h, wiec literowka
 * `10:00 -> 09:00` zamieniala sie w 23 h i wchodzila do statystyk oraz do
 * stawki zl/h. Teraz przejscie przez polnoc dalej dziala (22:00 -> 02:00 = 4 h),
 * ale wynik poza [MIN_SHIFT_HOURS, MAX_SHIFT_HOURS] zwraca blad zamiast liczby.
 */
export function calculateHours(fromStr: string, toStr: string): ShiftHours {
  const from = normalizeTime(fromStr);
  const to = normalizeTime(toStr);
  if (!from || !to) return { hours: null, error: 'Nieprawidlowy format godziny (oczekiwano GG:MM).' };

  const [fH, fM] = from.split(':').map(Number) as [number, number];
  const [tH, tM] = to.split(':').map(Number) as [number, number];

  let diffMinutes = tH * 60 + tM - (fH * 60 + fM);
  // Tylko UJEMNA roznica znaczy przejscie przez polnoc.
  //
  // Wczesniej bylo `<= 0`, wiec RONWE godziny dawaly 24 h. Znalezione testem
  // mostu 19.08: przycisk zmiany w aplikacji dotkniety dwa razy w tej samej
  // minucie wysylal `od == do`, a serwer odpowiadal „wychodzi 24.00 h (limit
  // 16 h)" — komunikat, z ktorego nie da sie odgadnac, co sie stalo.
  // Aplikacja od poczatku liczyla `(b - a + 1440) % 1440`, czyli ZERO. To byl
  // rozjazd miedzy dwiema stronami tej samej reguly.
  //
  // Zero godzin i tak odpada na `MIN_SHIFT_HOURS`, tylko z komunikatem, ktory
  // mowi prawde: zmiana jest za krotka.
  if (diffMinutes < 0) diffMinutes += 24 * 60;

  const hours = Math.round((diffMinutes / 60) * 100) / 100;

  if (hours > CFG.MAX_SHIFT_HOURS) {
    return {
      hours: null,
      error: `Zmiana ${from}-${to} wychodzi ${hours.toFixed(2)} h (limit ${CFG.MAX_SHIFT_HOURS} h). Sprawdz godziny.`,
    };
  }
  /**
   * DOLNEGO PROGU NIE MA — usuniety 20.08 na prosbe uzytkownika.
   *
   * Stalo tu `hours < MIN_SHIFT_HOURS` (0,25 h), czyli zmiana krotsza niz
   * kwadrans nie dawala sie zamknac. Regula mialaby sens, gdyby chronila
   * przed literowka — ale przed literowka chroni GORNY limit: to on lapie
   * `10:00 -> 09:00` (23 h), czyli przypadek, dla ktorego 2.9 powstala.
   * Dolny prog lapal wylacznie zmiany, ktore naprawde byly krotkie.
   *
   * A takie sie zdarzaja: wyjazd, natychmiastowy powrot, zamkniecie zmiany.
   * Kurier zostawal wtedy z otwarta zmiana, ktorej nie dalo sie zamknac
   * inaczej niz skasowaniem — czyli reguła „chroniaca dane" kazala je usunac.
   *
   * Zero godzin jest teraz poprawnym wynikiem. Przed przypadkowym dotknieciem
   * przycisku dwa razy chroni pytanie w aplikacji, a nie zakaz w bazie.
   */
  return { hours, error: null };
}
