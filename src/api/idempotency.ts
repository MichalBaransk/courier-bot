import type { Context, Next } from 'hono';
import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { apiIdempotency } from '../db/schema.js';
import {
  czyPorzucony,
  czyZapamietac,
  normalizujKlucz,
  RETENCJA_H,
  SPRZATAJ_CO,
} from './idempotency.rules.js';

/**
 * Idempotencja zapisow — jeden klucz, jedno wykonanie.
 *
 * PO CO TO JEST. Kolejka offline w aplikacji ponawia zadania, ktore nie
 * doszly. Bez tej warstwy kazde ponowienie `POST /api/v1/napiwek` tworzyloby
 * DRUGI wiersz, bo `saveCashTip` to czysty `INSERT` (celowo — drugie
 * tankowanie tego samego dnia ma sie dodawac, FIX 2.8). Kolejka bez
 * idempotencji jest wiec GORSZA niz jej brak: zamiast utraty wpisu dostajemy
 * cicha inflacje danych, ktorej nikt nie zauwazy.
 *
 * To nie jest problem wylacznie trybu offline. Juz dzis dwukrotne dotkniecie
 * „Zapisz" przy wolnej sieci daje dwa napiwki: przycisk blokuje sie na czas
 * zadania, ale timeout to 10 s, a po nim uzytkownik naciska ponownie.
 *
 * KONTRAKT. Naglowek `Idempotency-Key` jest OPCJONALNY:
 *  - brak naglowka  -> zachowanie dokladnie takie jak dotad (bot, curl,
 *    starsza wersja aplikacji nie zauwaza zmiany),
 *  - ten sam klucz drugi raz -> operacja NIE jest wykonywana, wraca
 *    zapamietana odpowiedz z oryginalnym kodem statusu.
 *
 * Kluczem jest UUID od klienta, a NIE skrot tresci. Skrot sklejalby dwa
 * swiadome, identyczne napiwki po 5 zl w jeden — a to jest poprawny scenariusz.
 *
 * Reguly (walidacja klucza, progi czasowe) siedza w `idempotency.rules.ts`,
 * zeby dalo sie je przetestowac bez bazy.
 */

/* ========================================================================== */
/*  Middleware                                                                */
/* ========================================================================== */

let odSprzatania = 0;

/**
 * Sprzatanie w wariancie „przy okazji" (uzgodnione: A, nie cron).
 *
 * Bez wlasnej infrastruktury i bez kolejnego zadania w kontenerze backupu.
 * Blad sprzatania nigdy nie moze wywrocic zapisu — stad `catch` i sam log.
 */
async function sprzatnijCzasem(): Promise<void> {
  odSprzatania += 1;
  if (odSprzatania < SPRZATAJ_CO) return;
  odSprzatania = 0;

  try {
    await db
      .delete(apiIdempotency)
      .where(lt(apiIdempotency.createdAt, sql`now() - interval '${sql.raw(String(RETENCJA_H))} hours'`));
  } catch (err) {
    console.error('[API idempotencja] sprzatanie nie powiodlo sie', err);
  }
}

async function zwolnij(klucz: string): Promise<void> {
  try {
    await db.delete(apiIdempotency).where(eq(apiIdempotency.key, klucz));
  } catch (err) {
    console.error('[API idempotencja] nie udalo sie zwolnic klucza', err);
  }
}

/**
 * Middleware do rejestracji w `router.ts` PO autoryzacji i PRZED trasami.
 *
 * Kolejnosc ma znaczenie dokladnie tak samo jak przy handlerach Telegrafa
 * (10a): middleware zarejestrowany po trasach w Hono w ogole sie dla nich
 * nie uruchomi, i to bez zadnego bledu.
 */
export function idempotencja(userId: string) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    // Odczyty sa idempotentne z natury — nie ma czego pilnowac.
    if (c.req.method !== 'POST') return next();

    const klucz = normalizujKlucz(c.req.header('idempotency-key'));
    if (klucz === null) return next();

    /**
     * ZAJMIJ KLUCZ, POTEM PRACUJ.
     *
     * Naiwna kolejnosc „sprawdz -> wykonaj -> zapisz" ma okno miedzy
     * sprawdzeniem a zapisem. Przy podwojnym dotknieciu przycisku to okno
     * realnie sie otwiera. `ON CONFLICT DO NOTHING` przenosi rozstrzygniecie
     * do bazy, gdzie jest atomowe.
     */
    let zajety: { key: string }[];
    try {
      zajety = await db
        .insert(apiIdempotency)
        .values({
          key: klucz,
          telegramId: userId,
          endpoint: c.req.path,
          statusCode: 0,
          responseJson: '',
        })
        .onConflictDoNothing()
        .returning({ key: apiIdempotency.key });
    } catch (err) {
      // Awaria tabeli idempotencji nie moze uniemozliwic zapisu danych.
      // Lepiej ryzykowac duplikat niz stracic wpis kuriera.
      console.error('[API idempotencja] nie udalo sie zajac klucza — przepuszczam', err);
      return next();
    }

    if (zajety.length === 0) {
      const [istniejacy] = await db
        .select()
        .from(apiIdempotency)
        .where(eq(apiIdempotency.key, klucz))
        .limit(1);

      // Wiersz zniknal miedzy INSERT-em a SELECT-em (rownolegle sprzatanie
      // albo zwolnienie po bledzie). Traktujemy to jak zwykle zadanie.
      if (!istniejacy) return next();

      if (czyZapamietac(istniejacy.statusCode)) {
        console.log(`[API idempotencja] powtorka ${c.req.path} klucz=${klucz}`);
        return new Response(istniejacy.responseJson, {
          status: istniejacy.statusCode,
          headers: {
            'content-type': 'application/json; charset=UTF-8',
            'idempotent-replay': 'true',
          },
        });
      }

      if (!czyPorzucony(istniejacy.createdAt, new Date())) {
        return c.json(
          { error: 'Poprzednia próba tego zapisu jeszcze się nie zakończyła. Spróbuj za chwilę.' },
          409
        );
      }

      // Porzucony wiersz przejmujemy: odswiezamy znacznik czasu, zeby drugie
      // ponowienie nie przejelo go natychmiast raz jeszcze.
      await db
        .update(apiIdempotency)
        .set({ createdAt: new Date(), statusCode: 0, responseJson: '' })
        .where(and(eq(apiIdempotency.key, klucz), eq(apiIdempotency.statusCode, 0)));
    }

    try {
      await next();
    } catch (err) {
      await zwolnij(klucz);
      throw err;
    }

    const status = c.res.status;
    if (!czyZapamietac(status)) {
      // 5xx — ponowienie musi miec szanse.
      await zwolnij(klucz);
      return;
    }

    let tresc = '';
    try {
      tresc = await c.res.clone().text();
    } catch (err) {
      console.error('[API idempotencja] nie udalo sie odczytac odpowiedzi', err);
      await zwolnij(klucz);
      return;
    }

    await db
      .update(apiIdempotency)
      .set({ statusCode: status, responseJson: tresc })
      .where(eq(apiIdempotency.key, klucz));

    await sprzatnijCzasem();
  };
}
