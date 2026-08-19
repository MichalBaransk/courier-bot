import { Markup } from 'telegraf';
import { numerZmiany } from '../utils/format.js';

/**
 * FIX (4.8): klawiatury byly budowane w kilku miejscach z kopiuj-wklej
 * (`/wyjazd` i `btn_quick_start_shift` mialy identyczny markup w dwoch kopiach).
 * Teraz jedno zrodlo prawdy.
 */

export const mainMenuKeyboard = () =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('🚀 Rozpocznij zmianę', 'btn_quick_start_shift'),
      Markup.button.callback('🏁 Zakończ zmianę', 'btn_quick_end_shift'),
    ],
    [
      Markup.button.callback('📊 Podsumowanie dziś', 'btn_quick_today'),
      Markup.button.callback('🎯 Moje cele', 'btn_quick_targets'),
    ],
  ]);

/**
 * `trwa` = jest niezamknieta zmiana.
 *
 * Etykieta mowi wprost, co przycisk zrobi. Przed P3 „Nadpisz start" znaczylo
 * „zamien jedyna pare godzin w dobie"; teraz poprawia WYJAZD TRWAJACEJ zmiany
 * i nie rusza wczesniejszych, zamknietych.
 */
export const startShiftKeyboard = (currentTime: string, trwa: boolean) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(
        trwa ? `🔄 Popraw wyjazd (${currentTime})` : `⚡ Zapisz start teraz (${currentTime})`,
        'startshift_start_now'
      ),
    ],
    [
      Markup.button.callback('✏️ Wpisz inną godzinę', 'startshift_custom_time'),
      Markup.button.callback('💵 Ustaw kasetkę', 'startshift_set_cash'),
    ],
  ]);

/** `trwa` = jest co zamykac. Bez trwajacej zmiany zjazd zwroci komunikat. */
export const endShiftKeyboard = (currentTime: string, trwa: boolean) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(
        trwa ? `⏱️ Zapisz zjazd teraz (${currentTime})` : `⏱️ Zjazd (${currentTime}) — brak trwającej`,
        'endshift_set_now'
      ),
    ],
    [
      Markup.button.callback('✏️ Inna godzina', 'endshift_custom_time'),
      Markup.button.callback('🚗 Dystans dnia', 'endshift_set_dist'),
    ],
    [
      Markup.button.callback('💰 Zarobek brutto', 'endshift_set_gross'),
      Markup.button.callback('⛽ Paliwo', 'endshift_add_fuel'),
    ],
    [Markup.button.callback('💵 Stan portfela Glovo', 'endshift_set_cash')],
  ]);

/**
 * Klawiatura pod `/zmiany` — kasowanie po `id`, nie po pozycji na liscie.
 *
 * Pozycja jest zwodnicza: po skasowaniu pierwszej zmiany druga staje sie
 * pierwsza, a przycisk ze starej wiadomosci nadal mowilby „kasuj 1".
 * `id` wskazuje ten sam wiersz niezaleznie od tego, co dzialo sie potem.
 *
 * DATA tez siedzi w callbacku, a nie jest brana z „dzisiaj" przy obsludze.
 * Bez niej `/zmiany 2026-08-15` po skasowaniu przerysowalby karte na dzisiejsza
 * dobe — inne dane pod ta sama wiadomoscia, bez slowa wyjasnienia.
 * `zmiana_usun_<id>_<RRRR-MM-DD>` miesci sie w 64 bajtach limitu Telegrama.
 */
export const zmianyKeyboard = (
  date: string,
  sesje: ReadonlyArray<{ id: number; od: string; do: string | null }>
) =>
  Markup.inlineKeyboard(
    sesje.map((s, idx) => [
      Markup.button.callback(
        `🗑️ ${numerZmiany(idx + 1)}: ${s.od}–${s.do ?? '…'}`,
        `zmiana_usun_${s.id}_${date}`
      ),
    ])
  );

export const cancelInputKeyboard = () =>
  Markup.inlineKeyboard([[Markup.button.callback('✖️ Anuluj', 'input_cancel')]]);

export const walletImportKeyboard = () =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Zapisz transakcje', 'wallet_confirm'),
      Markup.button.callback('✖️ Anuluj', 'wallet_cancel'),
    ],
  ]);

export const offerDecisionKeyboard = (offerId: number) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Zaakceptowano', `offer:accept:${offerId}`),
      Markup.button.callback('❌ Odrzucono', `offer:reject:${offerId}`),
    ],
  ]);

export const offerDoneKeyboard = (accepted: boolean) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(accepted ? '✅ Zlecenie zaakceptowane' : '❌ Zlecenie odrzucone', 'offer_done')],
  ]);

export const locationRequestKeyboard = () =>
  Markup.keyboard([[Markup.button.locationRequest('📍 Wyślij moją pozycję GPS')]])
    .resize()
    .oneTime();

export const removeKeyboard = () => Markup.removeKeyboard();
