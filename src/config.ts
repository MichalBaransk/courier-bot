import 'dotenv/config';

function parseIdList(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return new Set<string>();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
}

export const CFG = {
  /** Strefa czasowa uzywana WSZEDZIE do wyznaczania dat i godzin. */
  TZ: 'Europe/Warsaw',

  /** 18,6% skladki i podatek (UoP >26 lat). Docelowo do zastapienia progami. */
  TAX_FACTOR: 0.186,
  /** 81,4% kwoty brutto -> netto. */
  NETTO_FACTOR: 0.814,

  /** Prog oplacalnosci kursu (zl netto / km calej trasy). */
  MIN_STAWKA_NETTO_KM: 2.0,

  /**
   * Waznosc pinezki przypietej RECZNIE w Telegramie (30 min).
   *
   * Szerokie okno jest tu uzasadnione: kurier wysyla pinezke swiadomie, tuz
   * przed ocena oferty. Automatyczny odczyt z aplikacji ma wlasne, krotsze
   * okno, liczone w metrach — patrz `LOKALIZACJA_MAKS_BLAD_M`.
   */
  LOCATION_MAX_AGE_MS: 30 * 60 * 1000,

  /**
   * Ile metrow bledu wolno miec pozycji z aplikacji, zeby liczyc z niej dojazd.
   *
   * DLACZEGO METRY, A NIE SEKUNDY. Pierwsza wersja mowila „wazna 60 sekund".
   * Przy 100 km/h (27,8 m/s) to 1,7 km bledu — reguła w sekundach nic o tym
   * nie wie. Interesuje nas nie „ile minelo", tylko „jak daleko mogles
   * odjechac", a to iloczyn predkosci i czasu.
   *
   * Reguła dostosowuje sie sama: pod swiatlami pozycja zyje minutami,
   * przy 100 km/h okolo 11 sekund.
   *
   * `0` wylacza liczenie dojazdu z pozycji aplikacji bez wyjmowania kodu.
   */
  LOKALIZACJA_MAKS_BLAD_M: Number.parseInt(process.env.LOKALIZACJA_MAKS_BLAD_M ?? '300', 10) || 300,

  /**
   * Twarda zapora wieku pozycji (sekundy), niezalezna od predkosci.
   *
   * Bez niej telefon lezacy od godziny z predkoscia 0 uchodzilby za aktualny
   * w nieskonczonosc. „Stoi" znaczy tylko tyle, ze nie ruszal sie W CHWILI
   * ODCZYTU — od tamtej pory mogl przejechac pol miasta z wylaczonym GPS-em.
   */
  LOKALIZACJA_ZAPORA_S: Number.parseInt(process.env.LOKALIZACJA_ZAPORA_S ?? '300', 10) || 300,
  /** Od jakiej roznicy miedzy aplikacja a Google Maps ostrzegac (km). */
  DISTANCE_DIVERGENCE_KM: 1.5,
  /** Jak dlugo czeka potwierdzenie importu Portfela. */
  WALLET_IMPORT_TTL_MS: 15 * 60 * 1000,
  /** Jak dlugo bot czeka na wpisanie wartosci z klawiatury. */
  AWAITING_INPUT_TTL_MS: 5 * 60 * 1000,

  /** Limity plikow przyjmowanych od Telegrama (sprawdzane PRZED pobraniem). */
  MAX_AUDIO_BYTES: 15 * 1024 * 1024,
  MAX_PHOTO_BYTES: 20 * 1024 * 1024,
  /** Timeout pobierania pliku z serwerow Telegrama. */
  DOWNLOAD_TIMEOUT_MS: 30 * 1000,

  /**
   * Gorny sanity-check dlugosci zmiany. Przekroczenie = blad wpisu, nie cicha korekta.
   *
   * Dolnego progu NIE MA (usuniety 20.08) — patrz `calculateHours`.
   */
  MAX_SHIFT_HOURS: 16,

  /** Stawka przyjmowana do prognoz, dopoki nie ma wlasnej historii godzin. */
  FALLBACK_HOURLY_RATE_NETTO: 35.0,

  /**
   * Gorny limit dlugosci wiadomosci tekstowej oddawanej do Gemini.
   * Dluzszy tekst na pewno nie jest wpisem o zarobku ani tankowaniu,
   * a bylby najdrozszym wywolaniem modelu w calej aplikacji.
   */
  TEXT_NOTE_MAX_CHARS: 200,

  /**
   * Domena webhooka (np. `bot.baranskiha.ovh`). Pusta = long polling.
   * Sam host, bez `https://` i bez sciezki.
   */
  WEBHOOK_DOMAIN: (process.env.WEBHOOK_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
  /** Port nasluchu w kontenerze. Nie jest wystawiany na zewnatrz — siega go tunel. */
  WEBHOOK_PORT: Number(process.env.WEBHOOK_PORT ?? 8080),
  /** Ile rownoleglych polaczen Telegram moze otworzyc do webhooka. */
  WEBHOOK_MAX_CONNECTIONS: Number(process.env.WEBHOOK_MAX_CONNECTIONS ?? 20),

  /** Model Gemini - jedno miejsce dla calej aplikacji. */
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3.7-flash',

  /**
   * Kolejka zapytan do Gemini. Album 3 zdjec = 6 wywolan (klasyfikacja + odczyt),
   * wiec bez limitu rownoleglosci darmowy tier zwraca 429.
   */
  GEMINI_CONCURRENCY: Number(process.env.GEMINI_CONCURRENCY ?? 1),
  GEMINI_MIN_INTERVAL_MS: Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 1200),
  GEMINI_MAX_RETRIES: Number(process.env.GEMINI_MAX_RETRIES ?? 4),
  GEMINI_BASE_DELAY_MS: 2000,
  GEMINI_MAX_DELAY_MS: 60_000,
  GEMINI_MAX_QUEUE: 20,

  /** Kolejka Google Maps - limity sa luzniejsze, ale 429 tez sie zdarza. */
  MAPS_CONCURRENCY: Number(process.env.MAPS_CONCURRENCY ?? 4),
  MAPS_MIN_INTERVAL_MS: Number(process.env.MAPS_MIN_INTERVAL_MS ?? 100),
  MAPS_MAX_RETRIES: 3,
  MAPS_BASE_DELAY_MS: 500,
  MAPS_MAX_DELAY_MS: 10_000,
  MAPS_MAX_QUEUE: 50,

  /**
   * Lista telegram_id z dostepem do bota (ALLOWED_TELEGRAM_IDS="123,456").
   * Pusta = bot otwarty dla wszystkich, ostrzezenie przy starcie.
   */
  ALLOWED_TELEGRAM_IDS: parseIdList(process.env.ALLOWED_TELEGRAM_IDS),

  /**
   * Token dostepu do REST API dla aplikacji mobilnej.
   * PUSTY = API wylaczone, kazde zadanie spod /api/ dostaje 503.
   * Generowanie: `openssl rand -base64 32`.
   */
  API_TOKEN: (process.env.API_TOKEN || '').trim(),

  /**
   * telegram_id wlasciciela danych, do ktorego odnosi sie API_TOKEN.
   *
   * Tozsamosc wynika z MAPOWANIA TOKENA, nie z wartosci zaszytej w kodzie —
   * dzieki temu dolozenie drugiego uzytkownika zmienia to mapowanie,
   * a nie kazdy endpoint z osobna.
   *
   * Puste = jedyny wpis z ALLOWED_TELEGRAM_IDS (patrz `apiUserId`).
   */
  API_TELEGRAM_ID: (process.env.API_TELEGRAM_ID || '').trim(),
} as const;

export function isAllowedUser(telegramId: string | number): boolean {
  if (CFG.ALLOWED_TELEGRAM_IDS.size === 0) return true;
  return CFG.ALLOWED_TELEGRAM_IDS.has(String(telegramId));
}

/**
 * Wlasciciel danych widocznych przez API.
 * `null` = konfiguracja niejednoznaczna; API ma wtedy nie odpowiadac danymi.
 */
export function apiUserId(): string | null {
  if (CFG.API_TELEGRAM_ID) return CFG.API_TELEGRAM_ID;
  if (CFG.ALLOWED_TELEGRAM_IDS.size === 1) return [...CFG.ALLOWED_TELEGRAM_IDS][0] ?? null;
  return null;
}
