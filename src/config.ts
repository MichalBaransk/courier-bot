export const CFG = {
  TAX_FACTOR: 0.186,          // 18,6% składki i podatek (UoP >26 lat)
  NETTO_FACTOR: 0.814,        // 81,4% kwoty brutto -> netto
  MIN_STAWKA_NETTO_KM: 2.0,   // Próg opłacalności kursu (zł netto / km)
  TOLERANCJA_KM: 0.3,         // Dopuszczalna rozbieżność trasy (km)
  LOCATION_MAX_AGE_MS: 30 * 60 * 1000, // Ważność lokalizacji (30 min)
  MAX_AUDIO_BYTES: 15 * 1024 * 1024,
  MAX_PHOTO_BYTES: 20 * 1024 * 1024,
  HISTORY_LEN: 5,
};