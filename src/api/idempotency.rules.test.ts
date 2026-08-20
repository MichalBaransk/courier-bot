import { describe, expect, it } from 'vitest';
import { czyPorzucony, czyZapamietac, normalizujKlucz } from './idempotency.rules.js';

/**
 * Testy czystej czesci idempotencji — bez bazy, bez serwera.
 *
 * Ta sama zasada co w `schemas.test.ts` (16.4): logika, ktora da sie
 * przetestowac bez podnoszenia calego swiata, ma byc wydzielona tak, zeby
 * dalo sie ja przetestowac bez podnoszenia calego swiata.
 *
 * Reszty — wyscigu dwoch zadan i zapamietywania odpowiedzi — nie da sie
 * sprawdzic bez bazy. Procedura recznego testu jest w
 * `claude/plan-punkt-5-kolejka-offline.md` i sprowadza sie do:
 * dwa `curl` z tym samym kluczem, potem `SELECT count(*)` = 1.
 */

describe('normalizujKlucz', () => {
  it('przepuszcza UUID', () => {
    const uuid = '9f1c2a4e-3b7d-4c2f-9a11-2f6b8c0d5e73';
    expect(normalizujKlucz(uuid)).toBe(uuid);
  });

  it('obcina biale znaki', () => {
    expect(normalizujKlucz('  klucz-12345678  ')).toBe('klucz-12345678');
  });

  it('brak naglowka to nie blad — idempotencja jest opcjonalna', () => {
    expect(normalizujKlucz(undefined)).toBeNull();
    expect(normalizujKlucz(null)).toBeNull();
    expect(normalizujKlucz('')).toBeNull();
  });

  it('odrzuca klucz za krotki i za dlugi', () => {
    expect(normalizujKlucz('abc')).toBeNull();
    expect(normalizujKlucz('a'.repeat(129))).toBeNull();
    expect(normalizujKlucz('a'.repeat(128))).toBe('a'.repeat(128));
  });

  it('odrzuca znaki, ktore nie maja prawa trafic do logu ani do klucza glownego', () => {
    expect(normalizujKlucz('klucz z spacja')).toBeNull();
    expect(normalizujKlucz('klucz\nz-nowa-linia')).toBeNull();
    expect(normalizujKlucz("klucz';DROP TABLE users;--")).toBeNull();
  });
});

describe('czyZapamietac', () => {
  it('zapamietuje sukcesy', () => {
    expect(czyZapamietac(200)).toBe(true);
    expect(czyZapamietac(201)).toBe(true);
  });

  it('zapamietuje bledy klienta — powtorka ma dostac te sama odpowiedz', () => {
    expect(czyZapamietac(400)).toBe(true);
    expect(czyZapamietac(404)).toBe(true);
  });

  it('NIE zapamietuje bledow serwera — inaczej awaria bazy zablokowalaby wpis na zawsze', () => {
    expect(czyZapamietac(500)).toBe(false);
    expect(czyZapamietac(503)).toBe(false);
  });

  it('zero znaczy „w toku", a nie kod odpowiedzi', () => {
    expect(czyZapamietac(0)).toBe(false);
  });
});

describe('czyPorzucony', () => {
  const teraz = new Date('2026-08-16T12:00:00Z');

  it('swieze zadanie nie jest porzucone', () => {
    expect(czyPorzucony(new Date('2026-08-16T11:59:30Z'), teraz)).toBe(false);
  });

  /**
   * Granica MUSI lezec powyzej najdluzszego timeoutu klienta (90 s przy ocenie
   * oferty). Gdyby ktos wrocil do 60 s, ten test zapali sie natychmiast — i o to
   * chodzi, bo skutkiem bylyby dwa rownolegle wywolania Gemini dla jednego zrzutu.
   */
  it('granica 120 s', () => {
    expect(czyPorzucony(new Date('2026-08-16T11:58:00Z'), teraz)).toBe(false);
    expect(czyPorzucony(new Date('2026-08-16T11:57:59Z'), teraz)).toBe(true);
  });

  it('zadanie sprzed 90 s — czyli po timeoucie oceny oferty — NIE jest porzucone', () => {
    expect(czyPorzucony(new Date('2026-08-16T11:58:30Z'), teraz)).toBe(false);
  });

  it('zadanie sprzed godziny to ubity proces, nie praca w toku', () => {
    expect(czyPorzucony(new Date('2026-08-16T11:00:00Z'), teraz)).toBe(true);
  });
});
