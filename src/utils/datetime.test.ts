import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  addDays,
  calculateHours,
  daysBetween,
  isoDayOfWeek,
  isoWeek,
  isoWeekStart,
  isValidDateStr,
  monthRange,
  normalizeTime,
  nowTimeWarsaw,
  todayWarsaw,
  weekRange,
  weekRangeFor,
} from './datetime.js';

afterEach(() => {
  vi.useRealTimers();
});

function atUtc(iso: string): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

describe('todayWarsaw (FIX 2.1)', () => {
  it('01:00 czasu warszawskiego należy już do nowego dnia', () => {
    // 2026-08-16 01:00 Warszawa = 2026-08-15 23:00 UTC
    atUtc('2026-08-15T23:00:00Z');
    expect(todayWarsaw()).toBe('2026-08-16');
  });

  it('23:30 czasu warszawskiego to nadal ten sam dzień', () => {
    atUtc('2026-08-15T21:30:00Z');
    expect(todayWarsaw()).toBe('2026-08-15');
  });

  it('05:30 rano NIE cofa daty (regresja starego kodu)', () => {
    // Stary getEffectiveDate() czytal getHours() z UTC (03:30 < 4)
    // i cofal date o dzien. Tutaj musi wyjsc 2026-08-16.
    atUtc('2026-08-16T03:30:00Z');
    expect(todayWarsaw()).toBe('2026-08-16');
  });

  it('działa też zimą, przy przesunięciu UTC+1', () => {
    atUtc('2026-01-15T23:30:00Z'); // 2026-01-16 00:30 Warszawa
    expect(todayWarsaw()).toBe('2026-01-16');
  });

  it('nowTimeWarsaw zwraca czas lokalny, nie UTC', () => {
    atUtc('2026-08-15T21:30:00Z');
    expect(nowTimeWarsaw()).toBe('23:30');
  });
});

describe('isoWeek (FIX 2.10)', () => {
  it('koniec grudnia należy do tygodnia 1 następnego roku ISO', () => {
    expect(isoWeek('2025-12-29')).toEqual({ year: 2026, week: 1 });
    expect(isoWeek('2025-12-31')).toEqual({ year: 2026, week: 1 });
  });

  it('początek stycznia potrafi należeć do poprzedniego roku ISO', () => {
    expect(isoWeek('2027-01-01')).toEqual({ year: 2026, week: 53 });
  });

  it('cel zapisany 30 grudnia i odczytany 2 stycznia ma ten sam klucz', () => {
    expect(isoWeek('2025-12-30')).toEqual(isoWeek('2026-01-02'));
  });

  it('isoWeekStart zwraca poniedziałek tygodnia', () => {
    expect(isoWeekStart(2026, 1)).toBe('2025-12-29');
    expect(isoDayOfWeek(isoWeekStart(2026, 33))).toBe(1);
  });

  it('weekRange to zawsze pon–niedz', () => {
    const range = weekRange('2026-08-15'); // sobota
    expect(range).toEqual({ startDate: '2026-08-10', endDate: '2026-08-16' });
  });

  it('weekRange z offsetem -1 daje poprzedni tydzień', () => {
    expect(weekRange('2026-08-15', -1)).toEqual({ startDate: '2026-08-03', endDate: '2026-08-09' });
  });

  it('weekRangeFor jest spójne z isoWeek', () => {
    const { year, week } = isoWeek('2026-08-15');
    const range = weekRangeFor(year, week);
    expect(range.startDate).toBe('2026-08-10');
    expect(range.endDate).toBe('2026-08-16');
  });
});

describe('arytmetyka dat', () => {
  it('addDays przechodzi przez granicę miesiąca', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('addDays nie gubi dnia przy zmianie czasu', () => {
    // Zmiana czasu w Polsce: 2026-03-29
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
  });

  it('daysBetween liczy różnicę dni', () => {
    expect(daysBetween('2026-08-01', '2026-08-15')).toBe(14);
  });

  it('monthRange obsługuje luty roku przestępnego', () => {
    expect(monthRange(2028, 2)).toEqual({ startDate: '2028-02-01', endDate: '2028-02-29' });
  });

  it('isValidDateStr odrzuca nieistniejące daty', () => {
    expect(isValidDateStr('2026-02-30')).toBe(false);
    expect(isValidDateStr('2026-08-15')).toBe(true);
    expect(isValidDateStr('15.08.2026')).toBe(false);
    expect(isValidDateStr(undefined)).toBe(false);
  });
});

describe('normalizeTime', () => {
  it('uzupełnia zero wiodące', () => {
    expect(normalizeTime('9:05')).toBe('09:05');
    expect(normalizeTime('19:30')).toBe('19:30');
  });

  it('odrzuca bzdury', () => {
    expect(normalizeTime('25:00')).toBeNull();
    expect(normalizeTime('12:99')).toBeNull();
    expect(normalizeTime('/dzis')).toBeNull();
  });
});

describe('calculateHours (FIX 2.9)', () => {
  it('liczy zwykłą zmianę', () => {
    expect(calculateHours('16:00', '23:30')).toEqual({ hours: 7.5, error: null });
  });

  it('obsługuje przejście przez północ', () => {
    expect(calculateHours('22:00', '02:00')).toEqual({ hours: 4, error: null });
  });

  it('odrzuca literówkę zamiast dodawać po cichu 24 h', () => {
    // Stary kod zwracal tutaj 23 h i wpuszczal je do statystyk.
    const result = calculateHours('10:00', '09:00');
    expect(result.hours).toBeNull();
    expect(result.error).toContain('limit');
  });

  it('odrzuca zmianę krótszą niż minimum', () => {
    const result = calculateHours('10:00', '10:10');
    expect(result.hours).toBeNull();
    expect(result.error).toContain('minimum');
  });

  it('równe godziny to zmiana za krótka, a nie 24 h', () => {
    const r = calculateHours('20:05', '20:05');
    expect(r.hours).toBeNull();
    expect(r.error).toContain('minimum');
    expect(r.error).not.toContain('24');
  });

  it('zgłasza błąd formatu zamiast zwracać 0', () => {
    expect(calculateHours('abc', '10:00').error).toContain('format');
  });
});
