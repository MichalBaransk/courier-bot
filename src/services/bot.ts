import { Telegraf, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { geminiService, WalletTransactionItem } from './gemini.service.js';
import { financeService, TargetProgress, DailySummary } from './finance.service.js';
import { mapsService } from './maps.service.js';
import { CFG } from '../config.js';

interface CourierLocation {
  latitude: number;
  longitude: number;
  updatedAt: number;
}

const lastCourierLocation: Map<string, CourierLocation> = new Map();
const pendingWalletImports: Map<string, { transactions: WalletTransactionItem[]; expiresAt: number }> = new Map();

// Trzymamy tylko oczekujące wpisy tekstowe (proste flagi)
const awaitingInput: Map<string, 'START_CUSTOM_TIME' | 'START_CASH' | 'END_CUSTOM_TIME' | 'END_DIST' | 'END_CASH'> = new Map();

function getCurrentWarsawTime(): string {
  const now = new Date();
  return now.toLocaleTimeString('pl-PL', {
    timeZone: 'Europe/Warsaw',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function generateProgressBar(percent: number, totalBlocks = 10): string {
  const filledBlocks = Math.min(totalBlocks, Math.max(0, Math.round((percent / 100) * totalBlocks)));
  const emptyBlocks = totalBlocks - filledBlocks;
  return `[${'█'.repeat(filledBlocks)}${'░'.repeat(emptyBlocks)}]`;
}

function formatTargetCard(progress: TargetProgress): string {
  const isMonth = progress.periodType === 'MONTHLY';
  const header = isMonth ? '🎯 *Miesięczny Cel Zarobkowy*' : '🎯 *Tygodniowy Cel Zarobkowy*';
  const bar = generateProgressBar(progress.progressPercent);

  if (progress.isCompleted) {
    return [
      header,
      `${bar} *${progress.progressPercent.toFixed(1)}%*`,
      '',
      '🏆 *CEL OSIĄGNIĘTY!*',
      `💰 *Zarobione netto:* *${progress.currentNetto.toFixed(2)} zł* / *${progress.targetAmount.toFixed(2)} zł*`,
      `📈 *Nadwyżka:* *+${(progress.currentNetto - progress.targetAmount).toFixed(2)} zł*`,
    ].join('\n');
  }

  return [
    header,
    `${bar} *${progress.progressPercent.toFixed(1)}%*`,
    '',
    `💰 *Postęp:* *${progress.currentNetto.toFixed(2)} zł* z *${progress.targetAmount.toFixed(2)} zł* netto`,
    `⏳ *Brakuje:* *${progress.remainingNetto.toFixed(2)} zł*`,
    `📅 *Pozostało dni:* *${progress.daysRemaining}*`,
    '',
    '📊 *Wymagane tempo:*',
    ` • Dziennie: *${progress.dailyRequiredNetto.toFixed(2)} zł netto / dzień*`,
    ` • Czas pracy: *~${progress.estimatedHoursRemaining.toFixed(1)} h* (${progress.hoursPerDayRequired.toFixed(1)} h / dzień)`,
  ].join('\n');
}

async function renderStartShiftCard(telegramId: string | number, date: string): Promise<string> {
  const summary = await financeService.getDailySummary(telegramId, date);
  const rolling = await financeService.getRollingBalance(telegramId, date);
  const currentTime = getCurrentWarsawTime();

  return [
    '🚀 *Rozpoczęcie Zmiany*',
    `📅 *Data:* \`${date}\``,
    '',
    `⏱️ *Godzina wyjazdu:* *${summary.workFrom ? summary.workFrom + ' (zapisano w bazie)' : `_Nieustalona_ (teraz: ${currentTime})`}*`,
    `💵 *Portfel Glovo:* *${rolling.balance.toFixed(2)} zł*`,
    '',
    summary.workFrom
      ? '✅ _Godzina wyjazdu została zapisana w bazie PostgreSQL._'
      : 'Wybierz godzinę startu poniżej:',
  ].join('\n');
}

async function renderEndShiftCard(telegramId: string | number, date: string): Promise<string> {
  const summary = await financeService.getDailySummary(telegramId, date);
  const currentTime = getCurrentWarsawTime();

  return [
    '🏁 *Zakończenie Zmiany*',
    `📅 *Data zmiany:* \`${date}\``,
    '',
    `⏱️ *Godziny pracy:* \`${summary.workFrom || '--:--'} - ${summary.workTo || '--:--'}\` (*${summary.workHours.toFixed(2)} h*)`,
    `🚗 *Stan licznika / Dystans:* *${summary.fuelDistance ? summary.fuelDistance + ' km' : '_Brak_'}*`,
    `💰 *Zarobek brutto:* *${summary.grossEarnings.toFixed(2)} zł*`,
    `💵 *Czyste Netto:* *${summary.totalNetto.toFixed(2)} zł* (Stawka: *${summary.hourlyRateNetto.toFixed(2)} zł/h*)`,
    '',
    summary.workTo
      ? '✅ _Godzina zjazdu została zapisana w bazie._'
      : `⏱️ _Ustaw godzinę zjazdu (teraz: ${currentTime}) lub podaj przebieg:_`,
  ].join('\n');
}

export function registerBotHandlers(bot: Telegraf): void {
  // 1. Pomoc i Menu
  bot.command(['start', 'pomoc', 'help', 'menu'], async (ctx) => {
    const text = [
      '🤖 *GlovoBot – Asystent Kuriera*',
      '',
      '🛵 *Obsługa zmiany:*',
      ' • `/wyjazd` – start zmiany i zapis godziny.',
      ' • `/wyjazd 16:00 120` – wyjazd z parametrami (godz, kasetka).',
      ' • `/koniec` – zjazd i rozliczenie.',
      ' • `/koniec 23:15 54 180` – szybki zjazd (godz, dystans km, gotówka).',
      '',
      '📍 *Lokalizacja:*',
      ' • `/lokalizacja` – wyślij GPS do weryfikacji zleceń.',
      '',
      '🎯 *Cele zarobkowe:*',
      ' • `/cel 4500` – cel miesięczny netto.',
      ' • `/cel tydzien 1200` – cel tygodniowy netto.',
      ' • `/cele` – sprawdź postęp i wymagane tempo.',
      '',
      '📊 *Raporty i historia:*',
      ' • `/dzis` – podsumowanie dzisiejszej zmiany.',
      ' • `/dzien 2026-08-15` – podsumowanie wybranego dnia.',
      ' • `/tydzien` / `/ptydzien` – bieżący / poprzedni tydzień.',
      ' • `/miesiac` – podsumowanie miesiąca.',
      ' • `/statystyki` – statystyki ofert kursów.',
      ' • `/saldo` – stan portfela Glovo.',
      '',
      '🎙️ *Głos (Voice-to-Data):* Notatki tankowania, godzin i zarobków.',
      '📸 *Zdjęcia:* Zrzuty Portfela, paragony paliwowe, oferty zleceń.',
    ].join('\n');

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🚀 Rozpocznij zmianę', 'btn_quick_start_shift'),
          Markup.button.callback('🏁 Zakończ zmianę', 'btn_quick_end_shift'),
        ],
        [
          Markup.button.callback('📊 Podsumowanie dziś', 'btn_quick_today'),
          Markup.button.callback('🎯 Moje cele', 'btn_quick_targets'),
        ],
      ]),
    });
  });

  // Skróty z menu głównego
  bot.action('btn_quick_start_shift', async (ctx) => {
    await ctx.answerCbQuery();
    const effDate = financeService.getEffectiveDate();
    const currentTime = getCurrentWarsawTime();
    const text = await renderStartShiftCard(ctx.from.id, effDate);

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(`⚡ Zapisz start teraz (${currentTime})`, 'startshift_start_now'),
        ],
        [
          Markup.button.callback('✏️ Wpisz inną godzinę', 'startshift_custom_time'),
          Markup.button.callback('💵 Ustaw kasetkę', 'startshift_set_cash'),
        ],
      ]),
    });
  });

  bot.action('btn_quick_end_shift', async (ctx) => {
    await ctx.answerCbQuery();
    const effDate = financeService.getEffectiveDate();
    const currentTime = getCurrentWarsawTime();
    const text = await renderEndShiftCard(ctx.from.id, effDate);

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(`⏱️ Ustaw zjazd teraz (${currentTime})`, 'endshift_set_now'),
          Markup.button.callback('✏️ Inna godzina', 'endshift_custom_time'),
        ],
        [
          Markup.button.callback('🚗 Podaj dystans / licznik', 'endshift_set_dist'),
          Markup.button.callback('💵 Stan gotówki Glovo', 'endshift_set_cash'),
        ],
      ]),
    });
  });

  bot.action('btn_quick_today', async (ctx) => {
    await ctx.answerCbQuery();
    const date = financeService.getEffectiveDate();
    const summary = await financeService.getDailySummary(ctx.from.id, date);
    const text = [
      `📅 *Raport dzienny:* \`${summary.date}\``,
      '',
      `💰 *Brutto:* *${summary.grossEarnings.toFixed(2)} zł*`,
      `💵 *Netto ze zleceń (81.4%):* *${summary.netEarnings.toFixed(2)} zł*`,
      `🪙 *Napiwki gotówka:* *+${summary.cashTipsTotal.toFixed(2)} zł*`,
      `🏁 *Netto łącznie:* *${summary.totalNetto.toFixed(2)} zł*`,
      summary.walletPayouts > 0 ? `🏧 *Wypłaty z portfela:* *-${summary.walletPayouts.toFixed(2)} zł*` : '',
      `💳 *Do przelewu:* *${summary.doPrzelewu.toFixed(2)} zł*`,
      '',
      summary.workHours > 0
        ? `⏱️ *Czas:* *${summary.workHours.toFixed(2)} h* (Stawka: *${summary.hourlyRateNetto.toFixed(2)} zł netto/h*)`
        : '⏱️ *Czas pracy:* _Brak wpisu_',
    ]
      .filter(Boolean)
      .join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  bot.action('btn_quick_targets', async (ctx) => {
    await ctx.answerCbQuery();
    const mProg = await financeService.getTargetProgress(ctx.from.id, 'MONTHLY');
    const wProg = await financeService.getTargetProgress(ctx.from.id, 'WEEKLY');
    if (!mProg && !wProg) {
      await ctx.reply('🎯 *Brak celów.* Wpisz np. `/cel 4500` lub `/cel tydzien 1200`.', { parse_mode: 'Markdown' });
      return;
    }
    const cards = [mProg && formatTargetCard(mProg), wProg && formatTargetCard(wProg)].filter(Boolean);
    await ctx.reply(cards.join('\n\n────────────────\n\n'), { parse_mode: 'Markdown' });
  });

  // 2. Start zmiany: /wyjazd
  bot.command(['wyjazd', 'startzmiana', 'poczatek', 'start_zmiana'], async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const effDate = financeService.getEffectiveDate();

    // Szybka ścieżka: /wyjazd 17:30 150
    if (parts.length > 1) {
      let workFrom = getCurrentWarsawTime();
      let initialCash: number | null = null;

      for (let i = 1; i < parts.length; i++) {
        const p = parts[i]!;
        if (/^\d{1,2}:\d{2}$/.test(p)) {
          workFrom = p.length === 4 ? `0${p}` : p;
        } else {
          const val = parseFloat(p.replace(',', '.').replace(/zł|zl/i, ''));
          if (!isNaN(val)) initialCash = val;
        }
      }

      await financeService.setShiftStart(ctx.from.id, effDate, workFrom);
      if (initialCash != null) {
        await financeService.setBalanceCheckpoint(ctx.from.id, effDate, initialCash);
      }

      const userLoc = lastCourierLocation.get(String(ctx.from.id));
      const hasRecentLocation = Boolean(userLoc && Date.now() - userLoc.updatedAt <= 30 * 60 * 1000);

      await ctx.reply(
        `🚀 *Zmiana rozpoczęta!*\n📅 Data: \`${effDate}\`\n⏱️ Godzina wyjazdu: *${workFrom}* (zapisano w bazie)`,
        {
          parse_mode: 'Markdown',
          ...(!hasRecentLocation
            ? Markup.keyboard([[Markup.button.locationRequest('📍 Wyślij moją pozycję GPS')]])
                .resize()
                .oneTime()
            : Markup.removeKeyboard()),
        }
      );
      return;
    }

    // Panel startu
    const currentTime = getCurrentWarsawTime();
    const text = await renderStartShiftCard(ctx.from.id, effDate);
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(`⚡ Zapisz start teraz (${currentTime})`, 'startshift_start_now'),
        ],
        [
          Markup.button.callback('✏️ Wpisz inną godzinę', 'startshift_custom_time'),
          Markup.button.callback('💵 Ustaw kasetkę', 'startshift_set_cash'),
        ],
      ]),
    });
  });

  // Callbacks startu
  bot.action(/^startshift_(start_now|custom_time|set_cash)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const action = ctx.match[1];
    const tId = String(ctx.from.id);
    const effDate = financeService.getEffectiveDate();

    if (action === 'start_now') {
      const currentTime = getCurrentWarsawTime();
      await financeService.setShiftStart(tId, effDate, currentTime);
      const text = await renderStartShiftCard(tId, effDate);

      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✏️ Popraw godzinę', 'startshift_custom_time'),
            Markup.button.callback('💵 Ustaw kasetkę', 'startshift_set_cash'),
          ],
        ]),
      });
      return;
    }

    if (action === 'custom_time') {
      awaitingInput.set(tId, 'START_CUSTOM_TIME');
      await ctx.reply('⏱️ *Wpisz godzinę wyjazdu* w formacie `GG:MM` (np. `19:30`):', { parse_mode: 'Markdown' });
      return;
    }

    if (action === 'set_cash') {
      awaitingInput.set(tId, 'START_CASH');
      await ctx.reply('💵 *Wpisz stan gotówki przed wyjazdem* (np. `150.00`):', { parse_mode: 'Markdown' });
      return;
    }
  });

  // 3. Koniec zmiany: /koniec
  bot.command(['koniec', 'zjazd'], async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const effDate = financeService.getEffectiveDate();

    // Szybka ścieżka: /koniec 23:15 54 180
    if (parts.length > 1) {
      let workTo: string | null = null;
      let fuelDistance: number | null = null;
      let walletCash: number | null = null;

      for (let i = 1; i < parts.length; i++) {
        const p = parts[i]!;
        if (/^\d{1,2}:\d{2}$/.test(p)) {
          workTo = p.length === 4 ? `0${p}` : p;
        } else if (/^\d+km$/i.test(p) || (/^\d+$/.test(p) && fuelDistance === null)) {
          fuelDistance = parseInt(p.replace(/km/i, ''), 10);
        } else {
          const val = parseFloat(p.replace(',', '.').replace(/zł|zl/i, ''));
          if (!isNaN(val)) walletCash = val;
        }
      }

      const summary = await financeService.setShiftEnd(ctx.from.id, effDate, {
        workTo,
        fuelDistance,
        walletCash,
      });

      const response = [
        '🏁 *Zmiana została zamknięta!*',
        '',
        `📅 *Data:* \`${summary.date}\``,
        summary.workFrom && summary.workTo ? `⏱️ *Godziny:* \`${summary.workFrom} - ${summary.workTo}\` (*${summary.workHours.toFixed(2)} h*)` : '',
        summary.fuelDistance ? `🚗 *Przebieg:* *${summary.fuelDistance} km*` : '',
        `💰 *Zarobek brutto:* *${summary.grossEarnings.toFixed(2)} zł*`,
        `💵 *Netto łącznie:* *${summary.totalNetto.toFixed(2)} zł* (Stawka: *${summary.hourlyRateNetto.toFixed(2)} zł/h*)`,
        `🪙 *Napiwki gotówka:* *+${summary.cashTipsTotal.toFixed(2)} zł*`,
        summary.walletPayouts > 0 ? `🏧 *Wypłaty portfel:* *-${summary.walletPayouts.toFixed(2)} zł*` : '',
        `💳 *Do przelewu:* *${summary.doPrzelewu.toFixed(2)} zł*`,
        walletCash != null ? `💼 *Portfel Glovo:* *${walletCash.toFixed(2)} zł*` : '',
      ]
        .filter(Boolean)
        .join('\n');

      await ctx.reply(response, { parse_mode: 'Markdown' });
      return;
    }

    // Panel zjazdu
    const currentTime = getCurrentWarsawTime();
    const text = await renderEndShiftCard(ctx.from.id, effDate);
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(`⏱️ Ustaw zjazd teraz (${currentTime})`, 'endshift_set_now'),
          Markup.button.callback('✏️ Inna godzina', 'endshift_custom_time'),
        ],
        [
          Markup.button.callback('🚗 Podaj dystans / licznik', 'endshift_set_dist'),
          Markup.button.callback('💵 Stan gotówki Glovo', 'endshift_set_cash'),
        ],
      ]),
    });
  });

  // Callbacks zjazdu
  bot.action(/^endshift_(set_now|custom_time|set_dist|set_cash)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const action = ctx.match[1];
    const tId = String(ctx.from.id);
    const effDate = financeService.getEffectiveDate();

    if (action === 'set_now') {
      const currentTime = getCurrentWarsawTime();
      await financeService.setShiftEnd(tId, effDate, { workTo: currentTime });
      const text = await renderEndShiftCard(tId, effDate);

      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(`⏱️ Odśwież (${getCurrentWarsawTime()})`, 'endshift_set_now'),
            Markup.button.callback('✏️ Inna godzina', 'endshift_custom_time'),
          ],
          [
            Markup.button.callback('🚗 Podaj dystans', 'endshift_set_dist'),
            Markup.button.callback('💵 Stan gotówki Glovo', 'endshift_set_cash'),
          ],
        ]),
      });
      return;
    }

    if (action === 'custom_time') {
      awaitingInput.set(tId, 'END_CUSTOM_TIME');
      await ctx.reply('⏱️ *Wpisz godzinę zjazdu* w formacie `GG:MM` (np. `23:30`):', { parse_mode: 'Markdown' });
      return;
    }

    if (action === 'set_dist') {
      awaitingInput.set(tId, 'END_DIST');
      await ctx.reply('🚗 *Wpisz stan licznika lub dystans w km* (np. `48`):', { parse_mode: 'Markdown' });
      return;
    }

    if (action === 'set_cash') {
      awaitingInput.set(tId, 'END_CASH');
      await ctx.reply('💵 *Wpisz stan gotówki w aplikacji Glovo* (np. `142.50`):', { parse_mode: 'Markdown' });
      return;
    }
  });

  // 4. Obsługa wpisów tekstowych z klawiatury
  bot.on(message('text'), async (ctx, next) => {
    const tId = String(ctx.from.id);
    const rawText = ctx.message.text.trim();
    const pendingInput = awaitingInput.get(tId);
    const effDate = financeService.getEffectiveDate();

    if (pendingInput) {
      if (pendingInput === 'START_CUSTOM_TIME') {
        if (/^\d{1,2}:\d{2}$/.test(rawText)) {
          const time = rawText.length === 4 ? `0${rawText}` : rawText;
          awaitingInput.delete(tId);
          await financeService.setShiftStart(tId, effDate, time);
          await ctx.reply(`✅ *Godzina wyjazdu ${time} zapisana w bazie!*`, { parse_mode: 'Markdown' });
          return;
        }
        await ctx.reply('❌ Błędny format godziny. Podaj np. `19:30`.');
        return;
      }

      if (pendingInput === 'START_CASH') {
        const val = parseFloat(rawText.replace(',', '.').replace(/zł|zl/i, '').trim());
        if (!isNaN(val)) {
          awaitingInput.delete(tId);
          await financeService.setBalanceCheckpoint(tId, effDate, val);
          await ctx.reply(`✅ *Zapisano stan portfela startowego:* *${val.toFixed(2)} zł* na dzień \`${effDate}\``, {
            parse_mode: 'Markdown',
          });
          return;
        }
        await ctx.reply('❌ Podaj poprawną kwotę (np. `120.00`).');
        return;
      }

      if (pendingInput === 'END_CUSTOM_TIME') {
        if (/^\d{1,2}:\d{2}$/.test(rawText)) {
          const time = rawText.length === 4 ? `0${rawText}` : rawText;
          awaitingInput.delete(tId);
          const summary = await financeService.setShiftEnd(tId, effDate, { workTo: time });
          await ctx.reply(
            `✅ *Godzina zjazdu ${time} zapisana!* Czas pracy dzisiaj: *${summary.workHours.toFixed(2)} h*`,
            { parse_mode: 'Markdown' }
          );
          return;
        }
        await ctx.reply('❌ Błędny format godziny. Podaj np. `23:15`.');
        return;
      }

      if (pendingInput === 'END_DIST') {
        const val = parseInt(rawText.replace(/km/i, '').trim(), 10);
        if (!isNaN(val) && val >= 0) {
          awaitingInput.delete(tId);
          await financeService.setShiftEnd(tId, effDate, { fuelDistance: val });
          await ctx.reply(`✅ *Przebieg ${val} km zapisany w bazie!*`, { parse_mode: 'Markdown' });
          return;
        }
        await ctx.reply('❌ Podaj liczbę kilometrów (np. `52`).');
        return;
      }

      if (pendingInput === 'END_CASH') {
        const val = parseFloat(rawText.replace(',', '.').replace(/zł|zl/i, '').trim());
        if (!isNaN(val)) {
          awaitingInput.delete(tId);
          await financeService.setBalanceCheckpoint(tId, effDate, val);
          await ctx.reply(`✅ *Zapisano stan portfela Glovo:* *${val.toFixed(2)} zł*`, { parse_mode: 'Markdown' });
          return;
        }
        await ctx.reply('❌ Podaj poprawną kwotę (np. `145.00`).');
        return;
      }
    }

    // Import portfela tekstem
    const pending = pendingWalletImports.get(tId);
    if (pending && Date.now() <= pending.expiresAt) {
      const lower = rawText.toLowerCase();
      if (['tak', 't', 'zapisz', 'ok', 'yes', 'y'].includes(lower)) {
        pendingWalletImports.delete(tId);
        const saveResult = await financeService.saveWalletTransactions(ctx.from.id, pending.transactions);
        await ctx.reply(
          `✅ *Zapisano ${saveResult.added} transakcji do bazy.*\n📅 *Dotknięte dni:* \`${saveResult.dates.join(', ')}\``,
          { parse_mode: 'Markdown' }
        );
        return;
      }
      if (['nie', 'n', 'anuluj'].includes(lower)) {
        pendingWalletImports.delete(tId);
        await ctx.reply('✖️ *Anulowano import Portfela.* Nic nie zostało zapisane.', { parse_mode: 'Markdown' });
        return;
      }
    }

    return next();
  });

  // 5. Lokalizacja GPS
  bot.command('lokalizacja', async (ctx) => {
    await ctx.reply(
      '📍 *Kliknij przycisk poniżej*, aby udostępnić lokalizację GPS. Będzie używana do weryfikacji tras ofert Glovo przez 30 minut.',
      {
        parse_mode: 'Markdown',
        ...Markup.keyboard([[Markup.button.locationRequest('📍 Wyślij moją pozycję GPS')]])
          .resize()
          .oneTime(),
      }
    );
  });

  bot.on(message('location'), async (ctx) => {
    const { latitude, longitude } = ctx.message.location;
    lastCourierLocation.set(String(ctx.from.id), {
      latitude,
      longitude,
      updatedAt: Date.now(),
    });
    await ctx.reply('✅ *Pozycja GPS zapisana.* Weryfikacja tras Glovo aktywna na 30 minut.', {
      parse_mode: 'Markdown',
      ...Markup.removeKeyboard(),
    });
  });

  // 6. Raporty: /dzis oraz /dzien [RRRR-MM-DD]
  bot.command(['dzis', 'dzien'], async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const dateParam = parts[1];
    const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : financeService.getEffectiveDate();
    const summary = await financeService.getDailySummary(ctx.from.id, date);

    const text = [
      `📅 *Raport dzienny:* \`${summary.date}\``,
      '',
      `💰 *Brutto:* *${summary.grossEarnings.toFixed(2)} zł*`,
      `💵 *Netto z zleceń (81.4%):* *${summary.netEarnings.toFixed(2)} zł*`,
      `🪙 *Napiwki gotówka:* *+${summary.cashTipsTotal.toFixed(2)} zł*`,
      `🏁 *Netto łącznie:* *${summary.totalNetto.toFixed(2)} zł*`,
      summary.walletPayouts > 0 ? `🏧 *Wypłaty z portfela:* *-${summary.walletPayouts.toFixed(2)} zł*` : '',
      `💳 *Do przelewu (bez gotówki):* *${summary.doPrzelewu.toFixed(2)} zł*`,
      '',
      summary.workHours > 0
        ? `⏱ *Czas pracy:* \`${summary.workFrom || '--:--'} - ${summary.workTo || '--:--'}\` (*${summary.workHours.toFixed(2)} h*) — Stawka: *${summary.hourlyRateNetto.toFixed(2)} zł/h*`
        : '⏱ *Czas pracy:* _Brak pełnego wpisu_',
      '',
      summary.fuelPrice > 0
        ? `⛽ *Paliwo:* *${summary.fuelPrice.toFixed(2)} zł* (${summary.fuelLiters.toFixed(2)} L)`
        : '⛽ *Paliwo:* _Brak wpisu_',
      summary.fuelDistance ? `🚗 *Przebieg:* *${summary.fuelDistance} km*` : '',
    ]
      .filter(Boolean)
      .join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // 7. Raporty: /tydzien oraz /ptydzien
  bot.command(['tydzien', 'ptydzien'], async (ctx) => {
    const isPrevious = ctx.message.text.toLowerCase().includes('ptydzien');
    const { startDate, endDate } = financeService.getWeekRange(isPrevious ? -1 : 0);

    const summary = await financeService.getPeriodSummary(ctx.from.id, startDate, endDate);
    const weeklyTarget = !isPrevious ? await financeService.getTargetProgress(ctx.from.id, 'WEEKLY') : null;

    const text = [
      `📊 *${isPrevious ? 'Poprzedni tydzień' : 'Bieżący tydzień'} (${summary.startDate} - ${summary.endDate}):*`,
      '',
      `💰 *Brutto łączne:* *${summary.totalGross.toFixed(2)} zł*`,
      `💵 *Netto z zleceń:* *${summary.totalNettoEarnings.toFixed(2)} zł*`,
      `🪙 *Napiwki gotówkowe:* *+${summary.totalCashTips.toFixed(2)} zł*`,
      `🏁 *Netto całkowite:* *${summary.grandTotalNetto.toFixed(2)} zł*`,
      summary.totalWalletPayouts > 0 ? `🏧 *Wypłaty portfel:* *-${summary.totalWalletPayouts.toFixed(2)} zł*` : '',
      `💳 *Do przelewu:* *${summary.totalDoPrzelewu.toFixed(2)} zł*`,
      '',
      `⏱️ *Godziny:* *${summary.totalWorkHours.toFixed(2)} h* (Śr. *${summary.avgHourlyRateNetto.toFixed(2)} zł netto/h*)`,
      `⛽ *Koszty paliwa:* *${summary.totalFuelCost.toFixed(2)} zł*`,
      summary.totalDistanceKm > 0 ? `🚗 *Dystans:* *${summary.totalDistanceKm} km*` : '',
      ...(weeklyTarget
        ? [
            '',
            '────────────────',
            `🎯 *Cel tygodnia:* ${generateProgressBar(weeklyTarget.progressPercent)} *${weeklyTarget.progressPercent.toFixed(1)}%*`,
            `⏳ Brakuje: *${weeklyTarget.remainingNetto.toFixed(2)} zł* (*${weeklyTarget.dailyRequiredNetto.toFixed(2)} zł/dzień*)`,
          ]
        : []),
    ]
      .filter(Boolean)
      .join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // 8. Raporty: /miesiac [RRRR-MM]
  bot.command('miesiac', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    let startDate = '';
    let endDate = '';
    const monthParam = parts[1];

    if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
      const [year, month] = monthParam.split('-').map(Number);
      if (year && month) {
        startDate = `${monthParam}-01`;
        const lastDay = new Date(year, month, 0).getDate();
        endDate = `${monthParam}-${String(lastDay).padStart(2, '0')}`;
      }
    } else {
      const now = new Date();
      startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      endDate = financeService.getEffectiveDate(now);
    }

    const summary = await financeService.getPeriodSummary(ctx.from.id, startDate, endDate);
    const monthlyTarget = await financeService.getTargetProgress(ctx.from.id, 'MONTHLY');

    const text = [
      `🗓️ *Podsumowanie miesiąca (${summary.startDate} - ${summary.endDate}):*`,
      '',
      `💰 *Brutto:* *${summary.totalGross.toFixed(2)} zł*`,
      `💵 *Netto:* *${summary.totalNettoEarnings.toFixed(2)} zł*`,
      `🪙 *Napiwki:* *+${summary.totalCashTips.toFixed(2)} zł*`,
      `🏁 *Czyste Netto:* *${summary.grandTotalNetto.toFixed(2)} zł*`,
      summary.totalWalletPayouts > 0 ? `🏧 *Wypłaty portfel:* *-${summary.totalWalletPayouts.toFixed(2)} zł*` : '',
      `💳 *Do przelewu:* *${summary.totalDoPrzelewu.toFixed(2)} zł*`,
      '',
      `⏱️ *Godziny:* *${summary.totalWorkHours.toFixed(2)} h* (Śr. *${summary.avgHourlyRateNetto.toFixed(2)} zł/h*)`,
      `⛽ *Paliwo:* *${summary.totalFuelCost.toFixed(2)} zł*`,
      ...(monthlyTarget
        ? [
            '',
            '────────────────',
            `🎯 *Cel miesiąca:* ${generateProgressBar(monthlyTarget.progressPercent)} *${monthlyTarget.progressPercent.toFixed(1)}%*`,
            `⏳ Brakuje: *${monthlyTarget.remainingNetto.toFixed(2)} zł*`,
          ]
        : []),
    ]
      .filter(Boolean)
      .join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // 9. Statystyki ofert Glovo: /statystyki [RRRR-MM-DD]
  bot.command('statystyki', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const dateParam = parts[1];
    const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : financeService.getEffectiveDate();
    const stats = await financeService.getCourseOfferStats(ctx.from.id, date);

    if (stats.totalOffers === 0) {
      await ctx.reply(`ℹ️ *Brak zapisanych ofert kursów w dniu* \`${date}\`.`, { parse_mode: 'Markdown' });
      return;
    }

    const text = [
      `📊 *Statystyki ofert Glovo (${stats.date}):*`,
      '',
      `• *Sprawdzonych zleceń:* *${stats.totalOffers}*`,
      `• ✅ *Opłacalne (≥${CFG.MIN_STAWKA_NETTO_KM.toFixed(2)} zł/km):* *${stats.profitable}*`,
      `• ❌ *Nieopłacalne:* *${stats.unprofitable}*`,
      '',
      '📌 *Decyzje kuriera:*',
      ` • 🟢 *Zaakceptowane:* *${stats.accepted}*`,
      ` • 🔴 *Odrzucone:* *${stats.rejected}*`,
      ` • ⚪ *Bez decyzji:* *${stats.pending}*`,
      '',
      `📈 *Średnia stawka:* *${stats.avgNetRatePerKm.toFixed(2)} zł netto/km*`,
      `🥇 *Najlepsza:* *${stats.bestNetRate.toFixed(2)} zł/km*  |  🥉 *Najgorsza:* *${stats.worstNetRate.toFixed(2)} zł/km*`,
      `🛣️ *Łączny dystans ofert:* *${stats.totalDistanceKm.toFixed(1)} km*`,
      `💰 *Suma stawek brutto:* *${stats.totalGross.toFixed(2)} zł*`,
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // 10. Saldo Portfela Glovo: /saldo [kwota bazowa]
  bot.command('saldo', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const amountParam = parts[1];

    if (amountParam) {
      const val = parseFloat(amountParam.replace(',', '.'));
      if (!isNaN(val)) {
        const effDate = financeService.getEffectiveDate();
        await financeService.setBalanceCheckpoint(ctx.from.id, effDate, val);
        await ctx.reply(`💳 *Ustawiono nowy punkt bazowy salda:* *${val.toFixed(2)} zł* na dzień \`${effDate}\`.`, {
          parse_mode: 'Markdown',
        });
        return;
      }
    }

    const balanceInfo = await financeService.getRollingBalance(ctx.from.id);
    const text = [
      '💼 *Saldo Portfela Glovo:*',
      `💵 *Aktualny stan:* *${balanceInfo.balance.toFixed(2)} zł*`,
      balanceInfo.checkpointDate
        ? `📍 _Ostatni punkt bazowy: ${balanceInfo.checkpointDate}_`
        : '⚠️ _Brak checkpointu – liczone z historii transakcji._',
      '',
      '💡 Aby ustawić nowy punkt odniesienia, wpisz np. `/saldo 127.50`.',
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // 11. Cele zarobkowe: /cel [kwota] | /cel tydzien [kwota] | /cele
  bot.command(['cel', 'target', 'cele'], async (ctx) => {
    const textParts = ctx.message.text.trim().split(/\s+/);

    if (textParts.length === 1) {
      const monthlyProgress = await financeService.getTargetProgress(ctx.from.id, 'MONTHLY');
      const weeklyProgress = await financeService.getTargetProgress(ctx.from.id, 'WEEKLY');

      if (!monthlyProgress && !weeklyProgress) {
        await ctx.reply('🎯 *Brak celów.* Ustaw cel wpisując np. `/cel 4000` lub `/cel tydzien 1200`.', {
          parse_mode: 'Markdown',
        });
        return;
      }

      const cards: string[] = [];
      if (monthlyProgress) cards.push(formatTargetCard(monthlyProgress));
      if (weeklyProgress) cards.push(formatTargetCard(weeklyProgress));

      await ctx.reply(cards.join('\n\n────────────────\n\n'), { parse_mode: 'Markdown' });
      return;
    }

    let periodType: 'MONTHLY' | 'WEEKLY' = 'MONTHLY';
    let amountStr = textParts[1] || '';

    if (textParts.length >= 3) {
      const sub = textParts[1]?.toLowerCase();
      if (sub && ['tydzien', 'week', 'w'].includes(sub)) {
        periodType = 'WEEKLY';
      }
      amountStr = textParts[2] || '';
    }

    const targetAmount = parseFloat(amountStr.replace(',', '.'));
    if (isNaN(targetAmount) || targetAmount <= 0) {
      await ctx.reply('❌ Błędna kwota. Użyj np. `/cel 4000` lub `/cel tydzien 1200`.');
      return;
    }

    await financeService.setEarningTarget(ctx.from.id, periodType, targetAmount);
    const progress = await financeService.getTargetProgress(ctx.from.id, periodType);

    if (progress) {
      await ctx.reply(`✅ *Cel zapisany!*\n\n${formatTargetCard(progress)}`, { parse_mode: 'Markdown' });
    }
  });

  // 12. Przyciski akcji dla zleceń Glovo
  bot.action(/^offer:(accept|reject):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const action = ctx.match[1];
    const offerId = parseInt(ctx.match[2] || '0', 10);
    const isAccepted = action === 'accept';
    const status = isAccepted ? 'ACCEPTED' : 'REJECTED';

    await financeService.updateCourseOfferStatus(offerId, ctx.from.id, status);

    const msg = ctx.callbackQuery.message;
    const currentText = msg && 'text' in msg ? msg.text : '';
    const statusLine = isAccepted ? '🟢 *Status:* *ZAAKCEPTOWANO*' : '🔴 *Status:* *ODRZUCONO*';

    const lines = currentText.split('\n').filter((l) => !l.startsWith('🔘 Status:'));
    lines.push('', `🔘 ${statusLine}`);

    await ctx.editMessageText(lines.join('\n'), {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            isAccepted ? '✅ Zlecenie Zaakceptowane' : '❌ Zlecenie Odrzucone',
            'offer_done'
          ),
        ],
      ]),
    });
  });

  bot.action('offer_done', async (ctx) => {
    await ctx.answerCbQuery('Status tego zlecenia został już zarejestrowany.');
  });

  // 13. Szybkie napiwki (Regex: "n 5.5", "np 3", "napiwek 10")
  bot.hears(/^(?:n|np|napiwek)\s+(\d+(?:[.,]\d+)?)$/i, async (ctx) => {
    const rawAmount = ctx.match[1]?.replace(',', '.') || '0';
    const tipAmount = parseFloat(rawAmount);

    if (isNaN(tipAmount) || tipAmount <= 0) return;

    const effectiveDate = financeService.getEffectiveDate();
    await financeService.saveCashTip(ctx.from.id, effectiveDate, tipAmount);

    await ctx.reply(`💵 *Dodano napiwek:* \`+${tipAmount.toFixed(2)} zł\`\n📅 *Data:* \`${effectiveDate}\``, {
      parse_mode: 'Markdown',
    });
  });

  // 14. Import Portfela Inline
  bot.action(/^wallet_(confirm|cancel)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const action = ctx.match[1];
    const pending = pendingWalletImports.get(String(ctx.from.id));

    if (!pending || Date.now() > pending.expiresAt) {
      await ctx.editMessageText('⌛ *Ta prośba o potwierdzenie wygasła.* Wyślij zrzut ponownie.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    pendingWalletImports.delete(String(ctx.from.id));

    if (action === 'cancel') {
      await ctx.editMessageText('✖️ *Anulowano import.* Nic nie zmieniono.', { parse_mode: 'Markdown' });
      return;
    }

    const saveResult = await financeService.saveWalletTransactions(ctx.from.id, pending.transactions);
    await ctx.editMessageText(
      `✅ *Zapisano ${saveResult.added} transakcji do bazy.*\n📅 *Zaktualizowane dni:* \`${saveResult.dates.join(', ')}\``,
      { parse_mode: 'Markdown' }
    );
  });

  // 15. Voice-to-Data (Audio / Głos)
  bot.on([message('voice'), message('audio')], async (ctx) => {
    const voiceMsg = 'voice' in ctx.message ? ctx.message.voice : ctx.message.audio;
    if (!voiceMsg) return;

    const processingMsg = await ctx.reply('🎙️ *Przetwarzam notatkę głosową...*', { parse_mode: 'Markdown' });

    try {
      const fileLink = await ctx.telegram.getFileLink(voiceMsg.file_id);
      const res = await fetch(fileLink.href);
      const audioBuffer = Buffer.from(await res.arrayBuffer());

      const mimeType = 'mime_type' in voiceMsg && voiceMsg.mime_type ? voiceMsg.mime_type : 'audio/ogg';
      const extracted = await geminiService.parseVoiceNote(audioBuffer, mimeType);

      if (extracted.action === 'DELETE' && extracted.deleteTarget) {
        const delResult = await financeService.handleVoiceDeletion(
          ctx.from.id,
          extracted.deleteTarget,
          extracted.targetDate
        );
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          processingMsg.message_id,
          undefined,
          `🗣️ _"${extracted.transcription}"_\n\n${delResult.success ? '🗑️' : '⚠️'} ${delResult.message}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const result = await financeService.saveVoiceEvent(ctx.from.id, extracted);
      const lines: string[] = [
        `🗣️ *Transkrypcja:* _"${extracted.transcription}"_`,
        `📅 *Data wpisu:* \`${result.date}\``,
        '',
      ];

      if (extracted.fuelPrice != null || extracted.fuelLiters != null || extracted.fuelDistance != null) {
        lines.push('⛽ *Zaktualizowano paliwo:*');
        if (extracted.fuelPrice != null) lines.push(` • Koszt: *${extracted.fuelPrice.toFixed(2)} zł*`);
        if (extracted.fuelLiters != null) lines.push(` • Ilość: *${extracted.fuelLiters} L*`);
        if (extracted.fuelDistance != null) lines.push(` • Licznik: *${extracted.fuelDistance} km*`);
      }

      if (extracted.grossEarnings != null) lines.push(`💰 *Zarobek brutto:* *${extracted.grossEarnings.toFixed(2)} zł*`);
      if (extracted.workFrom && extracted.workTo) lines.push(`⏱️ *Godziny:* \`${extracted.workFrom} - ${extracted.workTo}\``);
      if (extracted.cashTip != null) lines.push(`💵 *Napiwek gotówkowy:* *+${extracted.cashTip.toFixed(2)} zł*`);

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        lines.join('\n'),
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('[VoiceHandler Error]:', err);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        '❌ *Błąd przetwarzania audio.* Spróbuj ponownie.',
        { parse_mode: 'Markdown' }
      );
    }
  });

  // 16. Vision: Zdjęcia
  bot.on(message('photo'), async (ctx) => {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    if (!photo) return;
    const caption = ctx.message.caption || '';
    const processingMsg = await ctx.reply('🔍 *Analizuję obraz...*', { parse_mode: 'Markdown' });

    try {
      const fileLink = await ctx.telegram.getFileLink(photo.file_id);
      const res = await fetch(fileLink.href);
      const imageBuffer = Buffer.from(await res.arrayBuffer());

      const category = await geminiService.classifyImage(imageBuffer, caption);

      if (category === 'WALLET') {
        const transactions = await geminiService.analyzeWalletScreenshot(imageBuffer);

        if (!transactions.length) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            processingMsg.message_id,
            undefined,
            '⚠️ *Nie rozpoznano żadnych pozycji w zrzucie Portfela.*',
            { parse_mode: 'Markdown' }
          );
          return;
        }

        const preview = await financeService.previewWalletImport(ctx.from.id, transactions);

        if (preview.newTransactions.length === 0) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            processingMsg.message_id,
            undefined,
            `ℹ️ *Wszystkie ${transactions.length} transakcji z tego zrzutu są już zapisane w bazie.* (Brak duplikatów).`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        pendingWalletImports.set(String(ctx.from.id), {
          transactions: preview.newTransactions,
          expiresAt: Date.now() + 15 * 60 * 1000,
        });

        const lines: string[] = [
          '📥 *Rozpoznano transakcje Portfela Glovo:*',
          '',
          ...preview.newTransactions.map(
            (t) => `• \`${t.date} ${t.time}\` *${t.type}* ➔ *${t.amount > 0 ? '+' : ''}${t.amount.toFixed(2)} zł*`
          ),
          '',
          `➕ *Nowe:* ${preview.newTransactions.length} szt.  |  ⏭ *Pominięte duplikaty:* ${preview.existingCount}`,
          `💵 *Wpływ na saldo:* *${preview.totalAmountDelta > 0 ? '+' : ''}${preview.totalAmountDelta.toFixed(2)} zł*`,
        ];

        await ctx.telegram.editMessageText(
          ctx.chat.id,
          processingMsg.message_id,
          undefined,
          lines.join('\n'),
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('✅ Zapisz transakcje', 'wallet_confirm'),
                Markup.button.callback('✖️ Anuluj', 'wallet_cancel'),
              ],
            ]),
          }
        );
        return;
      }

      if (category === 'FUEL') {
        const receipt = await geminiService.extractFuelReceipt(imageBuffer);
        const effectiveDate = receipt.date || financeService.getEffectiveDate();

        await financeService.saveFuelReceipt(
          ctx.from.id,
          effectiveDate,
          receipt.fuelPrice || 0,
          receipt.fuelLiters || null
        );

        const lines = [
          '🧾 *Zarejestrowano paragon paliwowy:*',
          `📅 *Data:* \`${effectiveDate}\``,
          `💰 *Kwota:* *${receipt.fuelPrice ? receipt.fuelPrice.toFixed(2) : '0.00'} zł*`,
        ];
        if (receipt.fuelLiters) lines.push(`⛽ *Litry:* *${receipt.fuelLiters} L*`);

        await ctx.telegram.editMessageText(
          ctx.chat.id,
          processingMsg.message_id,
          undefined,
          lines.join('\n'),
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Oferta kursu Glovo
      const offer = await geminiService.analyzeCourseOffer(imageBuffer);
      const userLoc = lastCourierLocation.get(String(ctx.from.id));
      const hasRecentLocation = userLoc && Date.now() - userLoc.updatedAt <= 30 * 60 * 1000;

      let totalKm = offer.appDistanceKm || 0;
      let calculatedViaMaps = false;

      if (hasRecentLocation && userLoc) {
        const origin = `${userLoc.latitude},${userLoc.longitude}`;
        const routeData = await mapsService.verifyOfferDistance(
          { lat: userLoc.latitude, lng: userLoc.longitude, ts: userLoc.updatedAt },
          [
            { rodzaj: 'odbior', adres: offer.pickupAddress, dystans_km: offer.appDistanceKm },
            { rodzaj: 'dostawa', adres: offer.deliveryAddress }
          ]
        );
        if (routeData && routeData.available && routeData.results[0]?.actual != null) {
          totalKm = routeData.results[0].actual;
          calculatedViaMaps = true;
        }
      }

      const netAmount = Math.round(offer.grossAmount * CFG.NETTO_FACTOR * 100) / 100;
      const netRatePerKm = totalKm > 0 ? Math.round((netAmount / totalKm) * 100) / 100 : 0;
      const isProfitable = netRatePerKm >= CFG.MIN_STAWKA_NETTO_KM;

      const offerId = await financeService.saveCourseOffer(ctx.from.id, {
        grossAmount: offer.grossAmount,
        netAmount,
        totalDistance: totalKm,
        netRatePerKm,
        isProfitable,
        pickupAddress: offer.pickupAddress,
        deliveryAddress: offer.deliveryAddress,
      });

      const responseLines = [
        isProfitable ? '✅ *KURS OPŁACALNY*' : '❌ *KURS SŁABY / ODRZUĆ*',
        '',
        `💵 *Stawka:* *${offer.grossAmount.toFixed(2)} zł brutto* ➔ *${netAmount.toFixed(2)} zł netto*`,
        `📍 *Trasa:* \`${offer.pickupAddress}\` ➔ \`${offer.deliveryAddress}\``,
        `🛣️ *Dystans:* *${totalKm.toFixed(1)} km* ${calculatedViaMaps ? '_(zweryfikowany Google Maps)_' : '_(z aplikacji)_'}`,
        `📊 *Stawka netto/km:* *${netRatePerKm.toFixed(2)} zł / km* (Min: ${CFG.MIN_STAWKA_NETTO_KM.toFixed(2)} zł)`,
        '',
        '🔘 *Status:* _Oczekuje na decyzję_',
      ];

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        responseLines.join('\n'),
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ Zaakceptowano', `offer:accept:${offerId}`),
              Markup.button.callback('❌ Odrzucono', `offer:reject:${offerId}`),
            ],
          ]),
        }
      );
    } catch (err) {
      console.error('[PhotoHandler Error]:', err);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        '❌ *Błąd analizy obrazu.* Spróbuj ponownie.',
        { parse_mode: 'Markdown' }
      );
    }
  });
}

export const mapsService = {
  verifyOfferDistance: async (
    userLoc: { lat: number; lng: number; ts: number } | null,
    points: Array<{ rodzaj: string; nazwa?: string | null; adres?: string | null; dystans_km?: number | null }>
  ) => {
    const { verifyOfferDistance } = await import('./maps.service.js');
    return verifyOfferDistance(userLoc, points);
  },
};