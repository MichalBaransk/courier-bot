import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { courierLocations } from '../db/schema.js';
import { CFG } from '../config.js';
import {
  czasZapisu,
  czyAktualna,
  czyGodnaZaufania,
  czyPoprawneWspolrzedne,
  mozliwyBladM,
  wiekSekund,
  type ZrodloLokalizacji,
} from './lokalizacja.rules.js';

/**
 * Ostatnia znana pozycja kuriera.
 *
 * Cala arytmetyka swiezosci siedzi w `lokalizacja.rules.ts` (bez bazy, wiec
 * pod testem). Tutaj zostaje wylacznie rozmowa z Postgresem i parsowanie —
 * `numeric` wraca jako string (9b).
 */

export interface ZapisLokalizacji {
  lat: number;
  lon: number;
  /** Promien niepewnosci GPS w metrach. */
  dokladnoscM?: number | null;
  /** Ile ms uplynelo od zlapania pozycji do wyslania. Patrz `czasZapisu`. */
  wiekMs?: number | null;
  /** Predkosc w m/s w chwili odczytu. Od niej zalezy, jak szybko pozycja traci wartosc. */
  predkoscMps?: number | null;
  zrodlo?: ZrodloLokalizacji;
}

export interface Lokalizacja {
  lat: number;
  lon: number;
  dokladnoscM: number | null;
  predkoscMps: number | null;
  zrodlo: ZrodloLokalizacji;
  /** Kiedy pozycja zostala ZLAPANA, w ms epoch. */
  zapisanoMs: number;
  /** Wiek w pelnych sekundach na moment odczytu. */
  wiekS: number;
  /**
   * Ile metrow moze wynosic blad TERAZ: niepewnosc odczytu + predkosc x wiek.
   * To jest liczba, ktora decyduje o zaufaniu — nie sam wiek.
   */
  mozliwyBladM: number;
}

class LokalizacjaService {
  /**
   * Zapisuje pozycje, nadpisujac poprzednia.
   *
   * Zwraca `false`, gdy wspolrzedne nie maja sensu — wtedy STARA pozycja
   * zostaje nietknieta. To celowe: lepiej zostac ze znana pozycja sprzed
   * minuty niz zastapic ja zerami z niezainicjowanej struktury (8f).
   *
   * `ensureUser` NIE jest tu wolane — robi to warstwa wyzej. Cache istnienia
   * wiersza w pamieci procesu juz raz zjadl nam inserty po `DROP SCHEMA` (9e),
   * wiec ten serwis celowo nic o uzytkownikach nie zaklada.
   */
  async zapisz(telegramId: string | number, dane: ZapisLokalizacji): Promise<boolean> {
    if (!czyPoprawneWspolrzedne(dane.lat, dane.lon)) return false;

    const tId = String(telegramId);
    const recordedAt = new Date(czasZapisu(Date.now(), dane.wiekMs ?? null));
    const zrodlo: ZrodloLokalizacji = dane.zrodlo ?? 'APP';

    const dokladnosc =
      dane.dokladnoscM != null && Number.isFinite(dane.dokladnoscM)
        ? Math.round(Math.max(0, dane.dokladnoscM))
        : null;

    // Android potrafi oddac `-1` zamiast `null`, gdy predkosci nie zna.
    // Zapisujemy wtedy `null`, zeby warstwa regul mogla siegnac po ostrozne
    // zalozenie zamiast liczyc z liczby, ktora nic nie znaczy.
    const predkosc =
      dane.predkoscMps != null && Number.isFinite(dane.predkoscMps) && dane.predkoscMps >= 0
        ? dane.predkoscMps.toFixed(2)
        : null;

    const wiersz = {
      telegramId: tId,
      latitude: dane.lat.toFixed(6),
      longitude: dane.lon.toFixed(6),
      accuracyM: dokladnosc,
      speedMps: predkosc,
      source: zrodlo,
      recordedAt,
      updatedAt: new Date(),
    };

    await db
      .insert(courierLocations)
      .values(wiersz)
      .onConflictDoUpdate({
        target: courierLocations.telegramId,
        set: {
          latitude: wiersz.latitude,
          longitude: wiersz.longitude,
          accuracyM: wiersz.accuracyM,
          speedMps: wiersz.speedMps,
          source: wiersz.source,
          recordedAt: wiersz.recordedAt,
          updatedAt: wiersz.updatedAt,
        },
      });

    return true;
  }

  /** Ostatnia zapisana pozycja, bez oceny swiezosci. `null` = nigdy nie bylo. */
  async ostatnia(telegramId: string | number): Promise<Lokalizacja | null> {
    const tId = String(telegramId);
    const [wiersz] = await db
      .select()
      .from(courierLocations)
      .where(eq(courierLocations.telegramId, tId))
      .limit(1);

    if (!wiersz) return null;

    const zapisanoMs = wiersz.recordedAt.getTime();
    const wiekS = wiekSekund(zapisanoMs, Date.now());
    const predkoscMps = wiersz.speedMps != null ? parseFloat(wiersz.speedMps) : null;
    const dokladnoscM = wiersz.accuracyM;

    return {
      lat: parseFloat(wiersz.latitude),
      lon: parseFloat(wiersz.longitude),
      dokladnoscM,
      predkoscMps,
      zrodlo: wiersz.source === 'TELEGRAM' ? 'TELEGRAM' : 'APP',
      zapisanoMs,
      wiekS,
      mozliwyBladM: mozliwyBladM({ wiekS, predkoscMps, dokladnoscM }),
    };
  }

  /**
   * Pozycja na tyle wiarygodna, zeby liczyc z niej dojazd — albo `null`.
   *
   * DWIE ROZNE MIARY, bo to dwie rozne rzeczy:
   *
   *   - `APP` — odczyt automatyczny. Liczy sie MOZLIWY BLAD W METRACH
   *     (niepewnosc + predkosc x wiek), nie sam czas. Przy 100 km/h pozycja
   *     sprzed minuty jest o 1,7 km obok i zadna liczba sekund tego nie widzi.
   *   - `TELEGRAM` — pinezka przypieta RECZNIE, bez predkosci. Kurier wysyla
   *     ja swiadomie tuz przed ocena oferty, wiec zostaje przy starym,
   *     szerokim oknie czasu (`CFG.LOCATION_MAX_AGE_MS`). Inaczej dotychczasowy
   *     sposob pracy przestalby dzialac z dnia na dzien.
   */
  async swieza(telegramId: string | number): Promise<Lokalizacja | null> {
    const loc = await this.ostatnia(telegramId);
    if (!loc) return null;

    if (loc.zrodlo === 'TELEGRAM') {
      const ttlS = Math.round(CFG.LOCATION_MAX_AGE_MS / 1000);
      return czyAktualna(loc.zapisanoMs, Date.now(), ttlS) ? loc : null;
    }

    const godna = czyGodnaZaufania(
      { wiekS: loc.wiekS, predkoscMps: loc.predkoscMps, dokladnoscM: loc.dokladnoscM },
      CFG.LOKALIZACJA_MAKS_BLAD_M,
      CFG.LOKALIZACJA_ZAPORA_S
    );

    return godna ? loc : null;
  }
}

export const lokalizacjaService = new LokalizacjaService();
