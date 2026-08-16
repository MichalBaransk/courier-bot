import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import { financeService } from '../services/finance.service.js';
import { ensureUserById } from '../services/user.service.js';
import {
  BruttoSchema,
  CelSchema,
  DystansSchema,
  NapiwekSchema,
  PaliwoSchema,
  UsunSchema,
  ZmianaSchema,
  pierwszyBlad,
} from './schemas.js';

/**
 * Endpointy REST do ZAPISU (krok 3a planu aplikacji mobilnej).
 *
 * Zasada: JEDEN ENDPOINT = JEDEN ZAPIS. Nie ma zbiorczego „zapisz wszystko",
 * bo przy kolejce offline (krok 3b) jeden element kolejki musi odpowiadać
 * jednej operacji. Przy zbiorczym wpisie odrzucenie jednego pola stawia
 * pytanie, co zrobić z resztą, i nie ma na nie dobrej odpowiedzi.
 *
 * Każdy zapis idzie przez TEN SAM serwis co bot, więc reguły biznesowe z §8
 * obowiązują w obu klientach bez duplikacji logiki.
 *
 * IDEMPOTENCJA — od kroku 5 jest, ale trzeba o nią poprosić.
 * `saveCashTip` i `saveFuelReceipt` to nadal czyste `INSERT` (celowo: drugie
 * tankowanie tego samego dnia ma się dodawać, FIX 2.8), więc powtórzone
 * żądanie BEZ nagłówka `Idempotency-Key` utworzy DRUGI wpis. Z nagłówkiem
 * operacja wykona się raz, a każde ponowienie dostanie zapamiętaną odpowiedź.
 * Szczegóły i powód: `src/api/idempotency.ts`.
 *
 * Same trasy nic o tym nie wiedzą — cała obsługa siedzi w middleware
 * zarejestrowanym w `router.ts`. To celowe: dopisanie nowego endpointu zapisu
 * nie wymaga pamiętania o idempotencji.
 */

/** Wspólny kształt odpowiedzi wszystkich zapisów: stan dnia po zmianie. */
interface OdpowiedzZapisu {
  dzien: Awaited<ReturnType<typeof financeService.getDailySummary>>;
  /** Komunikat z `calculateHours` — np. zmiana dłuższa niż 16 h (§8d). */
  ostrzezenie: string | null;
}

type Wynik<T> = { ok: true; wartosc: T } | { ok: false; komunikat: string };

async function czytajCialo<T>(c: Context, schemat: z.ZodType<T>): Promise<Wynik<T>> {
  let surowe: unknown;
  try {
    surowe = await c.req.json();
  } catch {
    return { ok: false, komunikat: 'Ciało żądania nie jest poprawnym JSON-em.' };
  }

  const wynik = schemat.safeParse(surowe);
  if (!wynik.success) {
    return { ok: false, komunikat: pierwszyBlad(wynik) ?? 'Nieprawidłowe dane.' };
  }
  return { ok: true, wartosc: wynik.data };
}

export function registerWriteRoutes(app: Hono, userId: string): void {
  /**
   * Data wpisu wyznaczana PO STRONIE SERWERA, gdy klient jej nie poda.
   * Telefon może mieć przestawiony zegar albo złą strefę, a doba kończy się
   * o północy w Europe/Warsaw (§8a). Serwer jest tu jedynym źródłem prawdy.
   */
  const dzien = (podana: string | null): string => podana ?? financeService.getEffectiveDate();

  /** FK z wszystkich tabel stoi na `users.telegram_id` — wiersz musi istnieć. */
  const odpowiedz = async (c: Context, date: string, ostrzezenie: string | null) => {
    const body: OdpowiedzZapisu = {
      dzien: await financeService.getDailySummary(userId, date),
      ostrzezenie,
    };
    return c.json(body, 201);
  };

  app.post('/api/v1/napiwek', async (c) => {
    const w = await czytajCialo(c, NapiwekSchema);
    if (!w.ok) return c.json({ error: w.komunikat }, 400);

    const date = dzien(w.wartosc.data);
    await ensureUserById(userId);
    await financeService.saveCashTip(userId, date, w.wartosc.kwota);
    return odpowiedz(c, date, null);
  });

  app.post('/api/v1/paliwo', async (c) => {
    const w = await czytajCialo(c, PaliwoSchema);
    if (!w.ok) return c.json({ error: w.komunikat }, 400);

    const date = dzien(w.wartosc.data);
    await ensureUserById(userId);
    await financeService.saveFuelReceipt(userId, date, {
      totalCost: w.wartosc.kwota,
      liters: w.wartosc.litry,
      pricePerLiter: w.wartosc.cenaZaLitr,
    });
    return odpowiedz(c, date, null);
  });

  app.post('/api/v1/dystans', async (c) => {
    const w = await czytajCialo(c, DystansSchema);
    if (!w.ok) return c.json({ error: w.komunikat }, 400);

    const date = dzien(w.wartosc.data);
    await ensureUserById(userId);
    await financeService.setDailyDistance(userId, date, w.wartosc.km);
    return odpowiedz(c, date, null);
  });

  app.post('/api/v1/brutto', async (c) => {
    const w = await czytajCialo(c, BruttoSchema);
    if (!w.ok) return c.json({ error: w.komunikat }, 400);

    const date = dzien(w.wartosc.data);
    await ensureUserById(userId);
    await financeService.setGrossEarnings(userId, date, w.wartosc.kwota);
    return odpowiedz(c, date, null);
  });

  app.post('/api/v1/zmiana', async (c) => {
    const w = await czytajCialo(c, ZmianaSchema);
    if (!w.ok) return c.json({ error: w.komunikat }, 400);

    const date = dzien(w.wartosc.data);
    await ensureUserById(userId);

    let ostrzezenie: string | null = null;

    // Kolejność ma znaczenie: `setShiftEnd` przelicza godziny dopiero wtedy,
    // gdy `workFrom` jest już w bazie. Odwrotnie wynik byłby pusty.
    if (w.wartosc.od !== null) {
      const r = await financeService.setShiftStart(userId, date, w.wartosc.od);
      ostrzezenie = r.hoursError;
    }
    if (w.wartosc.do !== null) {
      const r = await financeService.setShiftEnd(userId, date, { workTo: w.wartosc.do });
      ostrzezenie = r.hoursError;
    }

    return odpowiedz(c, date, ostrzezenie);
  });

  /** Cel zarobkowy na bieżący miesiąc albo tydzień ISO (§8e). */
  app.post('/api/v1/cel', async (c) => {
    const w = await czytajCialo(c, CelSchema);
    if (!w.ok) return c.json({ error: w.komunikat }, 400);

    await ensureUserById(userId);
    const zapisany = await financeService.setEarningTarget(userId, w.wartosc.okres, w.wartosc.kwota);
    const postep = await financeService.getTargetProgress(userId, w.wartosc.okres);
    return c.json({ zapisany, postep }, 201);
  });

  /**
   * Kasowanie wpisów — ta sama ścieżka co kasowanie głosem w bocie.
   *
   * `POST`, nie `DELETE`, bo potrzebne jest ciało z zakresem i datą, a `DELETE`
   * z ciałem bywa gubione przez pośredniki. Nazwa endpointu mówi wprost, co robi.
   */
  app.post('/api/v1/usun', async (c) => {
    const w = await czytajCialo(c, UsunSchema);
    if (!w.ok) return c.json({ error: w.komunikat }, 400);

    const wynik = await financeService.handleVoiceDeletion(userId, w.wartosc.cel, w.wartosc.data);
    return c.json({
      usuniete: wynik.success,
      komunikat: wynik.message,
      dzien: await financeService.getDailySummary(userId, wynik.date),
    });
  });
}
