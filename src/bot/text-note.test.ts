import { describe, expect, it } from 'vitest';
import { shouldParseAsNote } from './text-note.js';

const MAX = 200;

describe('shouldParseAsNote', () => {
  it('przepuszcza wiadomosci z liczba', () => {
    expect(shouldParseAsNote('dzisiaj zarobiłem 500 zł', MAX)).toBe(true);
    expect(shouldParseAsNote('przejechałem 52.3 km', MAX)).toBe(true);
    expect(shouldParseAsNote('pracowałem od 11:30 do 21:15', MAX)).toBe(true);
    expect(shouldParseAsNote('tankowanie 312,40 za 48 litrów', MAX)).toBe(true);
  });

  it('odrzuca gadanine bez liczb', () => {
    expect(shouldParseAsNote('ok', MAX)).toBe(false);
    expect(shouldParseAsNote('dzięki!', MAX)).toBe(false);
    expect(shouldParseAsNote('hej, co słychać', MAX)).toBe(false);
    expect(shouldParseAsNote('😀', MAX)).toBe(false);
  });

  it('odrzuca pusty tekst i same biale znaki', () => {
    expect(shouldParseAsNote('', MAX)).toBe(false);
    expect(shouldParseAsNote('   ', MAX)).toBe(false);
    expect(shouldParseAsNote('\n\t 	', MAX)).toBe(false);
  });

  it('odrzuca tekst dluzszy niz limit', () => {
    expect(shouldParseAsNote(`${'a'.repeat(MAX - 1)}5`, MAX)).toBe(true);
    expect(shouldParseAsNote(`${'a'.repeat(MAX)}5`, MAX)).toBe(false);
  });

  it('liczy dlugosc PO przycieciu bialych znakow', () => {
    expect(shouldParseAsNote(`   ${'a'.repeat(MAX - 1)}5   `, MAX)).toBe(true);
  });

  /** Zabezpieczenie na wypadek zmiany kolejnosci rejestracji handlerow (10a). */
  it('nigdy nie oddaje komend do modelu', () => {
    expect(shouldParseAsNote('/dzien 2026-08-16', MAX)).toBe(false);
    expect(shouldParseAsNote('/cel 4500', MAX)).toBe(false);
    expect(shouldParseAsNote('  /brutto 438.60', MAX)).toBe(false);
  });

  it('sama liczba wystarczy', () => {
    expect(shouldParseAsNote('500', MAX)).toBe(true);
  });
});
