import { describe, expect, it } from 'vitest';
import {
  BruttoSchema,
  DystansSchema,
  NapiwekSchema,
  PaliwoSchema,
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
