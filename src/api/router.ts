import type { RequestListener } from 'node:http';
import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { apiUserId } from '../config.js';
import { isApiEnabled, isValidApiToken } from './auth.js';
import { registerReadRoutes } from './routes.read.js';

/**
 * REST API dla aplikacji mobilnej.
 *
 * Zyje w TYM SAMYM procesie i na TYM SAMYM porcie co webhook Telegrama —
 * bot juz jest serwerem HTTP, wiec nie ma po co stawiac drugiego kontenera.
 * Granica przebiega na jednym `if` w `server.ts`: wszystko spod `/api/`
 * trafia tutaj, reszta zostaje na dotychczasowym handlerze.
 *
 * Gdyby Hono kiedykolwiek sprawialo problemy, wypiecie tego jednego `if`
 * przywraca bota do stanu sprzed zmiany.
 *
 * UWAGA BEZPIECZENSTWA: to API stoi na tej samej subdomenie co webhook, a na
 * niej NIE WOLNO wlaczyc Cloudflare Access — Telegram nie przejdzie logowania
 * i wszystkie update'y wroca jako 403 (12c). `API_TOKEN` jest jedyna obrona
 * miedzy internetem a baza.
 */

export interface ApiSetup {
  listener: RequestListener;
  enabled: boolean;
  /** Powod wylaczenia — do wypisania przy starcie. `null` gdy API dziala. */
  disabledReason: string | null;
}

function clientIp(headers: Headers): string {
  return headers.get('cf-connecting-ip') ?? headers.get('x-forwarded-for') ?? 'nieznane';
}

export function createApiSetup(): ApiSetup {
  const app = new Hono();
  const userId = apiUserId();

  let disabledReason: string | null = null;
  if (!isApiEnabled()) {
    disabledReason = 'brak API_TOKEN w .env';
  } else if (!userId) {
    disabledReason =
      'nie wiadomo, do kogo należy API_TOKEN — ustaw API_TELEGRAM_ID ' +
      'albo zostaw dokładnie jeden wpis w ALLOWED_TELEGRAM_IDS';
  }

  // --- Autoryzacja ----------------------------------------------------------
  // Rejestrowana PRZED trasami, inaczej Hono jej dla nich nie uruchomi.
  app.use('/api/*', async (c, next) => {
    if (disabledReason !== null) {
      console.warn(`[API] odrzucone: ${disabledReason}`);
      return c.body(null, 503);
    }

    if (!isValidApiToken(c.req.header('authorization'))) {
      // Log bez tokena — inaczej sekret laduje w `docker compose logs`.
      console.warn(`[API 401] ${c.req.method} ${c.req.path} ip=${clientIp(c.req.raw.headers)}`);
      return c.body(null, 401);
    }

    await next();
  });

  // Puste `userId` jest juz odsiane przez `disabledReason`, ale kompilator
  // o tym nie wie — a rzutowanie `as` bylo by obietnica bez pokrycia.
  registerReadRoutes(app, userId ?? '');

  app.notFound((c) => c.json({ error: 'Nie ma takiego endpointu.' }, 404));

  /**
   * Odpowiednik `bot.catch()` dla HTTP. Nigdy nie polykamy wyjatku cicho —
   * pelny slad idzie do logow, klient dostaje 500 bez szczegolow.
   */
  app.onError((err, c) => {
    console.error(`[API 500] ${c.req.method} ${c.req.path}`, err);
    return c.json({ error: 'Błąd po stronie serwera.' }, 500);
  });

  return {
    listener: getRequestListener(app.fetch),
    enabled: disabledReason === null,
    disabledReason,
  };
}

/** Prefiks, ktory `server.ts` przekierowuje tutaj. */
export const API_PREFIX = '/api/';
