import type { Hono } from 'hono';
import { financeService } from '../services/finance.service.js';
import { daysBetween, isValidDateStr } from '../utils/datetime.js';
import { CFG } from '../config.js';

/**
 * Endpointy REST do ODCZYTU (krok 1 planu aplikacji mobilnej).
 *
 * Zadna z tych sciezek nic nie zapisuje — blad tutaj to zla liczba na ekranie,
 * a nie uszkodzony wiersz w bazie. Zapisy dochodza dopiero w kroku 3.
 *
 * Wszystkie kwoty wracaja jako LICZBY, nie stringi: `getDailySummary` i
 * `getPeriodSummary` przepuszczaja `numeric` przez `parseFloat` (patrz 9b),
 * a `listCourseOffers` robi to samo dla swoich kolumn.
 *
 * Daty sa zawsze `YYYY-MM-DD` w strefie Europe/Warsaw. Nigdzie nie ma
 * `toISOString()` na dacie lokalnej.
 */

/** Gorna granica zakresu raportu. Bez tego `?od=1970-01-01` ciagnie wszystko. */
const MAX_RANGE_DAYS = 400;
const MAX_OFFERS_LIMIT = 500;
const DEFAULT_OFFERS_LIMIT = 100;

interface RangeOk {
  ok: true;
  od: string;
  do: string;
}
interface RangeErr {
  ok: false;
  message: string;
}

function parseRange(odRaw: string | undefined, doRaw: string | undefined): RangeOk | RangeErr {
  if (!isValidDateStr(odRaw)) {
    return { ok: false, message: 'Parametr "od" musi być datą w formacie YYYY-MM-DD.' };
  }
  if (!isValidDateStr(doRaw)) {
    return { ok: false, message: 'Parametr "do" musi być datą w formacie YYYY-MM-DD.' };
  }
  const span = daysBetween(odRaw, doRaw);
  if (span < 0) {
    return { ok: false, message: 'Parametr "od" jest późniejszy niż "do".' };
  }
  if (span > MAX_RANGE_DAYS) {
    return { ok: false, message: `Zakres przekracza ${MAX_RANGE_DAYS} dni.` };
  }
  return { ok: true, od: odRaw, do: doRaw };
}

function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_OFFERS_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_OFFERS_LIMIT) return null;
  return n;
}

export function registerReadRoutes(app: Hono, userId: string): void {
  /** Metadane — pozwalaja aplikacji sprawdzic, czy gada z tym, czym myśli. */
  app.get('/api/v1/info', (c) =>
    c.json({
      api: 'v1',
      tz: CFG.TZ,
      nettoFactor: CFG.NETTO_FACTOR,
      minStawkaNettoKm: CFG.MIN_STAWKA_NETTO_KM,
      dzisiaj: financeService.getEffectiveDate(),
    })
  );

  /** Podsumowanie dnia dzisiejszego (data wyznaczana po stronie serwera). */
  app.get('/api/v1/dzien', async (c) => {
    const date = financeService.getEffectiveDate();
    return c.json(await financeService.getDailySummary(userId, date));
  });

  /** Podsumowanie wybranego dnia. */
  app.get('/api/v1/dzien/:data', async (c) => {
    const date = c.req.param('data');
    if (!isValidDateStr(date)) {
      return c.json({ error: 'Data musi być w formacie YYYY-MM-DD.' }, 400);
    }
    return c.json(await financeService.getDailySummary(userId, date));
  });

  /** Podsumowanie zakresu dat — pod tydzien, miesiac i wykresy. */
  app.get('/api/v1/okres', async (c) => {
    const range = parseRange(c.req.query('od'), c.req.query('do'));
    if (!range.ok) return c.json({ error: range.message }, 400);

    return c.json(await financeService.getPeriodSummary(userId, range.od, range.do));
  });

  /** Saldo Portfela Glovo = suma transakcji ze znakiem. */
  app.get('/api/v1/saldo', async (c) => {
    const doDate = c.req.query('do');
    if (doDate !== undefined && !isValidDateStr(doDate)) {
      return c.json({ error: 'Parametr "do" musi być datą w formacie YYYY-MM-DD.' }, 400);
    }
    const wallet =
      doDate === undefined
        ? await financeService.getWalletBalance(userId)
        : await financeService.getWalletBalance(userId, doDate);

    return c.json(wallet);
  });

  /** Statystyki ofert z jednego dnia (to samo, co pokazuje /statystyki w bocie). */
  app.get('/api/v1/oferty/statystyki/:data', async (c) => {
    const date = c.req.param('data');
    if (!isValidDateStr(date)) {
      return c.json({ error: 'Data musi być w formacie YYYY-MM-DD.' }, 400);
    }
    return c.json(await financeService.getCourseOfferStats(userId, date));
  });

  /** Lista ofert — surowe pozycje pod wykresy w aplikacji. */
  app.get('/api/v1/oferty', async (c) => {
    const odRaw = c.req.query('od');
    const doRaw = c.req.query('do');

    if (odRaw !== undefined && !isValidDateStr(odRaw)) {
      return c.json({ error: 'Parametr "od" musi być datą w formacie YYYY-MM-DD.' }, 400);
    }
    if (doRaw !== undefined && !isValidDateStr(doRaw)) {
      return c.json({ error: 'Parametr "do" musi być datą w formacie YYYY-MM-DD.' }, 400);
    }
    if (odRaw !== undefined && doRaw !== undefined && daysBetween(odRaw, doRaw) < 0) {
      return c.json({ error: 'Parametr "od" jest późniejszy niż "do".' }, 400);
    }

    const limit = parseLimit(c.req.query('limit'));
    if (limit === null) {
      return c.json({ error: `Parametr "limit" musi być liczbą całkowitą 1-${MAX_OFFERS_LIMIT}.` }, 400);
    }

    const items = await financeService.listCourseOffers(userId, odRaw ?? null, doRaw ?? null, limit);
    return c.json({ items, count: items.length, limit });
  });
}
