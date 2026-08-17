import { describe, expect, it } from 'vitest';
import { b, code, compact, h, i, joinLines, km, progressBar, zl, zlSigned } from './format.js';

/**
 * Escapowanie HTML — jedyna rzecz w tym pliku, ktora naprawde boli, gdy padnie.
 *
 * FIX (3.3) opisuje realny przypadek: adres `ul. Sportowa 5_A` z OCR albo
 * gwiazdka w transkrypcji glosowej wywalaly CALA wiadomosc bledem
 * `400: can't parse entities`, a uzytkownik widzial tylko „Blad analizy
 * obrazu". Bot poszedl na HTML wlasnie dlatego, ze tam escapowanie to trzy
 * znaki i jest pewne — ale tylko dopoki `h()` faktycznie je robi.
 *
 * Dane od Gemini i od uzytkownika sa tu traktowane jak wrogie, bo takie
 * bywaja przez przypadek.
 */

describe('h — escapowanie tresci obcej', () => {
  it('zamienia trzy znaki, ktore psuja HTML Telegrama', () => {
    expect(h('<b>')).toBe('&lt;b&gt;');
    expect(h('a & b')).toBe('a &amp; b');
  });

  it('kolejnosc podmian nie robi podwojnego escapowania', () => {
    // `&` musi isc PIERWSZE. Odwrotnie `<` stalby sie `&amp;lt;`.
    expect(h('<')).toBe('&lt;');
    expect(h('&lt;')).toBe('&amp;lt;');
  });

  it('probe wstrzykniecia znacznika zwija do tekstu', () => {
    expect(h('<a href="http://zly">klik</a>')).toBe(
      '&lt;a href="http://zly"&gt;klik&lt;/a&gt;'
    );
  });

  it('podkreslenia i gwiazdki zostawia w spokoju — to problem Markdowna, nie HTML-a', () => {
    // Dokladnie ten adres wywalal wiadomosc w wersji na Markdownie.
    expect(h('ul. Sportowa 5_A')).toBe('ul. Sportowa 5_A');
    expect(h('*gwiazdka*')).toBe('*gwiazdka*');
  });

  it('null i undefined daja pusty tekst, a nie slowo „null"', () => {
    expect(h(null)).toBe('');
    expect(h(undefined)).toBe('');
  });

  it('liczby i inne typy przechodza przez String()', () => {
    expect(h(42)).toBe('42');
    expect(h(0)).toBe('0');
    expect(h(false)).toBe('false');
  });
});

describe('b / i / code — escapuja zawartosc, nie tylko opakowuja', () => {
  it('tresc w srodku jest escapowana', () => {
    expect(b('<x>')).toBe('<b>&lt;x&gt;</b>');
    expect(i('a & b')).toBe('<i>a &amp; b</i>');
    expect(code('<script>')).toBe('<code>&lt;script&gt;</code>');
  });
});

describe('kwoty i dystans', () => {
  it('zawsze dwa miejsca po przecinku', () => {
    expect(zl(0)).toBe('0.00 zł');
    expect(zl(1234.5)).toBe('1234.50 zł');
  });

  it('zlSigned dodaje plus tylko wartosciom dodatnim', () => {
    expect(zlSigned(12)).toBe('+12.00 zł');
    expect(zlSigned(-8.5)).toBe('-8.50 zł');
    expect(zlSigned(0)).toBe('0.00 zł');
  });

  it('km domyslnie z jednym miejscem', () => {
    expect(km(142.35)).toBe('142.3 km');
    expect(km(142.35, 2)).toBe('142.35 km');
  });
});

describe('compact / joinLines — wiersze warunkowe', () => {
  it('wyrzuca false, null, undefined i pusty tekst', () => {
    expect(compact(['a', false, null, undefined, '', 'b'])).toEqual(['a', 'b']);
  });

  it('joinLines sklada to, co zostalo', () => {
    expect(joinLines(['pierwszy', false, 'drugi'])).toBe('pierwszy\ndrugi');
  });

  it('sama pustka daje pusty tekst, nie serie nowych linii', () => {
    expect(joinLines([false, null, ''])).toBe('');
  });
});

describe('progressBar', () => {
  it('krance', () => {
    expect(progressBar(0)).toBe('[░░░░░░░░░░]');
    expect(progressBar(100)).toBe('[██████████]');
    expect(progressBar(50)).toBe('[█████░░░░░]');
  });

  it('wartosci spoza zakresu sa przycinane, a nie rysowane', () => {
    // Cel przekroczony o 40% nie moze narysowac czternastu blokow.
    expect(progressBar(140)).toBe('[██████████]');
    expect(progressBar(-20)).toBe('[░░░░░░░░░░]');
  });

  // ZNANY DEFEKT, NIEPOPRAWIONY: `progressBar(NaN)` zwraca `[]` — pusty tekst
  // zamiast paska. `Math.round(NaN)` to `NaN`, `Math.max/min` przepuszczaja
  // `NaN` dalej, a `'█'.repeat(NaN)` daje pusty lancuch. Poprawka to jedna
  // linia (`Number.isFinite(percent) ? percent : 0`), ale to zmiana bazowego
  // kodu i czeka na zgode. Celowo NIE zapisuje tu obecnego zachowania jako
  // oczekiwanego — test utrwalajacy blad jest gorszy niz brak testu.
});
