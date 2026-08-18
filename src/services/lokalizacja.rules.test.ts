import { describe, expect, it } from 'vitest';
import {
  DOMYSLNA_DOKLADNOSC_M,
  DOMYSLNA_PREDKOSC_MPS,
  MAKS_WIEK_MS,
  czasZapisu,
  czyAktualna,
  czyGodnaZaufania,
  czyPoprawneWspolrzedne,
  mozliwyBladM,
  opisBledu,
  opisWieku,
  wiekSekund,
} from './lokalizacja.rules.js';

/**
 * Sedno tych testow: pozycja nieswieza ma byc ODRZUCONA, a nie „lekko
 * nieaktualna". Cala wartosc tego mechanizmu polega na tym, ze woli
 * powiedziec „nie wiem" niz policzyc dojazd od punktu sprzed kwadransa (8f).
 */

const TERAZ = 1_755_500_000_000;

describe('czasZapisu — wiek zamiast znacznika czasu', () => {
  it('brak wieku znaczy „teraz"', () => {
    expect(czasZapisu(TERAZ, null)).toBe(TERAZ);
    expect(czasZapisu(TERAZ, undefined)).toBe(TERAZ);
  });

  it('wiek cofa moment zapisu', () => {
    expect(czasZapisu(TERAZ, 20_000)).toBe(TERAZ - 20_000);
  });

  it('ujemny wiek nie przesuwa zapisu w przyszlosc', () => {
    // Zegar telefonu tu nie wystepuje, ale blad klienta owszem.
    expect(czasZapisu(TERAZ, -5_000)).toBe(TERAZ);
  });

  it('absurdalny wiek jest przycinany, a nie brany na wiare', () => {
    // Wiek rzedu godzin to blad klienta, nie odczyt sprzed godziny.
    expect(czasZapisu(TERAZ, 9_999_999)).toBe(TERAZ - MAKS_WIEK_MS);
  });

  it('NaN traktujemy jak brak wieku', () => {
    expect(czasZapisu(TERAZ, NaN)).toBe(TERAZ);
  });
});

describe('wiekSekund', () => {
  it('liczy w dol do pelnych sekund', () => {
    expect(wiekSekund(TERAZ - 1_999, TERAZ)).toBe(1);
    expect(wiekSekund(TERAZ - 60_000, TERAZ)).toBe(60);
  });

  it('pozycja „z przyszlosci" ma wiek zero, a nie ujemny', () => {
    expect(wiekSekund(TERAZ + 10_000, TERAZ)).toBe(0);
  });
});

describe('czyAktualna', () => {
  it('granica jest domknieta — dokladnie TTL jeszcze przechodzi', () => {
    expect(czyAktualna(TERAZ - 60_000, TERAZ, 60)).toBe(true);
    expect(czyAktualna(TERAZ - 61_000, TERAZ, 60)).toBe(false);
  });

  it('swieza przechodzi, stara nie', () => {
    expect(czyAktualna(TERAZ - 5_000, TERAZ, 60)).toBe(true);
    expect(czyAktualna(TERAZ - 15 * 60_000, TERAZ, 60)).toBe(false);
  });

  it('TTL zero albo ujemny wylacza zaufanie do wszystkiego', () => {
    // Sposob na wylaczenie liczenia dojazdu bez wyjmowania kodu.
    expect(czyAktualna(TERAZ, TERAZ, 0)).toBe(false);
    expect(czyAktualna(TERAZ, TERAZ, -1)).toBe(false);
  });

  it('TTL niebedacy liczba nie przepuszcza po cichu', () => {
    expect(czyAktualna(TERAZ, TERAZ, NaN)).toBe(false);
  });
});

describe('opisWieku', () => {
  it('sekundy, minuty, godziny', () => {
    expect(opisWieku(0)).toBe('0 s');
    expect(opisWieku(59)).toBe('59 s');
    expect(opisWieku(60)).toBe('1 min');
    expect(opisWieku(12 * 60 + 30)).toBe('12 min');
    expect(opisWieku(3600)).toBe('1 h');
    expect(opisWieku(3600 + 5 * 60)).toBe('1 h 5 min');
  });

  it('nie wypisuje wartosci ujemnych', () => {
    expect(opisWieku(-30)).toBe('0 s');
  });
});

describe('czyPoprawneWspolrzedne', () => {
  it('przepuszcza Katowice', () => {
    expect(czyPoprawneWspolrzedne(50.2649, 19.0238)).toBe(true);
  });

  it('odrzuca zakresy spoza mapy', () => {
    expect(czyPoprawneWspolrzedne(91, 20)).toBe(false);
    expect(czyPoprawneWspolrzedne(50, 181)).toBe(false);
  });

  it('odrzuca dokladne (0, 0)', () => {
    // Zatoka Gwinejska. W praktyce zawsze niezainicjowana struktura
    // wyslana zamiast odczytu — i to jest wlasnie liczba, ktora wyglada
    // wiarygodnie, a nie znaczy nic (8f).
    expect(czyPoprawneWspolrzedne(0, 0)).toBe(false);
    // Ale samo zero w jednej osi jest legalne.
    expect(czyPoprawneWspolrzedne(0, 19.0238)).toBe(true);
  });

  it('odrzuca NaN i nieskonczonosc', () => {
    expect(czyPoprawneWspolrzedne(NaN, 19)).toBe(false);
    expect(czyPoprawneWspolrzedne(50, Infinity)).toBe(false);
  });
});

/**
 * BUDZET BLEDU.
 *
 * Te testy istnieja, bo pierwsza wersja mierzyla swiezosc w sekundach, a
 * pytanie „co przy 100 km/h na S-ce" pokazalo, ze to zla jednostka.
 * 100 km/h to 27,8 m/s, wiec 60 s daje 1,7 km bledu. Sekundy nic o tym
 * nie wiedza; metry wiedza.
 */

const stan = (over: Partial<Parameters<typeof mozliwyBladM>[0]> = {}) => ({
  wiekS: 0,
  predkoscMps: 0,
  dokladnoscM: 0,
  ...over,
});

describe('mozliwyBladM', () => {
  it('stojac blad to sama niepewnosc odczytu', () => {
    expect(mozliwyBladM(stan({ dokladnoscM: 12, predkoscMps: 0, wiekS: 300 }))).toBe(12);
  });

  it('100 km/h przez 60 s to 1,7 km — liczba z rozmowy', () => {
    // 27,8 m/s x 60 s = 1668 m. To jest dokladnie ten przypadek,
    // przez ktory reguła w sekundach wypadla.
    expect(mozliwyBladM(stan({ predkoscMps: 27.8, wiekS: 60 }))).toBe(1668);
  });

  it('niepewnosc odczytu dodaje sie do przebytej drogi', () => {
    expect(mozliwyBladM(stan({ dokladnoscM: 50, predkoscMps: 10, wiekS: 10 }))).toBe(150);
  });

  it('brak predkosci i dokladnosci daje zalozenia OSTROZNE, nie zerowe', () => {
    // Nieznane nie znaczy „idealne". Zle zalozenie w te strone przepuszczaloby
    // pozycje, ktora nic nie znaczy (8f).
    expect(mozliwyBladM(stan({ predkoscMps: null, dokladnoscM: null, wiekS: 10 }))).toBe(
      DOMYSLNA_DOKLADNOSC_M + DOMYSLNA_PREDKOSC_MPS * 10
    );
  });

  it('ujemna predkosc z Androida traktowana jak brak', () => {
    // `LocationObject.coords.speed` potrafi wrocic jako -1.
    expect(mozliwyBladM(stan({ predkoscMps: -1, dokladnoscM: 0, wiekS: 1 }))).toBe(
      DOMYSLNA_PREDKOSC_MPS
    );
  });
});

describe('czyGodnaZaufania', () => {
  const BUDZET = 300;
  const ZAPORA = 300;

  it('pod swiatlami stara pozycja jest nadal dobra', () => {
    expect(czyGodnaZaufania(stan({ predkoscMps: 0, dokladnoscM: 10, wiekS: 120 }), BUDZET, ZAPORA)).toBe(true);
  });

  it('przy 100 km/h juz 15 s nie wystarcza', () => {
    expect(czyGodnaZaufania(stan({ predkoscMps: 27.8, wiekS: 10 }), BUDZET, ZAPORA)).toBe(true);
    expect(czyGodnaZaufania(stan({ predkoscMps: 27.8, wiekS: 15 }), BUDZET, ZAPORA)).toBe(false);
  });

  it('w miescie okno jest znacznie szersze', () => {
    // 20 km/h = 5,6 m/s. 300 m / 5,6 = 53 s.
    expect(czyGodnaZaufania(stan({ predkoscMps: 5.6, wiekS: 50 }), BUDZET, ZAPORA)).toBe(true);
    expect(czyGodnaZaufania(stan({ predkoscMps: 5.6, wiekS: 55 }), BUDZET, ZAPORA)).toBe(false);
  });

  it('sama niepewnosc odczytu potrafi przekroczyc budzet', () => {
    // Miedzy blokami albo w tunelu. Swieza, a bezuzyteczna.
    expect(czyGodnaZaufania(stan({ dokladnoscM: 500, wiekS: 0, predkoscMps: 0 }), BUDZET, ZAPORA)).toBe(false);
  });

  it('twarda zapora obowiazuje nawet przy zerowej predkosci', () => {
    // „Stoi" znaczy tylko, ze nie ruszal sie W CHWILI ODCZYTU. Od tamtej pory
    // mogl przejechac pol miasta z wylaczonym GPS-em.
    expect(czyGodnaZaufania(stan({ predkoscMps: 0, dokladnoscM: 5, wiekS: 301 }), BUDZET, ZAPORA)).toBe(false);
  });

  it('budzet zero wylacza zaufanie do wszystkiego', () => {
    expect(czyGodnaZaufania(stan(), 0, ZAPORA)).toBe(false);
    expect(czyGodnaZaufania(stan(), BUDZET, 0)).toBe(false);
  });
});

describe('opisBledu', () => {
  it('metry do kilometra, potem kilometry z przecinkiem', () => {
    expect(opisBledu(120)).toBe('±120 m');
    expect(opisBledu(999)).toBe('±999 m');
    expect(opisBledu(1668)).toBe('±1,7 km');
  });

  it('nie wypisuje wartosci ujemnych', () => {
    expect(opisBledu(-5)).toBe('±0 m');
  });
});
