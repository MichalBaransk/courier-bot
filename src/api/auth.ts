import { createHash, timingSafeEqual } from 'node:crypto';
import { CFG } from '../config.js';

/**
 * Autoryzacja REST API dla aplikacji mobilnej.
 *
 * Naglowek: `Authorization: Bearer <API_TOKEN>`.
 *
 * Dlaczego nie zwykle `===`:
 * porownanie stringow w JS przerywa sie na pierwszym roznym bajcie, wiec czas
 * odpowiedzi minimalnie zdradza, ile znakow sie zgadzalo. Przez internet, za
 * Cloudflare, atak czasowy jest w praktyce nierealny — ale poprawka kosztuje
 * trzy linijki, wiec nie ma powodu jej nie robic.
 *
 * Dlaczego skroty, a nie surowe bufory:
 * `timingSafeEqual` RZUCA wyjatkiem przy roznych dlugosciach buforow, a sama
 * roznica dlugosci zdradzalaby dlugosc tokena. SHA-256 daje zawsze 32 bajty.
 */

const BEARER = /^bearer\s+(\S+)$/i;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Czysta funkcja — bez odwolan do CFG, dzieki czemu da sie ja testowac
 * bez ustawiania zmiennych srodowiskowych przed importem modulu.
 */
export function tokenMatches(headerValue: string | null | undefined, expectedToken: string): boolean {
  if (!expectedToken) return false;
  if (!headerValue) return false;

  const match = BEARER.exec(headerValue.trim());
  const presented = match?.[1];
  if (!presented) return false;

  return timingSafeEqual(sha256(presented), sha256(expectedToken));
}

/** Czy API jest w ogole wlaczone. Brak `API_TOKEN` = kazde zadanie dostaje 401. */
export function isApiEnabled(): boolean {
  return CFG.API_TOKEN.length > 0;
}

export function isValidApiToken(headerValue: string | null | undefined): boolean {
  return tokenMatches(headerValue, CFG.API_TOKEN);
}
