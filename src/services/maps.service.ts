import 'dotenv/config';
import { CFG } from '../config.js';

interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteVerification {
  available: boolean;
  /** Powod niedostepnosci: brak klucza, przestarzaly GPS, blad geokodowania... */
  reason: string | null;
  /** Kurier -> punkt odbioru. */
  pickupKm: number | null;
  /** Punkt odbioru -> klient. */
  deliveryKm: number | null;
  /** Suma odcinkow. `null`, gdy ktorykolwiek sie nie policzyl. */
  totalKm: number | null;
  ageMin: number;
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
 * FIX (2.3): liczymy OBA odcinki trasy.
 *
 * Stara wersja miala `if (p.rodzaj !== 'odbior') continue`, wiec zwracala wylacznie
 * dojazd kuriera do restauracji. Ta wartosc trafiala potem do `totalKm` i dzielila
 * kwote netto - stawka zl/km byla sztucznie zawyzona, a kursy oznaczane jako
 * oplacalne bez pokrycia. Teraz zwracamy Odbior, Dostawe i Sume osobno.
 */
export async function verifyOfferDistance(
  userLoc: { lat: number; lng: number; ts: number } | null,
  pickupAddress: string,
  deliveryAddress: string
): Promise<RouteVerification> {
  const empty = (reason: string): RouteVerification => ({
    available: false,
    reason,
    pickupKm: null,
    deliveryKm: null,
    totalKm: null,
    ageMin: 0,
  });

  if (!apiKey()) return empty('Brak GOOGLE_MAPS_API_KEY');
  if (!userLoc) return empty('Brak lokalizacji GPS');

  const ageMs = Date.now() - userLoc.ts;
  if (ageMs > CFG.LOCATION_MAX_AGE_MS) return empty('Lokalizacja GPS jest przestarzała');

  const ageMin = Math.max(0, Math.round(ageMs / 60_000));

  const [pickupGeo, deliveryGeo] = await Promise.all([
    geocodeAddress(pickupAddress),
    geocodeAddress(deliveryAddress),
  ]);

  if (!pickupGeo) return { ...empty('Nie udało się zgeokodować adresu odbioru'), ageMin };
  if (!deliveryGeo) return { ...empty('Nie udało się zgeokodować adresu dostawy'), ageMin };

  const [pickupKm, deliveryKm] = await Promise.all([
    getRoadDistanceKm({ lat: userLoc.lat, lng: userLoc.lng }, pickupGeo),
    getRoadDistanceKm(pickupGeo, deliveryGeo),
  ]);

  if (pickupKm === null || deliveryKm === null) {
    return {
      available: false,
      reason: 'Nie udało się wyznaczyć trasy',
      pickupKm,
      deliveryKm,
      totalKm: null,
      ageMin,
    };
  }

  return {
    available: true,
    reason: null,
    pickupKm,
    deliveryKm,
    totalKm: Math.round((pickupKm + deliveryKm) * 100) / 100,
    ageMin,
  };
}
