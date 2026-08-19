import { describe, expect, it } from 'vitest';
import {
  BruttoSchema,
  CelSchema,
  DystansSchema,
  LokalizacjaSchema,
  NapiwekSchema,
  PaliwoSchema,
  DecyzjaOfertySchema,
  OcenOferteSchema,
  UsunSchema,
  ZmianaSchema,
  pierwszyBlad,
} from './schemas.js';

describe('NapiwekSchema', () => {
  it('przyjmuje kwotę bez daty', () => {
    const w = NapiwekSchema.safeParse({ kwota: 5.5 });
    expect(w.success).toBe(true);
    if (w.success) expect(w.data.data).toBeNull();
  });

  it('przyjmuje datę w poprawnym formacie', () => {
    const w = NapiwekSchema.safeParse({ kwota: 5.5, data: '2026-08-16' });
    expect(w.success).toBe(true);
    if (w.success) expect(w.data.data).toBe('2026-08-16');
  });

  it('odrzuca zero i wartości ujemne', () => {
    expect(NapiwekSchema.safeParse({ kwota: 0 }).success).toBe(false);
    expect(NapiwekSchema.safeParse({ kwota: -5 }).success).toBe(false);
  });

  it('odrzuca NaN i nieskończoność', () => {
    expect(NapiwekSchema.safeParse({ kwota: Number.NaN }).success).toBe(false);
    expect(NapiwekSchema.safeParse({ kwota: Number.POSITIVE_INFINITY }).success).toBe(false);
  });

  it('odrzuca kwotę spoza rozsądnego zakresu', () => {
    expect(NapiwekSchema.safeParse({ kwota: 10_001 }).success).toBe(false);
  });

  it('odrzuca kwotę podaną jako tekst', () => {
    expect(NapiwekSchema.safeParse({ kwota: '5.5' }).success).toBe(false);
  });

  it('odrzuca datę, która nie istnieje w kalendarzu', () => {
    expect(NapiwekSchema.safeParse({ kwota: 5, data: '2026-02-30' }).success).toBe(false);
    expect(NapiwekSchema.safeParse({ kwota: 5, data: '16-08-2026' }).success).toBe(false);
  });
});

describe('PaliwoSchema', () => {
  it('litry i cena są opcjonalne', () => {
    const w = PaliwoSchema.safeParse({ kwota: 312.4 });
    expect(w.success).toBe(true);
    if (w.success) {
      expect(w.data.litry).toBeNull();
      expect(w.data.cenaZaLitr).toBeNull();
    }
  });

  it('przyjmuje komplet', () => {
    const w = PaliwoSchema.safeParse({ kwota: 312.4, litry: 48.2, cenaZaLitr: 6.48 });
    expect(w.success).toBe(true);
  });

  it('odrzuca absurdalną liczbę litrów', () => {
    expect(PaliwoSchema.safeParse({ kwota: 100, litry: 5000 }).success).toBe(false);
  });
});

describe('DystansSchema', () => {
  it('przyjmuje dystans dzienny', () => {
    expect(DystansSchema.safeParse({ km: 142.3 }).success).toBe(true);
  });

  /** Sanity-check przeciw wpisaniu stanu licznika zamiast dystansu dnia. */
  it('odrzuca wartość wyglądającą na stan licznika', () => {
    expect(DystansSchema.safeParse({ km: 84_500 }).success).toBe(false);
  });
});

describe('BruttoSchema', () => {
  it('zero jest dozwolone — pozwala wyzerować pomyłkę', () => {
    expect(BruttoSchema.safeParse({ kwota: 0 }).success).toBe(true);
  });

  it('odrzuca wartości ujemne', () => {
    expect(BruttoSchema.safeParse({ kwota: -1 }).success).toBe(false);
  });
});

describe('ZmianaSchema', () => {
  it('przyjmuje samo "od"', () => {
    expect(ZmianaSchema.safeParse({ od: '11:30' }).success).toBe(true);
  });

  it('przyjmuje samo "do"', () => {
    expect(ZmianaSchema.safeParse({ do: '21:15' }).success).toBe(true);
  });

  it('przyjmuje obie godziny', () => {
    expect(ZmianaSchema.safeParse({ od: '11:30', do: '21:15' }).success).toBe(true);
  });

  it('przyjmuje zapis jednocyfrowy — normalizacja jest po stronie serwisu', () => {
    expect(ZmianaSchema.safeParse({ od: '9:05' }).success).toBe(true);
  });

  it('odrzuca puste ciało — nie ma czego zapisać', () => {
    expect(ZmianaSchema.safeParse({}).success).toBe(false);
  });

  it('odrzuca nieistniejące godziny', () => {
    expect(ZmianaSchema.safeParse({ od: '25:00' }).success).toBe(false);
    expect(ZmianaSchema.safeParse({ od: '11:75' }).success).toBe(false);
    expect(ZmianaSchema.safeParse({ od: '1130' }).success).toBe(false);
  });

  it('przyjmuje TERAZ zamiast godziny — zegar podstawia serwer', () => {
    expect(ZmianaSchema.safeParse({ od: 'TERAZ' }).success).toBe(true);
    expect(ZmianaSchema.safeParse({ do: 'teraz' }).success).toBe(true);
    expect(ZmianaSchema.safeParse({ do: ' Teraz ' }).success).toBe(true);
  });

  it('nie przyjmuje innych słów — TERAZ to jedyny wyjątek od GG:MM', () => {
    expect(ZmianaSchema.safeParse({ od: 'zaraz' }).success).toBe(false);
    expect(ZmianaSchema.safeParse({ od: 'now' }).success).toBe(false);
  });

  it('poprawka zmiany wymaga id ORAZ obu godzin', () => {
    expect(ZmianaSchema.safeParse({ id: 7, od: '10:00', do: '14:00' }).success).toBe(true);
    expect(ZmianaSchema.safeParse({ id: 7, od: '10:00' }).success).toBe(false);
    expect(ZmianaSchema.safeParse({ id: 7, do: '14:00' }).success).toBe(false);
  });

  it('odrzuca id, które nie jest dodatnią liczbą całkowitą', () => {
    expect(ZmianaSchema.safeParse({ id: 0, od: '10:00', do: '14:00' }).success).toBe(false);
    expect(ZmianaSchema.safeParse({ id: 1.5, od: '10:00', do: '14:00' }).success).toBe(false);
    expect(ZmianaSchema.safeParse({ id: '7', od: '10:00', do: '14:00' }).success).toBe(false);
  });

  it('brak id znaczy „dopisz nową", nie „popraw pierwszą"', () => {
    const w = ZmianaSchema.safeParse({ od: '10:00', do: '14:00' });
    expect(w.success).toBe(true);
    if (w.success) expect(w.data.id).toBeNull();
  });
});

describe('UsunSchema — kasowanie zmian', () => {
  it('SHIFT wymaga sesjaId', () => {
    expect(UsunSchema.safeParse({ cel: 'SHIFT' }).success).toBe(false);
    expect(UsunSchema.safeParse({ cel: 'SHIFT', sesjaId: 41 }).success).toBe(true);
  });

  it('HOURS i LAST_SHIFT dzialaja bez sesjaId', () => {
    expect(UsunSchema.safeParse({ cel: 'HOURS' }).success).toBe(true);
    expect(UsunSchema.safeParse({ cel: 'LAST_SHIFT' }).success).toBe(true);
  });

  it('stare cele nadal przechodzą — kontrakt się nie zerwał', () => {
    for (const cel of ['LAST_TIP', 'ALL_TIPS', 'FUEL', 'EARNINGS', 'DISTANCE', 'ALL_DAY']) {
      expect(UsunSchema.safeParse({ cel }).success).toBe(true);
    }
  });

  it('komunikat przy SHIFT bez sesjaId mówi, czego brakuje', () => {
    expect(pierwszyBlad(UsunSchema.safeParse({ cel: 'SHIFT' }))).toContain('sesjaId');
  });
});

describe('pierwszyBlad', () => {
  it('zwraca null dla poprawnych danych', () => {
    expect(pierwszyBlad(NapiwekSchema.safeParse({ kwota: 5 }))).toBeNull();
  });

  it('zwraca komunikat wskazujący pole', () => {
    const komunikat = pierwszyBlad(NapiwekSchema.safeParse({ kwota: -1 }));
    expect(komunikat).toContain('kwota');
  });

  it('zwraca komunikat także dla braku pola', () => {
    expect(pierwszyBlad(NapiwekSchema.safeParse({}))).toBeTruthy();
  });
});

describe('CelSchema', () => {
  it('przyjmuje cel miesięczny i tygodniowy', () => {
    expect(CelSchema.safeParse({ okres: 'MONTHLY', kwota: 4500 }).success).toBe(true);
    expect(CelSchema.safeParse({ okres: 'WEEKLY', kwota: 1200 }).success).toBe(true);
  });

  it('odrzuca nieznany okres', () => {
    expect(CelSchema.safeParse({ okres: 'DAILY', kwota: 100 }).success).toBe(false);
    expect(CelSchema.safeParse({ okres: 'monthly', kwota: 100 }).success).toBe(false);
  });

  it('odrzuca cel zerowy', () => {
    expect(CelSchema.safeParse({ okres: 'MONTHLY', kwota: 0 }).success).toBe(false);
  });
});

describe('UsunSchema', () => {
  it('przyjmuje wszystkie zakresy znane botowi', () => {
    for (const cel of ['LAST_TIP', 'ALL_TIPS', 'FUEL', 'HOURS', 'EARNINGS', 'DISTANCE', 'ALL_DAY']) {
      expect(UsunSchema.safeParse({ cel }).success).toBe(true);
    }
  });

  it('data jest opcjonalna', () => {
    const w = UsunSchema.safeParse({ cel: 'ALL_DAY' });
    expect(w.success).toBe(true);
    if (w.success) expect(w.data.data).toBeNull();
  });

  it('odrzuca zakres spoza listy', () => {
    expect(UsunSchema.safeParse({ cel: 'WSZYSTKO' }).success).toBe(false);
    expect(UsunSchema.safeParse({}).success).toBe(false);
  });
});

describe('LokalizacjaSchema', () => {
  it('przyjmuje same współrzędne', () => {
    const w = LokalizacjaSchema.safeParse({ lat: 50.2649, lon: 19.0238 });
    expect(w.success).toBe(true);
    if (w.success) {
      expect(w.data.dokladnoscM).toBeNull();
      expect(w.data.wiekMs).toBeNull();
    }
  });

  it('przyjmuje dokładność, wiek i prędkość', () => {
    const w = LokalizacjaSchema.safeParse({
      lat: 50.2649,
      lon: 19.0238,
      dokladnoscM: 12,
      wiekMs: 20_000,
      predkoscMps: 27.8,
    });
    expect(w.success).toBe(true);
    if (w.success) {
      expect(w.data.wiekMs).toBe(20_000);
      expect(w.data.predkoscMps).toBe(27.8);
    }
  });

  it('prędkość jest opcjonalna — Android potrafi jej nie podać', () => {
    const w = LokalizacjaSchema.safeParse({ lat: 50.2649, lon: 19.0238 });
    expect(w.success).toBe(true);
    if (w.success) expect(w.data.predkoscMps).toBeNull();
  });

  it('odrzuca prędkość ujemną i absurdalną', () => {
    // Android zwraca -1 zamiast null. Schemat ma to ODRZUCIĆ, a nie naprawiać —
    // klient wyśle wtedy `null` i warstwa reguł podstawi założenie ostrożne.
    expect(LokalizacjaSchema.safeParse({ lat: 50, lon: 19, predkoscMps: -1 }).success).toBe(false);
    expect(LokalizacjaSchema.safeParse({ lat: 50, lon: 19, predkoscMps: 500 }).success).toBe(false);
  });

  it('odrzuca współrzędne spoza mapy', () => {
    expect(LokalizacjaSchema.safeParse({ lat: 91, lon: 19 }).success).toBe(false);
    expect(LokalizacjaSchema.safeParse({ lat: 50, lon: -181 }).success).toBe(false);
  });

  it('odrzuca brak którejkolwiek współrzędnej', () => {
    expect(LokalizacjaSchema.safeParse({ lat: 50.26 }).success).toBe(false);
    expect(LokalizacjaSchema.safeParse({}).success).toBe(false);
  });

  it('odrzuca współrzędne przysłane jako tekst', () => {
    // Telefon potrafi wysłać "50.2649" zamiast liczby — po cichu
    // zinterpretowane dałoby pozycję, która wygląda dobrze i jest zmyślona.
    expect(LokalizacjaSchema.safeParse({ lat: '50.2649', lon: '19.0238' }).success).toBe(false);
  });

  it('odrzuca ujemny wiek odczytu', () => {
    expect(
      LokalizacjaSchema.safeParse({ lat: 50.26, lon: 19.02, wiekMs: -1 }).success
    ).toBe(false);
  });

  // Zero na zero przechodzi przez schemat, a odrzuca je dopiero
  // `czyPoprawneWspolrzedne` — bo ta sama kontrola musi obowiązywać także
  // pinezkę z Telegrama, która przez ten schemat nigdy nie przechodzi.
  it('(0, 0) przechodzi przez schemat — łapie je dopiero warstwa reguł', () => {
    expect(LokalizacjaSchema.safeParse({ lat: 0, lon: 0 }).success).toBe(true);
  });
});

describe('OcenOferteSchema', () => {
  const obraz = 'A'.repeat(200);

  it('sam obraz wystarczy — pozycja i typ są opcjonalne', () => {
    const w = OcenOferteSchema.safeParse({ obraz });
    expect(w.success).toBe(true);
    if (w.success) {
      expect(w.data.pozycja).toBeNull();
      expect(w.data.typ).toBeNull();
    }
  });

  it('odrzuca prefiks data: — chcemy samo base64', () => {
    const w = OcenOferteSchema.safeParse({ obraz: `data:image/jpeg;base64,${obraz}` });
    expect(w.success).toBe(false);
    expect(pierwszyBlad(w)).toContain('data:');
  });

  it('odrzuca coś, co nie może być obrazem', () => {
    expect(OcenOferteSchema.safeParse({ obraz: 'abc' }).success).toBe(false);
    expect(OcenOferteSchema.safeParse({}).success).toBe(false);
  });

  it('pilnuje górnej granicy rozmiaru', () => {
    const wielki = 'A'.repeat(8 * 1024 * 1024 + 1);
    const w = OcenOferteSchema.safeParse({ obraz: wielki });
    expect(w.success).toBe(false);
    expect(pierwszyBlad(w)).toContain('MB');
  });

  it('przyjmuje pozycję z wiekiem, odrzuca współrzędne poza zakresem', () => {
    expect(
      OcenOferteSchema.safeParse({ obraz, pozycja: { lat: 50.26, lon: 19.02, wiekMs: 1200 } }).success
    ).toBe(true);
    expect(OcenOferteSchema.safeParse({ obraz, pozycja: { lat: 91, lon: 19 } }).success).toBe(false);
    expect(OcenOferteSchema.safeParse({ obraz, pozycja: { lat: 50, lon: 181 } }).success).toBe(false);
  });

  it('pozycja bez wieku jest w porządku — serwer przyjmie „teraz"', () => {
    const w = OcenOferteSchema.safeParse({ obraz, pozycja: { lat: 50.26, lon: 19.02 } });
    expect(w.success).toBe(true);
    if (w.success) expect(w.data.pozycja?.wiekMs).toBeNull();
  });

  it('przyjmuje tylko dwa typy obrazu', () => {
    expect(OcenOferteSchema.safeParse({ obraz, typ: 'image/png' }).success).toBe(true);
    expect(OcenOferteSchema.safeParse({ obraz, typ: 'image/webp' }).success).toBe(false);
  });
});

describe('DecyzjaOfertySchema', () => {
  it('przyjmuje obie decyzje', () => {
    expect(DecyzjaOfertySchema.safeParse({ id: 5, decyzja: 'ACCEPTED' }).success).toBe(true);
    expect(DecyzjaOfertySchema.safeParse({ id: 5, decyzja: 'REJECTED' }).success).toBe(true);
  });

  it('odrzuca trzecią wartość i złe id', () => {
    expect(DecyzjaOfertySchema.safeParse({ id: 5, decyzja: 'MOZE' }).success).toBe(false);
    expect(DecyzjaOfertySchema.safeParse({ id: 0, decyzja: 'ACCEPTED' }).success).toBe(false);
    expect(DecyzjaOfertySchema.safeParse({ decyzja: 'ACCEPTED' }).success).toBe(false);
  });
});
