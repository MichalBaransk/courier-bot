import { describe, expect, it } from 'vitest';
import { tokenMatches } from './auth.js';

const TOKEN = 'a'.repeat(43);

describe('tokenMatches', () => {
  it('przepuszcza poprawny token', () => {
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('schemat jest niewrazliwy na wielkosc liter (RFC 7235)', () => {
    expect(tokenMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(tokenMatches(`BEARER ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('toleruje biale znaki wokol naglowka', () => {
    expect(tokenMatches(`  Bearer   ${TOKEN}  `, TOKEN)).toBe(true);
  });

  it('odrzuca zly token tej samej dlugosci', () => {
    expect(tokenMatches(`Bearer ${'b'.repeat(43)}`, TOKEN)).toBe(false);
  });

  /**
   * Kluczowy przypadek: `timingSafeEqual` rzuca przy roznych dlugosciach
   * buforow. Gdyby porownywac surowe wartosci zamiast skrotow, ten test
   * wywalilby sie wyjatkiem zamiast zwrocic `false`.
   */
  it('odrzuca token innej dlugosci BEZ rzucania wyjatkiem', () => {
    expect(() => tokenMatches('Bearer krotki', TOKEN)).not.toThrow();
    expect(tokenMatches('Bearer krotki', TOKEN)).toBe(false);
    expect(tokenMatches(`Bearer ${'c'.repeat(500)}`, TOKEN)).toBe(false);
  });

  it('odrzuca brak naglowka', () => {
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
    expect(tokenMatches(null, TOKEN)).toBe(false);
    expect(tokenMatches('', TOKEN)).toBe(false);
  });

  it('odrzuca inny schemat autoryzacji', () => {
    expect(tokenMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, TOKEN)).toBe(false);
  });

  it('odrzuca sam schemat bez wartosci', () => {
    expect(tokenMatches('Bearer', TOKEN)).toBe(false);
    expect(tokenMatches('Bearer   ', TOKEN)).toBe(false);
  });

  /** Pusty API_TOKEN = API wylaczone. Nie wolno, zeby pusty naglowek pasowal. */
  it('pusty oczekiwany token nie pasuje do niczego', () => {
    expect(tokenMatches('Bearer cokolwiek', '')).toBe(false);
    expect(tokenMatches('Bearer ', '')).toBe(false);
    expect(tokenMatches(undefined, '')).toBe(false);
  });
});
