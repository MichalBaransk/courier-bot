import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import { CFG } from '../config.js';
import { financeService } from '../services/finance.service.js';
import { ensureUserById } from '../services/user.service.js';
import { lokalizacjaService } from '../services/lokalizacja.service.js';
import { nowTimeWarsaw } from '../utils/datetime.js';
import {
  BruttoSchema,
  CelSchema,
  DystansSchema,
  LokalizacjaSchema,
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

  /**
   * Pozycja kuriera. JEDYNY endpoint zapisu, ktory NIE zwraca stanu dnia.
   *
   * Powod: pozycja nie jest wpisem do rozliczenia, tylko stanem chwilowym.
   * Doklejanie do kazdej odpowiedzi podsumowania dnia oznaczaloby kilka
   * zapytan do bazy co 20 sekund przez cala zmiane, bez zadnego pozytku —
   * aplikacja i tak tej odpowiedzi nie wyswietla.
   *
   * Nie przechodzi tez sensownie przez idempotencje: `Idempotency-Key` nie ma
   * tu czego chronic, bo zapis jest upsertem i powtorzenie go nic nie psuje.
   * Aplikacja po prostu nie wysyla tego naglowka.
   *
   * `false` z serwisu znaczy „wspolrzedne bez sensu" — wtedy STARA pozycja
   * zostaje nietknieta i odpowiadamy 400. Lepiej zostac ze znana pozycja
   * sprzed minuty niz zastapic ja zerami (§8f).
   */
  app.post('/api/v1/lokalizacja', async (c) => {
    const w = await czytajCialo(c, LokalizacjaSchema);
    if (!w.ok) return c.json({ error: w.komunikat }, 400);

    await ensureUserById(userId);
    const zapisano = await lokalizacjaService.zapisz(userId, {
      lat: w.wartosc.lat,
      lon: w.wartosc.lon,
      dokladnoscM: w.wartosc.dokladnoscM,
      wiekMs: w.wartosc.wiekMs,
      predkoscMps: w.wartosc.predkoscMps,
      zrodlo: 'APP',
    });

    if (!zapisano) {
      return c.json({ error: 'Wspolrzedne poza zakresem albo dokladne (0, 0).' }, 400);
    }

    // Serwer oddaje SWOJ budzet bledu, zeby aplikacja nie musiala go zgadywac
    // ani powtarzac w swoim kodzie. Zmiana `LOKALIZACJA_MAKS_BLAD_M` w `.env`
    // przestawia obie strony naraz.
    //
    // Aplikacja moze z tego wyliczyc wlasny odstep miedzy odczytami: przy
    // predkosci `v` pozycja starzeje sie po `budzet / v` sekundach.
    return c.json(
      {
        zapisano: true,
        maksBladM: CFG.LOKALIZACJA_MAKS_BLAD_M,
        zaporaS: CFG.LOKALIZACJA_ZAPORA_S,
      },
      201
    );
  });

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

  /**
   * Zmiana pracy. Cztery przypadki w jednym endpoincie, rozstrzygane tym,
   * co przyszło w ciele:
   *
   * | `id` | `od` | `do` | co robi                                    |
   * |------|------|------|--------------------------------------------|
   * |  ✓   |  ✓   |  ✓   | poprawia wskazaną zmianę                   |
   * |      |  ✓   |  ✓   | dopisuje kompletną zmianę (także wstecz)   |
   * |      |  ✓   |      | otwiera zmianę                             |
   * |      |      |  ✓   | zamyka otwartą                             |
   *
   * `409` znaczy „jest już otwarta zmiana" i jest oddzielone od `400`
   * celowo: to nie jest błąd danych, tylko stan, w którym aplikacja ma
   * pokazać przycisk „zamknij tamtą" zamiast komunikatu o złym wpisie.
   */
  app.post('/api/v1/zmiana', async (c) => {
    const w = await czytajCialo(c, ZmianaSchema);
    if (!w.ok) return c.json({ error: w.komunikat }, 400);

    const date = dzien(w.wartosc.data);
    await ensureUserById(userId);

    // `TERAZ` rozwijamy TUTAJ, zegarem serwera — patrz `godzinaLubTeraz`.
    const godzina = (v: string | null): string | null =>
      v === null ? null : v.trim().toUpperCase() === 'TERAZ' ? nowTimeWarsaw() : v;

    const od = godzina(w.wartosc.od);
    const doGodz = godzina(w.wartosc.do);

    // Poprawka wskazanej zmiany. Schemat gwarantuje, ze przy `id` sa obie godziny.
    if (w.wartosc.id !== null && od !== null && doGodz !== null) {
      const r = await financeService.zapiszSesje(userId, date, { id: w.wartosc.id, od, do: doGodz, zrodlo: 'APP' });
      if (r.blad) return c.json({ error: r.blad }, 400);
      return odpowiedz(c, date, null);
    }

    // Kompletna zmiana dopisana jednym zadaniem — formularz, takze wstecz.
    if (od !== null && doGodz !== null) {
      const r = await financeService.zapiszSesje(userId, date, { od, do: doGodz, zrodlo: 'APP' });
      if (r.blad) return c.json({ error: r.blad }, 400);
      return odpowiedz(c, date, null);
    }

    if (od !== null) {
      // Sprawdzamy PRZED zapisem, zeby odroznic 409 od 400 bez czytania
      // tresci komunikatu. Kod odpowiedzi jest kontraktem, komunikat nie.
      const otwarta = await financeService.otwartaSesja(userId);
      if (otwarta) {
        return c.json(
          {
            error:
              otwarta.date === date
                ? `Zmiana od ${otwarta.od} już trwa — najpierw ją zamknij.`
                : `Nie zamknięto zmiany z ${otwarta.date} (od ${otwarta.od}). Zamknij ją albo usuń.`,
            otwarta,
          },
          409
        );
      }
      const r = await financeService.otworzSesje(userId, date, od, 'APP');
      if (r.blad) return c.json({ error: r.blad }, 400);
      return odpowiedz(c, date, null);
    }

    const r = await financeService.zamknijSesje(userId, doGodz!);
    if (r.blad) return c.json({ error: r.blad }, 400);
    return odpowiedz(c, date, null);
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

    // Kasowanie WSKAZANEJ zmiany nie przechodzi przez `handleVoiceDeletion`,
    // bo tamta funkcja operuje na dniu, a nie na wierszu. Schemat gwarantuje,
    // ze przy `SHIFT` jest `sesjaId`.
    if (w.wartosc.cel === 'SHIFT' && w.wartosc.sesjaId !== null) {
      const date = dzien(w.wartosc.data);
      const usunieta = await financeService.usunSesje(userId, w.wartosc.sesjaId);
      return c.json({
        usuniete: usunieta,
        komunikat: usunieta
          ? `Usunięto zmianę nr ${w.wartosc.sesjaId}.`
          : `Nie ma zmiany o numerze ${w.wartosc.sesjaId}.`,
        dzien: await financeService.getDailySummary(userId, date),
      });
    }

    const wynik = await financeService.handleVoiceDeletion(
      userId,
      w.wartosc.cel as Exclude<typeof w.wartosc.cel, 'SHIFT'>,
      w.wartosc.data
    );
    return c.json({
      usuniete: wynik.success,
      komunikat: wynik.message,
      dzien: await financeService.getDailySummary(userId, wynik.date),
    });
  });
}
