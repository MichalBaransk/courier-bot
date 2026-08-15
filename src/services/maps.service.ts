import 'dotenv/config';
import { CFG } from '../config.js';

interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteVerification {
  /** Czy udalo sie policzyc cokolwiek. */
  available: boolean;
  /** Powod braku danych: brak klucza, przestarzaly GPS, blad geokodowania... */
  reason: string | null;
  /** Kurier -> punkt odbioru. */
  pickupKm: number | null;
  /** Punkt odbioru -> klient. `null`, gdy oferta nie podaje adresu klienta. */
  deliveryKm: number | null;
  /** Dlaczego nie ma odcinka dostawy. */
  deliveryReason: string | null;
  /** Suma odcinkow. `null`, gdy ktoregokolwiek brakuje. */
  totalKm: number | null;
  /** Wiek uzytej pozycji GPS w minutach. */
  ageMin: number;
}

/**
 * Czy adres jest na tyle konkretny, zeby geokodowanie mialo sens.
 *
 * Ekran oferty Glovo NIE pokazuje adresu klienta przed akceptacja — Gemini
 * wyciaga z niego zwykle sama nazwe miasta ("Katowice"). Geokoder zwraca wtedy
 * centroid miasta, a dystans do niego to liczba bez zadnego zwiazku
 * z rzeczywistoscia. Lepiej nie podac nic niz podac zmyslone 1,83 km.
 */
export function isSpecificAddress(address: string): boolean {
  const trimmed = address.trim();
  if (trimmed.length < 6) return false;
  // Numer budynku albo kod pocztowy.
  if (/\d/.test(trimmed)) return true;
  // Prefiks ulicy bez numeru — te potraktujemy jako zbyt ogolne.
  return false;
}

const geoCache = new Map<string, LatLng>();

function apiKey(): string | null {
  return process.env.GOOGLE_MAPS_API_KEY || null;
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch (err) {
    console.warn('[Maps] błąd zapytania:', err);
    return null;
  }
}

export async function geocodeAddress(address: string): Promise<LatLng | null> {
  const key = apiKey();
  if (!key) return null;

  const cached = geoCache.get(address);
  if (cached) return cached;

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
  const data = (await fetchJson(url)) as
    | { status?: string; results?: Array<{ geometry?: { location?: LatLng } }> }
    | null;

  const loc = data?.status === 'OK' ? data.results?.[0]?.geometry?.location : undefined;
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return null;

  geoCache.set(address, loc);
  return loc;
}

export async function getRoadDistanceKm(origin: LatLng, dest: LatLng): Promise<number | null> {
  const key = apiKey();
  if (!key) return null;

  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${origin.lat},${origin.lng}&destinations=${dest.lat},${dest.lng}` +
    `&mode=driving&units=metric&key=${key}`;

  const data = (await fetchJson(url)) as
    | { rows?: Array<{ elements?: Array<{ status?: string; distance?: { value?: number } }> }> }
    | null;

  const element = data?.rows?.[0]?.elements?.[0];
  if (!element || element.status !== 'OK' || typeof element.distance?.value !== 'number') return null;

  return Math.round((element.distance.value / 1000) * 100) / 100;
}

/**
 * Niezalezna kontrola dystansu przez Google Maps.
 *
 * FIX (2.3): liczymy OBA odcinki, nie tylko dojazd do restauracji.
 *
 * Ograniczenia, o ktorych trzeba pamietac czytajac wynik:
 *  • odcinek odbioru liczy sie od OSTATNIEJ wyslanej pozycji GPS, nie od
 *    biezacej — jesli kurier ruszyl sie od czasu `/lokalizacja`, bedzie
 *    rozbieznosc wzgledem aplikacji Glovo, ktora zna pozycje na zywo;
 *  • odcinek dostawy da sie policzyc tylko wtedy, gdy oferta podaje konkretny
 *    adres klienta — przed akceptacja Glovo go nie pokazuje.
 */
export async function verifyOfferDistance(
  userLoc: { lat: number; lng: number; ts: number } | null,
  pickupAddress: string,
  deliveryAddress: string
): Promise<RouteVerification> {
  const empty = (reason: string, ageMin = 0): RouteVerification => ({
    available: false,
    reason,
    pickupKm: null,
    deliveryKm: null,
    deliveryReason: reason,
    totalKm: null,
    ageMin,
  });

  if (!apiKey()) return empty('brak GOOGLE_MAPS_API_KEY');
  if (!userLoc) return empty('brak pozycji GPS — wyślij /lokalizacja');

  const ageMs = Date.now() - userLoc.ts;
  if (ageMs > CFG.LOCATION_MAX_AGE_MS) return empty('pozycja GPS jest przestarzała');

  const ageMin = Math.max(0, Math.round(ageMs / 60_000));

  const pickupGeo = await geocodeAddress(pickupAddress);
  if (!pickupGeo) return empty('nie udało się zgeokodować adresu odbioru', ageMin);

  const pickupKm = await getRoadDistanceKm({ lat: userLoc.lat, lng: userLoc.lng }, pickupGeo);
  if (pickupKm === null) return empty('nie udało się wyznaczyć dojazdu', ageMin);

  // Odcinek dostawy — tylko gdy adres klienta jest konkretny.
  let deliveryKm: number | null = null;
  let deliveryReason: string | null = null;

  if (!isSpecificAddress(deliveryAddress)) {
    deliveryReason = 'oferta nie podaje adresu klienta';
  } else {
    const deliveryGeo = await geocodeAddress(deliveryAddress);
    if (!deliveryGeo) {
      deliveryReason = 'nie udało się zgeokodować adresu klienta';
    } else {
      deliveryKm = await getRoadDistanceKm(pickupGeo, deliveryGeo);
      if (deliveryKm === null) deliveryReason = 'nie udało się wyznaczyć trasy do klienta';
    }
  }

  return {
    available: true,
    reason: null,
    pickupKm,
    deliveryKm,
    deliveryReason,
    totalKm: deliveryKm !== null ? Math.round((pickupKm + deliveryKm) * 100) / 100 : null,
    ageMin,
  };
}
