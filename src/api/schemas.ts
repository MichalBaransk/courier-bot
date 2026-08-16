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

export type NapiwekBody = z.infer<typeof NapiwekSchema>;
export type PaliwoBody = z.infer<typeof PaliwoSchema>;
export type DystansBody = z.infer<typeof DystansSchema>;
export type BruttoBody = z.infer<typeof BruttoSchema>;
export type ZmianaBody = z.infer<typeof ZmianaSchema>;

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
