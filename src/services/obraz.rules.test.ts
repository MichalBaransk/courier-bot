import { describe, expect, it } from 'vitest';

import { kilometrLubNull, kmZWiersza, wymiaryObrazu } from './obraz.rules.js';

/** Minimalny, ale PRAWDZIWY naglowek PNG: sygnatura + IHDR z wymiarami. */
function png(szerokosc: number, wysokosc: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(szerokosc, 16);
  buf.writeUInt32BE(wysokosc, 20);
  return buf;
}

/**
 * JPEG z segmentem APP0 PRZED SOF0 — czyli tak, jak wyglada plik z aparatu.
 * Chodzi o to, zeby test sprawdzal skakanie po dlugosciach, a nie staly offset.
 */
function jpeg(szerokosc: number, wysokosc: number, zApp0 = true): Buffer {
  const czesci: number[] = [0xff, 0xd8];
  if (zApp0) {
    czesci.push(0xff, 0xe0, 0x00, 0x10);
    for (let i = 0; i < 14; i++) czesci.push(0x00);
  }
  czesci.push(0xff, 0xc0, 0x00, 0x11, 0x08);
  czesci.push((wysokosc >> 8) & 0xff, wysokosc & 0xff);
  czesci.push((szerokosc >> 8) & 0xff, szerokosc & 0xff);
  for (let i = 0; i < 10; i++) czesci.push(0x00);
  return Buffer.from(czesci);
}

describe('wymiaryObrazu', () => {
  it('czyta wymiary PNG', () => {
    expect(wymiaryObrazu(png(1080, 2340))).toEqual({ szerokosc: 1080, wysokosc: 2340, format: 'png' });
  });

  it('czyta wymiary JPEG, przeskakując segment APP0', () => {
    expect(wymiaryObrazu(jpeg(1747, 2340))).toEqual({ szerokosc: 1747, wysokosc: 2340, format: 'jpeg' });
  });

  it('czyta JPEG bez żadnych segmentów przed SOF', () => {
    expect(wymiaryObrazu(jpeg(1080, 2340, false))).toEqual({
      szerokosc: 1080,
      wysokosc: 2340,
      format: 'jpeg',
    });
  });

  it('nie myli wysokości z szerokością — w JPEG stoją w tej kolejności', () => {
    const w = wymiaryObrazu(jpeg(100, 900));
    expect(w?.szerokosc).toBe(100);
    expect(w?.wysokosc).toBe(900);
  });

  it('null zamiast zgadywania, gdy to nie jest obraz albo nagłówek jest ucięty', () => {
    expect(wymiaryObrazu(Buffer.from('to nie jest obraz'))).toBeNull();
    expect(wymiaryObrazu(Buffer.alloc(0))).toBeNull();
    expect(wymiaryObrazu(png(10, 10).subarray(0, 12))).toBeNull();
  });
});

describe('kilometrLubNull — zero to „nie odczytałem", nie „zero km"', () => {
  it('zero staje się brakiem', () => {
    expect(kilometrLubNull(0)).toBeNull();
  });

  it('wartość dodatnia przechodzi bez zmian', () => {
    expect(kilometrLubNull(3.37)).toBe(3.37);
    expect(kilometrLubNull(0.01)).toBe(0.01);
  });

  it('null zostaje nullem, ujemne i NaN też', () => {
    expect(kilometrLubNull(null)).toBeNull();
    expect(kilometrLubNull(-1)).toBeNull();
    expect(kilometrLubNull(Number.NaN)).toBeNull();
  });
});

describe('kmZWiersza — kilometry z dosłownie przepisanego wiersza', () => {
  it('czyta format z ekranu Glovo: przecinek i jednostka', () => {
    expect(kmZWiersza('Apteczka Zdrowia 3,37 km')).toBe(3.37);
    expect(kmZWiersza('Dostawa 3,01 km')).toBe(3.01);
  });

  it('przyjmuje też kropkę — model bywa „pomocny" i sam zamienia separator', () => {
    expect(kmZWiersza('Dostawa 5.47 km')).toBe(5.47);
  });

  it('radzi sobie z liczbą całkowitą', () => {
    expect(kmZWiersza('Dostawa 4 km')).toBe(4);
  });

  it('bierze OSTATNIE dopasowanie — w nazwie firmy też bywają liczby', () => {
    expect(kmZWiersza('Sklep 24h 3,37 km')).toBe(3.37);
    expect(kmZWiersza('Stacja 7 km od centrum 2,50 km')).toBe(2.5);
  });

  it('null, gdy w wierszu nie ma kilometrów', () => {
    expect(kmZWiersza('Dostawa')).toBeNull();
    expect(kmZWiersza('MediaMarkt, Alpejska 6')).toBeNull();
    expect(kmZWiersza(null)).toBeNull();
    expect(kmZWiersza('')).toBeNull();
  });

  it('nie łapie liczb bez jednostki — 255,69 zł to nie dystans', () => {
    expect(kmZWiersza('ZAPŁAĆ 255,69 zł')).toBeNull();
    expect(kmZWiersza('22,04 zł')).toBeNull();
  });

  it('zero traktuje jak brak, tak samo jak `kilometrLubNull`', () => {
    expect(kmZWiersza('Dostawa 0,00 km')).toBeNull();
  });
});
