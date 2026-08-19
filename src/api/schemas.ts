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

/**
 * Górna granica obrazu PO zakodowaniu w base64.
 *
 * Zrzut ekranu z telefonu to zwykle 200–800 KB, po base64 do ~1,1 MB.
 * 8 MB zostawia zapas na zdjęcie z aparatu w pełnej rozdzielczości i nadal
 * jest daleko od `MAX_PHOTO_BYTES` (20 MB), którym bot ogranicza Telegram.
 * Limit istnieje po to, żeby żądanie odbiło się od walidacji, a nie od pamięci
 * procesu — obraz idzie w całości do bufora, a potem do Gemini.
 */
const MAKS_OBRAZ_BASE64 = 8 * 1024 * 1024;

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

/**
 * Godzina albo slowo `TERAZ`.
 *
 * `TERAZ` istnieje po to, zeby aplikacja NIE musiala wysylac odczytu z zegara
 * telefonu. Zegar telefonu bywa przestawiony, a strefa zla — a §8a mowi, ze
 * o czasie decyduje serwer. Do kroku 30 aplikacja wysylala `HH:MM` z
 * `new Date()`; od P4 wysyla `TERAZ`, a serwer podstawia `nowTimeWarsaw()`.
 *
 * Zwykle `GG:MM` zostaje, bo formularz „wpisz godziny wstecz" go potrzebuje.
 */
const godzinaLubTeraz = opcjonalna(
  z
    .string()
    .refine(
      (v) => v.trim().toUpperCase() === 'TERAZ' || normalizeTime(v) !== null,
      'Godzina musi być w formacie GG:MM albo słowem "TERAZ".'
    )
);

export const ZmianaSchema = z
  .object({
    od: godzinaLubTeraz,
    do: godzinaLubTeraz,
    data: dataWpisu,
    /** Numer istniejącej zmiany — obecny TYLKO przy poprawce. */
    id: opcjonalna(
      z
        .number({ message: 'Pole "id" musi być liczbą.' })
        .int('Pole "id" musi być liczbą całkowitą.')
        .positive('Pole "id" musi być dodatnie.')
    ),
  })
  .refine((v) => v.od !== null || v.do !== null, {
    message: 'Podaj przynajmniej jedną godzinę — "od" albo "do".',
  })
  .refine((v) => v.id === null || (v.od !== null && v.do !== null), {
    // Poprawka zmiany wymaga OBU godzin. Sama jedna zamienilaby zapisana
    // zmiane w polowiczna i nie wiadomo by bylo, czy druga godzina zniknela
    // celowo, czy przez pomylke.
    message: 'Poprawka zmiany wymaga obu godzin — "od" i "do".',
  });

export const CelSchema = z.object({
  okres: z.enum(['MONTHLY', 'WEEKLY'], { message: 'Pole "okres" musi być "MONTHLY" albo "WEEKLY".' }),
  kwota: liczbaDodatnia('kwota', 1_000_000),
});

/**
 * Ocena oferty ze zrzutu ekranu.
 *
 * Obraz idzie jako **base64 w JSON-ie**, a nie multipart. Powód jest prosty:
 * całe API mówi JSON-em i przechodzi przez tę samą walidację, ten sam
 * middleware idempotencji i ten sam czytnik ciała. Multipart wymagałby drugiej
 * ścieżki obok, a jedyne, co by dał, to brak narzutu base64 (+33%).
 *
 * `pozycja` jest opcjonalna, ale to ONA jest powodem, dla którego ocena
 * w aplikacji ma sens. Telefon czyta GPS w chwili oceny (wiek 1–3 s), więc
 * budżet błędu z 8j praktycznie przestaje cokolwiek znaczyć. Bez niej serwer
 * sięga po ostatnią zapisaną pozycję — to działa, ale to jest dokładnie ten
 * przypadek z 2.3, gdzie Maps liczył dojazd od GPS-a sprzed kwadransa.
 */
export const OcenOferteSchema = z.object({
  /** Zrzut ekranu oferty, base64 BEZ prefiksu `data:`. */
  obraz: z
    .string({ message: 'Pole "obraz" musi być tekstem base64.' })
    .min(100, 'Pole "obraz" jest za krótkie, żeby było obrazem.')
    .refine((v) => !v.startsWith('data:'), 'Prześlij samo base64, bez prefiksu "data:".')
    .refine(
      (v) => v.length <= MAKS_OBRAZ_BASE64,
      `Obraz przekracza ${Math.round(MAKS_OBRAZ_BASE64 / 1024 / 1024)} MB po zakodowaniu.`
    ),
  /** `image/jpeg` albo `image/png`. */
  typ: opcjonalna(
    z.enum(['image/jpeg', 'image/png'], {
      message: 'Pole "typ" musi być "image/jpeg" albo "image/png".',
    })
  ),
  pozycja: opcjonalna(
    z.object({
      lat: z
        .number({ message: 'Pole "pozycja.lat" musi być liczbą.' })
        .refine((v) => v >= -90 && v <= 90, 'Pole "pozycja.lat" musi być w zakresie -90..90.'),
      lon: z
        .number({ message: 'Pole "pozycja.lon" musi być liczbą.' })
        .refine((v) => v >= -180 && v <= 180, 'Pole "pozycja.lon" musi być w zakresie -180..180.'),
      /**
       * Ile ms upłynęło od złapania pozycji. Wiek, nie znacznik czasu —
       * ta sama zasada co w `LokalizacjaSchema`: zegar telefonu nie ma prawa
       * być drugim źródłem prawdy obok serwera.
       */
      wiekMs: opcjonalna(liczbaNieujemna('pozycja.wiekMs', 24 * 60 * 60 * 1000)),
    })
  ),
});

/** Decyzja o ofercie. Ta sama, co przyciski pod kartą w Telegramie. */
export const DecyzjaOfertySchema = z.object({
  id: z
    .number({ message: 'Pole "id" musi być liczbą.' })
    .int('Pole "id" musi być liczbą całkowitą.')
    .positive('Pole "id" musi być dodatnie.'),
  decyzja: z.enum(['ACCEPTED', 'REJECTED'], {
    message: 'Pole "decyzja" musi być "ACCEPTED" albo "REJECTED".',
  }),
});

/**
 * Te same cele co kasowanie głosem w bocie — jedna lista, jedna logika.
 *
 * `HOURS` zachowuje dotychczasowe znaczenie: WSZYSTKIE zmiany doby. Gdyby
 * zaczęło znaczyć „ostatnia", ktoś powiedziałby głosem „skasuj godziny",
 * zobaczył jedną zmianę mniej i nie domyślił się, dlaczego reszta została.
 *
 * `SHIFT` kasuje wskazaną zmianę i jest do klikania w aplikacji — głosem
 * nie da się podać `id`. `LAST_SHIFT` jest odpowiednikiem `LAST_TIP`.
 */
export const UsunSchema = z
  .object({
    cel: z.enum(
      ['LAST_TIP', 'ALL_TIPS', 'FUEL', 'HOURS', 'SHIFT', 'LAST_SHIFT', 'EARNINGS', 'DISTANCE', 'ALL_DAY'],
      { message: 'Nieznany zakres kasowania.' }
    ),
    data: dataWpisu,
    /** Numer zmiany — wymagany wyłącznie przy `cel: "SHIFT"`. */
    sesjaId: opcjonalna(
      z
        .number({ message: 'Pole "sesjaId" musi być liczbą.' })
        .int('Pole "sesjaId" musi być liczbą całkowitą.')
        .positive('Pole "sesjaId" musi być dodatnie.')
    ),
  })
  .refine((v) => v.cel !== 'SHIFT' || v.sesjaId !== null, {
    message: 'Kasowanie pojedynczej zmiany wymaga pola "sesjaId".',
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
export type OcenOferteBody = z.infer<typeof OcenOferteSchema>;
export type DecyzjaOfertyBody = z.infer<typeof DecyzjaOfertySchema>;

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
