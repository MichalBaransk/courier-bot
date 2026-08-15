import 'dotenv/config';
import { CFG } from '../config.js';

interface LatLng {
  lat: number;
  lng: number;
}

const geoCache = new Map<string, LatLng>();

export async function geocodeAddress(address: string): Promise<LatLng | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  if (geoCache.has(address)) return geoCache.get(address)!;

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;

  const data = await res.json();
  if (data.status !== 'OK' || !data.results?.[0]?.geometry?.location) return null;

  const loc: LatLng = data.results[0].geometry.location;
  geoCache.set(address, loc);
  return loc;
}

export async function getRoadDistanceKm(origin: LatLng, dest: LatLng): Promise<number | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin.lat},${origin.lng}&destinations=${dest.lat},${dest.lng}&mode=driving&units=metric&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;

  const data = await res.json();
  const element = data.rows?.[0]?.elements?.[0];
  if (!element || element.status !== 'OK' || !element.distance?.value) return null;

  return Math.round((element.distance.value / 1000) * 100) / 100;
}

export async function verifyOfferDistance(
  userLoc: { lat: number; lng: number; ts: number } | null,
  points: Array<{ rodzaj: string; nazwa?: string | null; adres?: string | null; dystans_km?: number | null }>
) {
  if (!userLoc || (Date.now() - userLoc.ts) > CFG.LOCATION_MAX_AGE_MS) {
    return { available: false, results: [] };
  }

  const results: Array<{ name: string; reported: number | null; actual: number | null; diff: number | null; error?: string }> = [];

  for (const p of points) {
    if (p.rodzaj !== 'odbior' || !p.adres) continue;

    const geo = await geocodeAddress(p.adres);
    if (!geo) {
      results.push({ name: p.nazwa || p.adres, reported: p.dystans_km || null, actual: null, diff: null, error: 'Błąd geokodowania adresu' });
      continue;
    }

    const actual = await getRoadDistanceKm({ lat: userLoc.lat, lng: userLoc.lng }, geo);
    if (actual === null) {
      results.push({ name: p.nazwa || p.adres, reported: p.dystans_km || null, actual: null, diff: null, error: 'Błąd wyznaczenia trasy' });
      continue;
    }

    const reported = p.dystans_km || null;
    const diff = reported !== null ? Math.round((actual - reported) * 100) / 100 : null;

    results.push({ name: p.nazwa || p.adres, reported, actual, diff });
  }

  return {
    available: true,
    ageMin: Math.max(0, Math.round((Date.now() - userLoc.ts) / 60000)),
    results
  };
}