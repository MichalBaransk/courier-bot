import { CFG } from '../config.js';
import { b, code, i, joinLines, km, progressBar, zl, zlSigned, SEPARATOR } from '../utils/format.js';
import type {
  CourseOfferStats,
  DailySummary,
  FinanceService,
  PeriodSummary,
  TargetProgress,
} from '../services/finance.service.js';
import type { VoiceExtractedData } from '../services/gemini.service.js';

/**
 * Wszystkie karty renderuja HTML (3.3). Kazda wartosc pochodzaca od uzytkownika
 * albo od modelu przechodzi przez `h()`.
 */

/** `⛽ Paliwo: 312.40 zł (48.20 L, śr. 6.48 zł/L)` */
function fuelLine(cost: number, liters: number, pricePerLiter: number | null): string {
  const details = [
    liters > 0 ? `${liters.toFixed(2)} L` : null,
    pricePerLiter != null ? `śr. ${pricePerLiter.toFixed(2)} zł/L` : null,
  ].filter((part): part is string => part !== null);

  return `⛽ ${b('Paliwo:')} ${b(zl(cost))}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
}

export function dailyCard(summary: DailySummary): string {
  return joinLines([
    `📅 ${b('Raport dzienny:')} ${code(summary.date)}`,
    '',
    `💰 ${b('Brutto:')} ${b(zl(summary.grossEarnings))}`,
    `💵 ${b(`Netto ze zleceń (${(CFG.NETTO_FACTOR * 100).toFixed(1)}%):`)} ${b(zl(summary.netEarnings))}`,
    `🪙 ${b('Napiwki gotówka:')} ${b(zlSigned(summary.cashTipsTotal))}`,
    `🏁 ${b('Zarobek łącznie netto:')} ${b(zl(summary.totalNetto))}`,
    summary.walletPayouts > 0 && `🏧 ${b('Wypłacone z portfela:')} ${b(`-${summary.walletPayouts.toFixed(2)} zł`)}`,
    `💳 ${b('Do przelewu:')} ${b(zl(summary.doPrzelewu))} ${i('(bez gotówki w kieszeni)')}`,
    '',
    summary.workHours > 0
      ? `⏱️ ${b('Czas pracy:')} ${code(`${summary.workFrom ?? '--:--'} - ${summary.workTo ?? '--:--'}`)} (${b(`${summary.workHours.toFixed(2)} h`)}) — stawka ${b(`${summary.hourlyRateNetto.toFixed(2)} zł/h`)}`
      : `⏱️ ${b('Czas pracy:')} ${i('brak pełnego wpisu')}`,
    summary.distanceKm != null
      ? `🚗 ${b('Dystans dnia:')} ${b(km(summary.distanceKm))}`
      : `🚗 ${b('Dystans dnia:')} ${i('brak wpisu')}`,
    '',
    summary.fuelCost > 0
      ? fuelLine(summary.fuelCost, summary.fuelLiters, summary.fuelPricePerLiter) +
        (summary.fuelReceiptCount > 1 ? ` ${i(`— ${summary.fuelReceiptCount} paragony`)}` : '')
      : `⛽ ${b('Paliwo:')} ${i('brak wpisu')}`,
  ]);
}

export function periodCard(
  title: string,
  summary: PeriodSummary,
  target: TargetProgress | null
): string {
  return joinLines([
    `📊 ${b(`${title} (${summary.startDate} – ${summary.endDate}):`)}`,
    '',
    `💰 ${b('Brutto:')} ${b(zl(summary.totalGross))}`,
    `💵 ${b('Netto ze zleceń:')} ${b(zl(summary.totalNettoEarnings))}`,
    `🪙 ${b('Napiwki gotówkowe:')} ${b(zlSigned(summary.totalCashTips))}`,
    `🏁 ${b('Zarobek łącznie netto:')} ${b(zl(summary.grandTotalNetto))}`,
    summary.totalWalletPayouts > 0 &&
      `🏧 ${b('Wypłacone z portfela:')} ${b(`-${summary.totalWalletPayouts.toFixed(2)} zł`)}`,
    `💳 ${b('Do przelewu:')} ${b(zl(summary.totalDoPrzelewu))}`,
    '',
    `⏱️ ${b('Godziny:')} ${b(`${summary.totalWorkHours.toFixed(2)} h`)} (śr. ${b(`${summary.avgHourlyRateNetto.toFixed(2)} zł netto/h`)})`,
    summary.totalDistanceKm > 0 && `🚗 ${b('Dystans:')} ${b(km(summary.totalDistanceKm))}`,
    summary.totalFuelCost > 0 && fuelLine(summary.totalFuelCost, summary.totalFuelLiters, summary.avgPricePerLiter),
    ...(target
      ? [
          '',
          SEPARATOR,
          `🎯 ${b('Cel:')} ${progressBar(target.progressPercent)} ${b(`${target.progressPercent.toFixed(1)}%`)}`,
          target.isCompleted
            ? `🏆 ${b('Cel osiągnięty!')} Nadwyżka ${b(zlSigned(target.currentNetto - target.targetAmount))}`
            : `⏳ Brakuje ${b(zl(target.remainingNetto))} (${b(`${target.dailyRequiredNetto.toFixed(2)} zł/dzień`)})`,
        ]
      : []),
  ]);
}

export function targetCard(progress: TargetProgress): string {
  const header = progress.periodType === 'MONTHLY' ? '🎯 <b>Miesięczny cel zarobkowy</b>' : '🎯 <b>Tygodniowy cel zarobkowy</b>';
  const bar = `${progressBar(progress.progressPercent)} ${b(`${progress.progressPercent.toFixed(1)}%`)}`;

  if (progress.isCompleted) {
    return joinLines([
      header,
      bar,
      '',
      `🏆 ${b('CEL OSIĄGNIĘTY!')}`,
      `💰 ${b('Zarobione netto:')} ${b(zl(progress.currentNetto))} / ${b(zl(progress.targetAmount))}`,
      `📈 ${b('Nadwyżka:')} ${b(zlSigned(progress.currentNetto - progress.targetAmount))}`,
    ]);
  }

  return joinLines([
    header,
    bar,
    '',
    `💰 ${b('Postęp:')} ${b(zl(progress.currentNetto))} z ${b(zl(progress.targetAmount))} netto`,
    `⏳ ${b('Brakuje:')} ${b(zl(progress.remainingNetto))}`,
    `📅 ${b('Pozostało dni:')} ${b(progress.daysRemaining)}`,
    '',
    `📊 ${b('Wymagane tempo:')}`,
    ` • Dziennie: ${b(`${progress.dailyRequiredNetto.toFixed(2)} zł netto / dzień`)}`,
    ` • Czas pracy: ${b(`~${progress.estimatedHoursRemaining.toFixed(1)} h`)} (${progress.hoursPerDayRequired.toFixed(1)} h / dzień)`,
    rateNote(progress),
  ]);
}

/**
 * Skąd wzięła się stawka użyta do prognozy godzin.
 *
 * Przy `PERIOD` nie piszemy nic — to stan normalny i linijka byłaby szumem.
 * Pozostałe dwa stany trzeba nazwać, bo prognoza opiera się wtedy na czymś
 * innym, niż użytkownik zakłada, patrząc na kartę tygodnia.
 */
function rateNote(progress: TargetProgress): string | false {
  if (progress.rateSource === 'ROLLING_30D') {
    return i(
      `Prognoza godzin liczona stawką ${progress.avgHourlyRate.toFixed(2)} zł/h ` +
        `— średnią z ostatnich 30 dni, bo w tym okresie nie ma jeszcze godzin.`
    );
  }
  if (progress.rateSource === 'FALLBACK') {
    return i(
      `Prognoza godzin liczona stawką zastępczą ${CFG.FALLBACK_HOURLY_RATE_NETTO.toFixed(2)} zł/h ` +
        `— brak własnej historii z ostatnich 30 dni.`
    );
  }
  return false;
}

export function startShiftCard(summary: DailySummary, balance: number, currentTime: string): string {
  return joinLines([
    `🚀 ${b('Rozpoczęcie zmiany')}`,
    `📅 ${b('Data:')} ${code(summary.date)}`,
    '',
    summary.workFrom
      ? `⏱️ ${b('Godzina wyjazdu:')} ${b(summary.workFrom)} ${i('(zapisano w bazie)')}`
      : `⏱️ ${b('Godzina wyjazdu:')} ${i(`nieustalona — teraz ${currentTime}`)}`,
    `💵 ${b('Portfel Glovo:')} ${b(zl(balance))}`,
    '',
    summary.workFrom ? i('Godzina wyjazdu jest zapisana.') : 'Wybierz godzinę startu poniżej:',
  ]);
}

export function endShiftCard(summary: DailySummary, balance: number, currentTime: string): string {
  return joinLines([
    `🏁 ${b('Zakończenie zmiany')}`,
    `📅 ${b('Data zmiany:')} ${code(summary.date)}`,
    '',
    `⏱️ ${b('Godziny pracy:')} ${code(`${summary.workFrom ?? '--:--'} - ${summary.workTo ?? '--:--'}`)} (${b(`${summary.workHours.toFixed(2)} h`)})`,
    `🚗 ${b('Dystans dnia:')} ${summary.distanceKm != null ? b(km(summary.distanceKm)) : i('brak')}`,
    `💰 ${b('Zarobek brutto:')} ${summary.grossEarnings > 0 ? b(zl(summary.grossEarnings)) : i('brak wpisu')}`,
    `💵 ${b('Zarobek łącznie netto:')} ${b(zl(summary.totalNetto))} (stawka ${b(`${summary.hourlyRateNetto.toFixed(2)} zł/h`)})`,
    `⛽ ${b('Paliwo dziś:')} ${
      summary.fuelCost > 0
        ? b(zl(summary.fuelCost)) + (summary.fuelReceiptCount > 1 ? ` ${i(`(${summary.fuelReceiptCount} paragony)`)}` : '')
        : i('brak wpisu')
    }`,
    `💼 ${b('Portfel Glovo:')} ${b(zl(balance))}`,
    '',
    summary.workTo ? i('Godzina zjazdu i rozliczenie są zapisane.') : i(`Ustaw godzinę zjazdu (teraz ${currentTime}) lub podaj dystans.`),
  ]);
}

export function offerStatsCard(stats: CourseOfferStats): string {
  const rate = (v: number | null) => (v == null ? i('brak') : b(`${v.toFixed(2)} zł/km`));

  return joinLines([
    `📊 ${b(`Statystyki ofert Glovo (${stats.date}):`)}`,
    '',
    `• ${b('Sprawdzonych zleceń:')} ${b(stats.totalOffers)}`,
    `• ✅ ${b(`Opłacalne (≥${CFG.MIN_STAWKA_NETTO_KM.toFixed(2)} zł/km):`)} ${b(stats.profitable)}`,
    `• ❌ ${b('Nieopłacalne:')} ${b(stats.unprofitable)}`,
    '',
    `📌 ${b('Decyzje kuriera:')}`,
    ` • 🟢 Zaakceptowane: ${b(stats.accepted)}`,
    ` • 🔴 Odrzucone: ${b(stats.rejected)}`,
    ` • ⚪ Bez decyzji: ${b(stats.pending)}`,
    '',
    // FIX (5.4): dwie metryki obok siebie, bo mowia o czym innym.
    `📈 ${b('Średnia z ofert:')} ${rate(stats.avgNetRatePerKm)} ${i('— jakie oferty przychodzą')}`,
    `⚖️ ${b('Średnia ważona:')} ${rate(stats.weightedNetRatePerKm)} ${i('— ile realnie wychodzi na km')}`,
    `🥇 ${b('Najlepsza:')} ${rate(stats.bestNetRate)}  |  🥉 ${b('Najgorsza:')} ${rate(stats.worstNetRate)}`,
    // Bez tej linijki różnica „sprawdzonych 7, a średnia z 5" jest niewidoczna
    // i wygląda jak błąd liczenia.
    stats.ratedOffers < stats.totalOffers &&
      i(
        `Stawki liczone z ${stats.ratedOffers} z ${stats.totalOffers} ofert — ` +
          `reszta nie miała dystansu (brak adresu klienta na ekranie oferty).`
      ),
    '',
    `🛣️ ${b('Łączny dystans ofert:')} ${b(km(stats.totalDistanceKm))}`,
    `💰 ${b('Suma stawek brutto:')} ${b(zl(stats.totalGross))}`,
  ]);
}

export interface OfferCardData {
  isProfitable: boolean;
  grossAmount: number;
  netAmount: number;
  pickupAddress: string;
  deliveryAddress: string;
  /** Dystans deklarowany przez aplikacje Glovo. */
  appPickupKm: number | null;
  appDeliveryKm: number | null;
  appTotalKm: number | null;
  /** Niezalezna kontrola Google Maps. */
  mapsPickupKm: number | null;
  mapsDeliveryKm: number | null;
  mapsTotalKm: number | null;
  mapsReason: string | null;
  mapsDeliveryReason: string | null;
  mapsAgeMin: number;
  /** Dystans uzyty do stawki i jego zrodlo. */
  totalKm: number;
  rateBasis: 'APP' | 'MAPS' | 'NONE';
  netRatePerKm: number;
  status?: 'PENDING' | 'ACCEPTED' | 'REJECTED';
}

const STATUS_LINE: Record<'PENDING' | 'ACCEPTED' | 'REJECTED', string> = {
  PENDING: `🔘 <b>Status:</b> <i>oczekuje na decyzję</i>`,
  ACCEPTED: `🟢 <b>Status: ZAAKCEPTOWANO</b>`,
  REJECTED: `🔴 <b>Status: ODRZUCONO</b>`,
};

/**
 * FIX (3.6): karta oferty jest renderowana od zera przy kazdej zmianie statusu.
 * Stary kod probowal doklejac linie statusu filtrujac tekst po `'🔘 Status:'`,
 * co nigdy nie trafialo (faktyczna linia miala gwiazdki: `🔘 *Status:*`),
 * wiec karta konczyla z dwiema liniami statusu.
 */
const leg = (value: number | null, note?: string | null): string =>
  value != null ? b(km(value, 2)) : i(note ?? 'brak');

/**
 * Karta oferty z ROZDZIELONYMI zrodlami dystansu.
 *
 * Aplikacja Glovo podaje oba odcinki i liczy je od biezacej pozycji kuriera —
 * to jest podstawa stawki. Google Maps sluzy wylacznie za kontrole dojazdu;
 * odcinka do klienta zwykle nie policzy, bo oferta nie ujawnia jego adresu.
 */
export function offerCard(data: OfferCardData): string {
  const status = data.status ?? 'PENDING';

  // Rozbieznosc dojazdu ma sens tylko gdy sa obie liczby.
  const pickupDelta =
    data.appPickupKm != null && data.mapsPickupKm != null ? data.mapsPickupKm - data.appPickupKm : null;
  const divergent = pickupDelta != null && Math.abs(pickupDelta) >= CFG.DISTANCE_DIVERGENCE_KM;

  const basisLabel: Record<OfferCardData['rateBasis'], string> = {
    APP: 'z aplikacji Glovo',
    MAPS: 'z Google Maps',
    NONE: 'brak danych o dystansie',
  };

  return joinLines([
    data.isProfitable ? b('✅ KURS OPŁACALNY') : b('❌ KURS SŁABY / ODRZUĆ'),
    '',
    `💵 ${b('Stawka:')} ${b(`${data.grossAmount.toFixed(2)} zł brutto`)} ➔ ${b(`${data.netAmount.toFixed(2)} zł netto`)}`,
    `📍 ${b('Odbiór:')} ${code(data.pickupAddress)}`,
    `🏠 ${b('Dostawa:')} ${code(data.deliveryAddress)}`,
    '',
    `📱 ${b('Dystans z aplikacji Glovo:')}`,
    ` • Odbiór: ${leg(data.appPickupKm)}`,
    ` • Dostawa: ${leg(data.appDeliveryKm)}`,
    ` • ${b('Suma:')} ${leg(data.appTotalKm)}`,
    '',
    `🗺️ ${b('Kontrola Google Maps:')}`,
    data.mapsReason
      ? ` • ${i(data.mapsReason)}`
      : joinLines([
          ` • Odbiór: ${leg(data.mapsPickupKm)}` +
            (pickupDelta != null ? ` ${i(`(${pickupDelta > 0 ? '+' : ''}${pickupDelta.toFixed(2)} km)`)}` : ''),
          ` • Dostawa: ${leg(data.mapsDeliveryKm, data.mapsDeliveryReason)}`,
          data.mapsTotalKm != null ? ` • ${b('Suma:')} ${b(km(data.mapsTotalKm, 2))}` : '',
          data.mapsAgeMin > 0 ? ` • ${i(`pozycja GPS sprzed ${data.mapsAgeMin} min`)}` : '',
        ]),
    divergent &&
      ` ⚠️ ${i('Duża różnica na dojeździe — sprawdź, czy GPS jest aktualny (/lokalizacja).')}`,
    '',
    `📊 ${b('Stawka netto/km:')} ${b(`${data.netRatePerKm.toFixed(2)} zł/km`)} (min. ${CFG.MIN_STAWKA_NETTO_KM.toFixed(2)} zł)`,
    ` ${i(`liczona z ${data.totalKm.toFixed(2)} km — ${basisLabel[data.rateBasis]}`)}`,
    '',
    STATUS_LINE[status],
  ]);
}

export function helpCard(): string {
  return joinLines([
    `🤖 ${b('GlovoBot – Asystent Kuriera')}`,
    '',
    `🛵 ${b('Obsługa zmiany:')}`,
    ` • ${code('/wyjazd')} – start zmiany i zapis godziny.`,
    ` • ${code('/wyjazd 16:00 120')} – wyjazd z parametrami (godzina, stan portfela).`,
    ` • ${code('/koniec')} – zjazd i rozliczenie.`,
    ` • ${code('/koniec 23:15 54km 180')} – szybki zjazd (godzina, dystans, stan portfela).`,
    ` • ${code('/anuluj')} – przerwij oczekiwanie na wpis.`,
    '',
    `💰 ${b('Zarobek i koszty:')}`,
    ` • ${code('/brutto 438.60')} – zarobek brutto z aplikacji Glovo.`,
    ` • ${code('/paliwo 312.40 48.2')} – paragon: kwota, litry (opcjonalnie cena/L i data).`,
    ` • ${code('n 5.50')} – szybki napiwek gotówkowy.`,
    '',
    `📍 ${b('Lokalizacja:')}`,
    ` • ${code('/lokalizacja')} – wyślij GPS do weryfikacji tras (ważny 30 min).`,
    '',
    `🎯 ${b('Cele zarobkowe:')}`,
    ` • ${code('/cel 4500')} – cel miesięczny netto.`,
    ` • ${code('/cel tydzien 1200')} – cel tygodniowy netto.`,
    ` • ${code('/cele')} – postęp i wymagane tempo.`,
    '',
    `📊 ${b('Raporty i historia:')}`,
    ` • ${code('/dzis')} – podsumowanie dzisiejszej zmiany.`,
    ` • ${code('/dzien 2026-08-15')} – podsumowanie wybranego dnia.`,
    ` • ${code('/tydzien')} / ${code('/ptydzien')} – bieżący / poprzedni tydzień.`,
    ` • ${code('/miesiac')} – podsumowanie miesiąca.`,
    ` • ${code('/statystyki')} – statystyki ofert kursów.`,
    ` • ${code('/saldo')} – stan portfela Glovo (suma transakcji).`,
    '',
    `🎙️ ${b('Głos:')} tankowanie, dystans, godziny, zarobki, napiwki — także kasowanie wpisów.`,
    `✍️ ${b('Tekst:')} to samo co głosem, ale bez kasowania. Np. ${code('dzisiaj zarobiłem 438.60')}.`,
    `📸 ${b('Zdjęcia:')} zrzuty Portfela, paragony paliwowe, oferty zleceń — rozpoznaję automatycznie.`,
  ]);
}

/**
 * Wynik zapisu notatki — glosowej albo tekstowej.
 * Typ wyprowadzony z serwisu, zeby nie rozjechal sie po cichu przy zmianie
 * `saveVoiceEvent()`.
 */
export type NoteSaveResult = Awaited<ReturnType<FinanceService['saveVoiceEvent']>>;

/**
 * Karta potwierdzenia zapisu z notatki. Naglowek jest parametrem, bo glos
 * pokazuje transkrypcje, a tekst nie ma czego transkrybowac — reszta jest
 * wspolna i nie ma powodu jej duplikowac (5).
 */
export function noteSavedCard(
  headerLines: Array<string | false | null>,
  extracted: VoiceExtractedData,
  saved: NoteSaveResult
): string {
  return joinLines([
    ...headerLines,
    `📅 ${b('Data wpisu:')} ${code(saved.date)}`,
    '',
    saved.hasFuel && `⛽ ${b('Zapisano tankowanie:')}`,
    saved.hasFuel && extracted.fuelTotalCost != null && ` • Koszt: ${b(zl(extracted.fuelTotalCost))}`,
    saved.hasFuel && extracted.fuelLiters != null && ` • Ilość: ${b(`${extracted.fuelLiters} L`)}`,
    saved.hasFuel &&
      extracted.fuelPricePerLiter != null &&
      ` • Cena: ${b(`${extracted.fuelPricePerLiter.toFixed(2)} zł/L`)}`,
    extracted.distanceKm != null && `🚗 ${b('Dystans dnia:')} ${b(`${extracted.distanceKm} km`)}`,
    extracted.grossEarnings != null && `💰 ${b('Zarobek brutto:')} ${b(zl(extracted.grossEarnings))}`,
    extracted.workFrom &&
      extracted.workTo &&
      `⏱️ ${b('Godziny:')} ${code(`${extracted.workFrom} - ${extracted.workTo}`)}`,
    extracted.cashTip != null && `💵 ${b('Napiwek gotówkowy:')} ${b(zlSigned(extracted.cashTip))}`,
    saved.hoursError && `⚠️ ${i(saved.hoursError)}`,
    !saved.hasDailyUpdate && !saved.hasTip && !saved.hasFuel && i('Nie rozpoznano żadnych danych do zapisania.'),
  ]);
}
