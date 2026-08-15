import { CFG } from '../config.js';
import { b, code, i, joinLines, km, progressBar, zl, zlSigned, SEPARATOR } from '../utils/format.js';
import type {
  CourseOfferStats,
  DailySummary,
  PeriodSummary,
  TargetProgress,
} from '../services/finance.service.js';

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
    progress.usedFallbackRate &&
      i(`Prognoza godzin liczona stawką zastępczą ${CFG.FALLBACK_HOURLY_RATE_NETTO.toFixed(2)} zł/h — brak własnej historii.`),
  ]);
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
    `💰 ${b('Zarobek brutto:')} ${b(zl(summary.grossEarnings))}`,
    `💵 ${b('Zarobek łącznie netto:')} ${b(zl(summary.totalNetto))} (stawka ${b(`${summary.hourlyRateNetto.toFixed(2)} zł/h`)})`,
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
  pickupKm: number | null;
  deliveryKm: number | null;
  totalKm: number;
  source: 'MAPS' | 'APP';
  sourceNote: string | null;
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
export function offerCard(data: OfferCardData): string {
  const status = data.status ?? 'PENDING';

  return joinLines([
    data.isProfitable ? b('✅ KURS OPŁACALNY') : b('❌ KURS SŁABY / ODRZUĆ'),
    '',
    `💵 ${b('Stawka:')} ${b(`${data.grossAmount.toFixed(2)} zł brutto`)} ➔ ${b(`${data.netAmount.toFixed(2)} zł netto`)}`,
    `📍 ${b('Odbiór:')} ${code(data.pickupAddress)}`,
    `🏠 ${b('Dostawa:')} ${code(data.deliveryAddress)}`,
    '',
    // FIX (2.3): trzy osobne pozycje zamiast jednej mylacej liczby.
    `🛣️ ${b('Dystans:')}`,
    ` • Odbiór: ${data.pickupKm != null ? b(km(data.pickupKm, 2)) : i('brak')}`,
    ` • Dostawa: ${data.deliveryKm != null ? b(km(data.deliveryKm, 2)) : i('brak')}`,
    ` • ${b('Suma:')} ${b(km(data.totalKm, 2))} ${i(data.source === 'MAPS' ? '(Google Maps)' : '(z aplikacji Glovo)')}`,
    data.sourceNote && ` ${i(`⚠️ ${data.sourceNote}`)}`,
    '',
    `📊 ${b('Stawka netto/km:')} ${b(`${data.netRatePerKm.toFixed(2)} zł/km`)} (min. ${CFG.MIN_STAWKA_NETTO_KM.toFixed(2)} zł)`,
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
    `🪙 ${b('Szybki napiwek:')} wpisz ${code('n 5.50')}`,
    `🎙️ ${b('Głos:')} tankowanie, dystans, godziny, zarobki, napiwki.`,
    `📸 ${b('Zdjęcia:')} zrzuty Portfela, paragony paliwowe, oferty zleceń.`,
  ]);
}
