/**
 * Swiezosc pozycji kuriera — CZYSTA logika, bez bazy i bez sieci.
 *
 * Wydzielone z tego samego powodu co `idempotency.rules.ts`: test tego pliku
 * nie moze importowac `db/index.ts`, ktory bez `DATABASE_URL` rzuca wyjatkiem
 * przy samym zaladowaniu modulu.
 *
 * PO CO TO W OGOLE JEST — patrz 8f. Realny przypadek: oferta 22,04 zl,
 * aplikacja Glovo podala 3,37 + 3,01 km. Bot policzyl przez Maps 7,56 + 1,83
 * i wyszlo 1,91 zl/km, czyli „odrzuc". Prawidlowo bylo 2,81 zl/km, czyli
 * „przyjmij". Jedna z dwoch przyczyn: Maps liczyl dojazd od OSTATNIEGO
 * WYSLANEGO GPS-a, a nie od pozycji biezacej.
 *
 * Ten plik odpowiada na jedno pytanie: czy pozycja, ktora mamy, jest jeszcze
 * cokolwiek warta. Odpowiedz „nie" jest w porzadku — lepiej nie podac nic niz
 * podac liczbe, ktora wyglada wiarygodnie i nie znaczy nic (8f).
 */

export const ZRODLA_LOKALIZACJI = ['APP', 'TELEGRAM'] as const;
export type ZrodloLokalizacji = (typeof ZRODLA_LOKALIZACJI)[number];

/**
 * Gorna granica wieku podanego przez telefon.
 *
 * Telefon przysyla WIEK odczytu w milisekundach, a nie znacznik czasu.
 * To celowe: wiek jest wielkoscia wzgledna, wiec nie ma w nim zegara, ktory
 * moglby byc przestawiony. Znacznik czasu z telefonu bylby kolejnym zrodlem
 * prawdy obok serwera — dokladnie tego zabrania 8a.
 *
 * Wiek powyzej tej granicy traktujemy jak brak wieku (czyli „teraz"), bo
 * wartosc rzedu godzin oznacza blad klienta, nie realny odczyt sprzed godziny.
 */
export const MAKS_WIEK_MS = 5 * 60 * 1000;

/**
 * Kiedy odczyt naprawde powstal.
 *
 * `wiekMs` to ile milisekund uplynelo od zlapania pozycji do wyslania jej na
 * serwer. Przy kolejce offline potrafi to byc kilkadziesiat sekund.
 */
export function czasZapisu(terazMs: number, wiekMs: number | null | undefined): number {
  if (wiekMs == null || !Number.isFinite(wiekMs)) return terazMs;
  const wiek = Math.min(Math.max(0, wiekMs), MAKS_WIEK_MS);
  return terazMs - wiek;
}

/** Wiek pozycji w pelnych sekundach. Nigdy ujemny. */
export function wiekSekund(zapisanoMs: number, terazMs: number): number {
  return Math.max(0, Math.floor((terazMs - zapisanoMs) / 1000));
}

/**
 * Czy pozycja miesci sie w stalym oknie czasu.
 *
 * Uzywane WYLACZNIE do pinezki z Telegrama, ktora nie niesie predkosci —
 * kurier przypina ja recznie i swiadomie, wiec okno jest szerokie.
 * Dla odczytow z aplikacji sluzy `czyGodnaZaufania`, ktore patrzy na metry.
 *
 * `ttlS <= 0` znaczy „nie ufaj zadnej" — sposob na wylaczenie liczenia dojazdu
 * bez wyjmowania kodu.
 */
export function czyAktualna(zapisanoMs: number, terazMs: number, ttlS: number): boolean {
  if (!Number.isFinite(ttlS) || ttlS <= 0) return false;
  return wiekSekund(zapisanoMs, terazMs) <= ttlS;
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * BUDZET BLEDU — dlaczego sekundy byly zla jednostka
 *
 * Pierwsza wersja mowila „pozycja wazna 60 sekund". Pytanie od uzytkownika
 * rozbilo to jednym zdaniem: a co przy 100 km/h na drodze szybkiego ruchu?
 *
 *   100 km/h = 27,8 m/s.  60 s = 1,7 km bledu.
 *   Nawet 20 s = 556 m — przy trzykilometrowym dojezdzie to 18%.
 *
 * Nie obchodzi nas „ile minelo", tylko „jak daleko mogles odjechac". To jest
 * iloczyn, nie czas. Reguła w metrach dostosowuje sie sama:
 *
 *   pod swiatlami   → wiek ograniczony tylko twarda zapora
 *   20 km/h         → 54 s
 *   50 km/h         → 22 s
 *   100 km/h        → 11 s
 *
 * Do tego doliczamy wlasna niepewnosc odczytu (`accuracy`), bo pozycja
 * z bledem 500 m jest bezuzyteczna nawet gdy powstala przed sekunda —
 * a to normalne miedzy blokami albo w tunelu.
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * Predkosc zakladana, gdy GPS jej nie poda.
 *
 * Android potrafi zwrocic `null` albo `-1`, zwlaszcza przy pierwszym odczycie.
 * 14 m/s to okolo 50 km/h — zalozenie OSTROZNE, czyli takie, ktore raczej
 * odrzuci dobra pozycje, niz przepusci zla. Przy nieznanej predkosci wolimy
 * powiedziec „nie wiem" (8f).
 */
export const DOMYSLNA_PREDKOSC_MPS = 14;

/** Niepewnosc zakladana, gdy GPS jej nie poda. Typowa dla telefonu na otwartym terenie. */
export const DOMYSLNA_DOKLADNOSC_M = 30;

export interface StanPozycji {
  wiekS: number;
  /** Metry na sekunde. `null` = GPS nie podal. */
  predkoscMps: number | null;
  /** Promien niepewnosci odczytu w metrach. `null` = GPS nie podal. */
  dokladnoscM: number | null;
}

/**
 * Ile metrow moze wynosic blad tej pozycji TERAZ.
 *
 * Suma dwoch skladnikow, bo obydwa naprawde wystepuja:
 *   - niepewnosc samego odczytu (gdzie bylem, gdy go zlapano),
 *   - przebyta droga od tamtej chwili (gdzie jestem teraz).
 */
export function mozliwyBladM(stan: StanPozycji): number {
  const wiek = Math.max(0, Number.isFinite(stan.wiekS) ? stan.wiekS : 0);

  const predkosc =
    stan.predkoscMps != null && Number.isFinite(stan.predkoscMps) && stan.predkoscMps >= 0
      ? stan.predkoscMps
      : DOMYSLNA_PREDKOSC_MPS;

  const dokladnosc =
    stan.dokladnoscM != null && Number.isFinite(stan.dokladnoscM) && stan.dokladnoscM >= 0
      ? stan.dokladnoscM
      : DOMYSLNA_DOKLADNOSC_M;

  return Math.round(dokladnosc + predkosc * wiek);
}

/**
 * Czy pozycja jest dosc dokladna, zeby liczyc z niej dojazd.
 *
 * `zaporaS` to twardy limit niezalezny od predkosci. Bez niego telefon lezacy
 * od godziny z predkoscia 0 uchodzilby za aktualny w nieskonczonosc — a
 * „stoi" znaczy tylko tyle, ze w chwili ODCZYTU sie nie ruszal. Od tamtej
 * pory mogl przejechac pol miasta z wylaczonym GPS-em.
 */
export function czyGodnaZaufania(stan: StanPozycji, budzetM: number, zaporaS: number): boolean {
  if (!Number.isFinite(budzetM) || budzetM <= 0) return false;
  if (!Number.isFinite(zaporaS) || zaporaS <= 0) return false;
  if (stan.wiekS > zaporaS) return false;
  return mozliwyBladM(stan) <= budzetM;
}

/** Blad po polsku, do karty oferty: `±0,4 km` albo `±120 m`. */
export function opisBledu(metry: number): string {
  const m = Math.max(0, Math.round(metry));
  return m >= 1000 ? `±${(m / 1000).toFixed(1).replace('.', ',')} km` : `±${m} m`;
}

/**
 * Wiek po polsku, do karty oferty.
 *
 * Celowo bez „temu" i bez sekund powyzej minuty — to ma byc etykieta obok
 * liczby, a nie zdanie.
 */
export function opisWieku(sekundy: number): string {
  const s = Math.max(0, Math.floor(sekundy));
  if (s < 60) return `${s} s`;
  const minuty = Math.floor(s / 60);
  if (minuty < 60) return `${minuty} min`;
  const godziny = Math.floor(minuty / 60);
  const reszta = minuty % 60;
  return reszta === 0 ? `${godziny} h` : `${godziny} h ${reszta} min`;
}

/**
 * Zakres wspolrzednych.
 *
 * Osobno od schematu zod, zeby ta sama kontrola dala sie uzyc takze przy
 * danych z Telegrama, ktore przez API nie przechodza.
 */
export function czyPoprawneWspolrzedne(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lon < -180 || lon > 180) return false;
  // Dokladne (0, 0) to Zatoka Gwinejska — w praktyce zawsze blad klienta,
  // ktory wyslal niezainicjowana strukture zamiast odczytu.
  return !(lat === 0 && lon === 0);
}
