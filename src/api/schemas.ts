import { z } from 'zod';
import { isValidDateStr, normalizeTime } from '../utils/datetime.js';

/**
 * Schematy ciał żądań POST.
 *
 * Wydzielone z tras, bo są czystymi wartościami — dają się testować bez
 * podnoszenia serwera, bazy i całej reszty (§16.4).
 *
 * Komunikaty są po polsku i mówią, KTÓRE pole jest złe. Klient dostaje 400
 * z konkretem zamiast „Bad Request", bo po drugiej stronie stoi formularz
 * na telefonie, a nie programista z debuggerem.
 */

const liczbaDodatnia = (pole: string, maks: number) =>
  z
    .number({ message: `Pole "${pole}" musi być liczbą.` })
    .refine(Number.isFinite, `Pole "${pole}" musi być skończoną liczbą.`)
    .refine((v) => v > 0, `Pole "${pole}" musi być większe od zera.`)
    .refine((v) => v <= maks, `Pole "${pole}" przekracza rozsądny limit (${maks}).`);

const liczbaNieujemna = (pole: string, maks: number) =>
  z
    .number({ message: `Pole "${pole}" musi być liczbą.` })
    .refine(Number.isFinite, `Pole "${pole}" musi być skończoną liczbą.`)
    .refine((v) => v >= 0, `Pole "${pole}" nie może być ujemne.`)
    .refine((v) => v <= maks, `Pole "${pole}" przekracza rozsądny limit (${maks}).`);

/** `undefined` i `null` traktujemy tak samo — jako „nie podano". */
const opcjonalna = <T>(schemat: z.ZodType<T>) => schemat.nullish().transform((v) => v ?? null);

/**
 * Data wpisu. Puste = dzisiaj wyznaczone PO STRONIE SERWERA.
 * Telefon może mieć złą strefę albo przestawiony zegar, a doba kończy się
 * o północy w Europe/Warsaw (§8a) — serwer jest tu jedynym źródłem prawdy.
 */
const dataWpisu = opcjonalna(
  z.string().refine(isValidDateStr, 'Data musi być w formacie RRRR-MM-DD.')
);

const godzina = opcjonalna(
  z.string().refine((v) => normalizeTime(v) !== null, 'Godzina musi być w formacie GG:MM.')
);

export const NapiwekSchema = z.object({
  kwota: liczbaDodatnia('kwota', 10_000),
  data: dataWpisu,
});

export const PaliwoSchema = z.object({
  kwota: liczbaDodatnia('kwota', 10_000),
  litry: opcjonalna(liczbaDodatnia('litry', 500)),
  cenaZaLitr: opcjonalna(liczbaDodatnia('cenaZaLitr', 100)),
  data: dataWpisu,
});

export const DystansSchema = z.object({
  /** Dystans PRZEJECHANY danego dnia, nie stan licznika (§2.7 w ZMIANY.md). */
  km: liczbaDodatnia('km', 2_000),
  data: dataWpisu,
});

export const BruttoSchema = z.object({
  /** Zero jest dozwolone — pozwala wyzerować pomyłkowy wpis. */
  kwota: liczbaNieujemna('kwota', 100_000),
  data: dataWpisu,
});

export const ZmianaSchema = z
  .object({
    od: godzina,
    do: godzina,
    data: dataWpisu,
  })
  .refine((v) => v.od !== null || v.do !== null, {
    message: 'Podaj przynajmniej jedną godzinę — "od" albo "do".',
  });

export const CelSchema = z.object({
  okres: z.enum(['MONTHLY', 'WEEKLY'], { message: 'Pole "okres" musi być "MONTHLY" albo "WEEKLY".' }),
  kwota: liczbaDodatnia('kwota', 1_000_000),
});

/** Te same cele co kasowanie głosem w bocie — jedna lista, jedna logika. */
export const UsunSchema = z.object({
  cel: z.enum(['LAST_TIP', 'ALL_TIPS', 'FUEL', 'HOURS', 'EARNINGS', 'DISTANCE', 'ALL_DAY'], {
    message: 'Nieznany zakres kasowania.',
  }),
  data: dataWpisu,
});

/**
 * Pozycja kuriera.
 *
 * `wiekMs` zamiast znacznika czasu — CELOWO. Wiek jest wielkoscia wzgledna,
 * wiec nie ma w nim zegara telefonu, ktory moglby byc przestawiony. Znacznik
 * czasu z klienta bylby drugim zrodlem prawdy obok serwera, a §8a mowi
 * wyraznie, ze o czasie decyduje serwer.
 *
 * Zakresy sa tu twarde, bo to jedyne miejsce, gdzie da sie zatrzymac odczyt
 * bez sensu. Dokladne (0, 0) odrzucamy osobno w `lokalizacja.rules.ts` —
 * to Zatoka Gwinejska, w praktyce zawsze niezainicjowana struktura.
 */
export const LokalizacjaSchema = z.object({
  lat: z
    .number({ message: 'Pole "lat" musi byc liczba.' })
    .refine(Number.isFinite, 'Pole "lat" musi byc skonczona liczba.')
    .refine((v) => v >= -90 && v <= 90, 'Pole "lat" musi byc w zakresie -90..90.'),
  lon: z
    .number({ message: 'Pole "lon" musi byc liczba.' })
    .refine(Number.isFinite, 'Pole "lon" musi byc skonczona liczba.')
    .refine((v) => v >= -180 && v <= 180, 'Pole "lon" musi byc w zakresie -180..180.'),
  /** Promien niepewnosci GPS w metrach, tak jak podaje go system. */
  dokladnoscM: opcjonalna(liczbaNieujemna('dokladnoscM', 100_000)),
  /** Ile ms uplynelo od zlapania pozycji do wyslania. Przycinane do 5 min. */
  wiekMs: opcjonalna(liczbaNieujemna('wiekMs', 24 * 60 * 60 * 1000)),
  /**
   * Predkosc w metrach na sekunde w chwili odczytu.
   *
   * Od niej zalezy, jak dlugo pozycja jest cokolwiek warta — przy 100 km/h
   * pozycja sprzed minuty jest o 1,7 km obok. Android potrafi zwrocic `-1`
   * zamiast `null`, wiec ujemna wartosc traktujemy jak brak (w regułach,
   * nie tutaj — schemat ma odrzucac, a nie naprawiac).
   */
  predkoscMps: opcjonalna(liczbaNieujemna('predkoscMps', 200)),
});

export type NapiwekBody = z.infer<typeof NapiwekSchema>;
export type PaliwoBody = z.infer<typeof PaliwoSchema>;
export type DystansBody = z.infer<typeof DystansSchema>;
export type BruttoBody = z.infer<typeof BruttoSchema>;
export type ZmianaBody = z.infer<typeof ZmianaSchema>;
export type CelBody = z.infer<typeof CelSchema>;
export type UsunBody = z.infer<typeof UsunSchema>;

/**
 * Kształt wyniku `safeParse` opisany STRUKTURALNIE, a nie przez nazwę typu
 * z zoda. Powód: `SafeParseReturnType` z zoda 3 nazywa się inaczej w zodzie 4,
 * a projekt jest na `^4.4.3`. Struktura jest stabilna między wersjami, nazwa nie.
 */
type WynikWalidacji =
  | { success: true }
  | { success: false; error: { issues: ReadonlyArray<{ message: string }> } };

/** Pierwszy komunikat błędu albo `null`, gdy dane są poprawne. */
export function pierwszyBlad(wynik: WynikWalidacji): string | null {
  if (wynik.success) return null;
  return wynik.error.issues[0]?.message ?? 'Nieprawidłowe dane.';
}
export type LokalizacjaBody = z.infer<typeof LokalizacjaSchema>;
