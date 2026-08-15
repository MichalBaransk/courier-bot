import { Markup } from 'telegraf';

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

export const startShiftKeyboard = (currentTime: string, alreadySaved: boolean) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(
        alreadySaved ? `🔄 Nadpisz start (${currentTime})` : `⚡ Zapisz start teraz (${currentTime})`,
        'startshift_start_now'
      ),
    ],
    [
      Markup.button.callback('✏️ Wpisz inną godzinę', 'startshift_custom_time'),
      Markup.button.callback('💵 Ustaw kasetkę', 'startshift_set_cash'),
    ],
  ]);

export const endShiftKeyboard = (currentTime: string, alreadySaved: boolean) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(
        alreadySaved ? `🔄 Nadpisz zjazd (${currentTime})` : `⏱️ Zapisz zjazd teraz (${currentTime})`,
        'endshift_set_now'
      ),
    ],
    [
      Markup.button.callback('✏️ Inna godzina', 'endshift_custom_time'),
      Markup.button.callback('🚗 Dystans dnia', 'endshift_set_dist'),
    ],
    [Markup.button.callback('💵 Stan portfela Glovo', 'endshift_set_cash')],
  ]);

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
