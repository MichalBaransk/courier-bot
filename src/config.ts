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

  /** Waznosc lokalizacji GPS do weryfikacji tras (30 min). */
  LOCATION_MAX_AGE_MS: 30 * 60 * 1000,
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

  /** Sanity-check dlugosci zmiany. Poza zakresem = blad wpisu, nie cicha korekta. */
  MIN_SHIFT_HOURS: 0.25,
  MAX_SHIFT_HOURS: 16,

  /** Stawka przyjmowana do prognoz, dopoki nie ma wlasnej historii godzin. */
  FALLBACK_HOURLY_RATE_NETTO: 35.0,

  /** Model Gemini - jedno miejsce dla calej aplikacji. */
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3.7-flash',

  /**
   * Lista telegram_id z dostepem do bota (ALLOWED_TELEGRAM_IDS="123,456").
   * Pusta = bot otwarty dla wszystkich, ostrzezenie przy starcie.
   */
  ALLOWED_TELEGRAM_IDS: parseIdList(process.env.ALLOWED_TELEGRAM_IDS),
} as const;

export function isAllowedUser(telegramId: string | number): boolean {
  if (CFG.ALLOWED_TELEGRAM_IDS.size === 0) return true;
  return CFG.ALLOWED_TELEGRAM_IDS.has(String(telegramId));
}
