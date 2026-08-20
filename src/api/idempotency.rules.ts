/**
 * Czysta czesc idempotencji — bez bazy, bez Hono, bez `process.env`.
 *
 * Wydzielone celowo (16.4). Gdyby te funkcje siedzialy w `idempotency.ts`,
 * ich test importowalby posrednio `db/index.ts`, ktore rzuca przy braku
 * `DATABASE_URL` — i `npm test` w kopii WSL przestalby dzialac z powodu,
 * ktory nie ma nic wspolnego z testowana logika.
 *
 * Ta sama zasada, co przy `finance.calc.ts` i `schemas.ts`.
 */

/** Po tylu godzinach wiersz jest bezuzyteczny — kolejka i tak porzuca wpisy. */
export const RETENCJA_H = 48;

/**
 * Po tylu sekundach wiersz „w toku" uznajemy za porzucony.
 *
 * Bez tego pojedynczy ubity proces zostawialby klucz zablokowany na zawsze
 * i ten konkretny wpis nigdy by nie przeszedl.
 *
 * PROG MUSI BYC WIEKSZY NIZ NAJDLUZSZY TIMEOUT KLIENTA. Wczesniej stalo tu 60 s
 * z uzasadnieniem „z duzym zapasem powyzej 10-sekundowego timeoutu klienta" —
 * i to bylo prawda, dopoki jedynymi zapisami byly napiwki. Ocena oferty wola
 * Gemini i czeka do 90 s (`TIMEOUT_OCENY_MS` w aplikacji). Przy progu 60 s
 * ponowienie wysylane po timeoucie trafialo na wiersz uznany za porzucony,
 * PRZEJMOWALO klucz i puszczalo DRUGIE wywolanie modelu rownolegle z pierwszym,
 * ktore ciagle trwalo. Zamiast ochrony przed duplikatem — dwa wiersze
 * w `course_offers` i dwa platne odczyty.
 *
 * 120 s to 90 s timeoutu plus zapas na kolejke i siec.
 */
export const PORZUCONY_PO_S = 120;

/** Co ile zapisow uruchamiamy sprzatanie starych wierszy. */
export const SPRZATAJ_CO = 50;

/**
 * Walidacja klucza z naglowka.
 *
 * Zwraca `null`, gdy naglowka nie ma (to NIE jest blad — idempotencja jest
 * opcjonalna) albo gdy klucz jest bezsensowny. Ciche odrzucenie zamiast bledu
 * 400 jest swiadome: klient, ktory przysyla smiec, dostaje zwykle zachowanie,
 * a nie zablokowany zapis danych.
 *
 * Ograniczenie znakow nie jest ozdobne — klucz trafia do logow i do klucza
 * glownego tabeli.
 */
export function normalizujKlucz(naglowek: string | undefined | null): string | null {
  if (typeof naglowek !== 'string') return null;
  const k = naglowek.trim();
  if (k.length < 8 || k.length > 128) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(k)) return null;
  return k;
}

/** Czy zajety, ale nierozstrzygniety wiersz mozna przejac. */
export function czyPorzucony(utworzony: Date, teraz: Date): boolean {
  return teraz.getTime() - utworzony.getTime() > PORZUCONY_PO_S * 1000;
}

/**
 * Czy odpowiedz warto zapamietac.
 *
 * `5xx` NIE — blad serwera musi dac sie ponowic, inaczej jedna awaria bazy
 * zablokowalaby ten wpis na zawsze. `4xx` TAK — powtorzone zle zadanie ma
 * dostac te sama odpowiedz bez ponownego przelatywania przez trase.
 */
export function czyZapamietac(status: number): boolean {
  return status > 0 && status < 500;
}
