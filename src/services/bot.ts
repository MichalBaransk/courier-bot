import { Telegraf, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { geminiService, WalletTransactionItem } from './gemini.service';
import { financeService, TargetProgress } from './finance.service';
import { mapsService } from './maps.service';
import { NETTO_FACTOR, MIN_STAWKA_NETTO_KM } from '../config';

interface CourierLocation {
  latitude: number;
  longitude: number;
  updatedAt: number;
}

const lastCourierLocation: Map<string, CourierLocation> = new Map();
const pendingWalletImports: Map<string, { transactions: WalletTransactionItem[]; expiresAt: number }> = new Map();

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
      `🏆 *CEL OSIĄGNIĘTY!*`,
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

export function registerBotHandlers(bot: Telegraf): void {
  // 1. Pomoc i Menu
  bot.command(['start', 'pomoc', 'help'], async (ctx) => {
    const text = [
      '🤖 *GlovoBot – Asystent Kuriera*',
      '',
      '📍 *Lokalizacja:*',
      ' • `/lokalizacja` – wywołaj przycisk wysłania pinezki GPS.',
      '',
      '🎯 *Cele zarobkowe:*',
      ' • `/cel 4500` – ustaw cel miesięczny netto.',
      ' • `/cel tydzien 1200` – ustaw cel tygodniowy netto.',
      ' • `/cele` – sprawdź postęp i wymagane tempo.',
      '',
      '📊 *Raporty i historia:*',
      ' • `/dzis` – podsumowanie dzisiejszej zmiany.',
      ' • `/dzien 2026-08-06` – podsumowanie konkretnego dnia.',
      ' • `/tydzien` – bieżący tydzień (pon–ndz).',
      ' • `/ptydzien` – poprzedni tydzień (pon–ndz).',
      ' • `/miesiac` lub `/miesiac 2026-07` – podsumowanie miesiąca.',
      ' • `/statystyki` lub `/statystyki 2026-08-06` – statystyki ofert Glovo.',
      ' • `/saldo` lub `/saldo 150.00` – podgląd / ustawienie salda Glovo.',
      '',
      '🎙️ *Głos (Voice-to-Data):* Notatki tankowania, zarobków i cofania.',
      '📸 *Zdjęcia:* Zrzuty Portfela, paragony paliwowe, oferty zleceń.',
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // 2. Przycisk geolokalizacji na żądanie
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

  // 3. Obsługa lokalizacji
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

  // 4. Raport: /dzis oraz /dzien [RRRR-MM-DD]
  bot.command(['dzis', 'dzien'], async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const date = parts.length > 1 && /^\d{4}-\d{2}-\d{2}$/.test(parts[1]) ? parts[1] : financeService.getEffectiveDate();
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
        ? `⏱️ *Czas pracy:* *${summary.workHours.toFixed(2)} h* (Stawka: *${summary.hourlyRateNetto.toFixed(2)} zł netto/h*)`
        : '⏱️ *Czas pracy:* _Brak wpisu_',
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

  // 5. Raport: /tydzien oraz /ptydzien
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

  // 6. Raport: /miesiac [RRRR-MM]
  bot.command('miesiac', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    let startDate = '';
    let endDate = '';

    if (parts.length > 1 && /^\d{4}-\d{2}$/.test(parts[1])) {
      const [year, month] = parts[1].split('-').map(Number);
      startDate = `${parts[1]}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      endDate = `${parts[1]}-${String(lastDay).padStart(2, '0')}`;
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

  // 7. Statystyki ofert Glovo: /statystyki [RRRR-MM-DD]
  bot.command('statystyki', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const date = parts.length > 1 && /^\d{4}-\d{2}-\d{2}$/.test(parts[1]) ? parts[1] : financeService.getEffectiveDate();
    const stats = await financeService.getCourseOfferStats(ctx.from.id, date);

    if (stats.totalOffers === 0) {
      await ctx.reply(`ℹ️ *Brak zapisanych ofert kursów w dniu* \`${date}\`.`, { parse_mode: 'Markdown' });
      return;
    }

    const text = [
      `📊 *Statystyki ofert Glovo (${stats.date}):*`,
      '',
      `• *Sprawdzonych zleceń:* *${stats.totalOffers}*`,
      `• ✅ *Opłacalne (≥${MIN_STAWKA_NETTO_KM.toFixed(2)} zł/km):* *${stats.profitable}*`,
      `• ❌ *Nieopłacalne:* *${stats.unprofitable}*`,
      '',
      `📈 *Średnia stawka:* *${stats.avgNetRatePerKm.toFixed(2)} zł netto/km*`,
      `🥇 *Najlepsza:* *${stats.bestNetRate.toFixed(2)} zł/km*  |  🥉 *Najgorsza:* *${stats.worstNetRate.toFixed(2)} zł/km*`,
      `🛣️ *Łączny dystans ofert:* *${stats.totalDistanceKm.toFixed(1)} km*`,
      `💰 *Suma stawek brutto:* *${stats.totalGross.toFixed(2)} zł*`,
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // 8. Saldo Portfela Glovo: /saldo [kwota bazowa]
  bot.command('saldo', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);

    if (parts.length > 1) {
      const val = parseFloat(parts[1].replace(',', '.'));
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

  // 9. Cele zarobkowe: /cel [kwota] | /cel tydzien [kwota] | /cele
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
    let amountStr = textParts[1];

    if (textParts.length >= 3) {
      if (['tydzien', 'week', 'w'].includes(textParts[1].toLowerCase())) {
        periodType = 'WEEKLY';
      }
      amountStr = textParts[2];
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

  // 10. Szybkie napiwki (Regex: "n 5.5", "np 3", "napiwek 10")
  bot.hears(/^(?:n|np|napiwek)\s+(\d+(?:[.,]\d+)?)$/i, async (ctx) => {
    const rawAmount = ctx.match[1].replace(',', '.');
    const tipAmount = parseFloat(rawAmount);

    if (isNaN(tipAmount) || tipAmount <= 0) return;

    const effectiveDate = financeService.getEffectiveDate();
    await financeService.saveCashTip(ctx.from.id, effectiveDate, tipAmount);

    await ctx.reply(`💵 *Dodano napiwek:* \`+${tipAmount.toFixed(2)} zł\`\n📅 *Data:* \`${effectiveDate}\``, {
      parse_mode: 'Markdown',
    });
  });

  // 11. Potwierdzenie importu Portfela tekstowo ("tak" / "nie")
  bot.hears(/^(tak|t|zapisz|ok|yes|y|nie|n|anuluj)$/i, async (ctx) => {
    const pending = pendingWalletImports.get(String(ctx.from.id));
    if (!pending || Date.now() > pending.expiresAt) return;

    const text = ctx.match[1].toLowerCase();
    pendingWalletImports.delete(String(ctx.from.id));

    if (['nie', 'n', 'anuluj'].includes(text)) {
      await ctx.reply('✖️ *Anulowano import Portfela.* Nic nie zostało zapisane.', { parse_mode: 'Markdown' });
      return;
    }

    const saveResult = await financeService.saveWalletTransactions(ctx.from.id, pending.transactions);
    await ctx.reply(
      `✅ *Zapisano ${saveResult.added} transakcji do bazy.*\n📅 *Dotknięte dni:* \`${saveResult.dates.join(', ')}\``,
      { parse_mode: 'Markdown' }
    );
  });

  // 12. Przyciski Inline (Potwierdzenie importu Portfela)
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

  // 13. Voice-to-Data (Audio / Głos)
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

  // 14. Vision: Zdjęcia (Portfel Glovo, Paragony Paliwowe, Oferty Zleceń)
  bot.on(message('photo'), async (ctx) => {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const caption = ctx.message.caption || '';
    const processingMsg = await ctx.reply('🔍 *Analizuję obraz...*', { parse_mode: 'Markdown' });

    try {
      const fileLink = await ctx.telegram.getFileLink(photo.file_id);
      const res = await fetch(fileLink.href);
      const imageBuffer = Buffer.from(await res.arrayBuffer());

      const category = await geminiService.classifyImage(imageBuffer, caption);

      // Ścieżka 1: Zrzut ekranu Portfela Glovo
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

      // Ścieżka 2: Paragon paliwowy
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

      // Ścieżka 3: Oferta kursu Glovo
      const offer = await geminiService.analyzeCourseOffer(imageBuffer);
      const userLoc = lastCourierLocation.get(String(ctx.from.id));
      const hasRecentLocation = userLoc && Date.now() - userLoc.updatedAt <= 30 * 60 * 1000;

      let totalKm = offer.appDistanceKm || 0;
      let calculatedViaMaps = false;

      if (hasRecentLocation && userLoc) {
        const origin = `${userLoc.latitude},${userLoc.longitude}`;
        const routeData = await mapsService.calculateFullDeliveryRoute(
          origin,
          offer.pickupAddress,
          offer.deliveryAddress
        );
        if (routeData) {
          totalKm = routeData.totalDistanceKm;
          calculatedViaMaps = true;
        }
      }

      const netAmount = Math.round(offer.grossAmount * NETTO_FACTOR * 100) / 100;
      const netRatePerKm = totalKm > 0 ? Math.round((netAmount / totalKm) * 100) / 100 : 0;
      const isProfitable = netRatePerKm >= MIN_STAWKA_NETTO_KM;

      await financeService.saveCourseOffer(ctx.from.id, {
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
        `📊 *Stawka netto/km:* *${netRatePerKm.toFixed(2)} zł / km* (Min: ${MIN_STAWKA_NETTO_KM.toFixed(2)} zł)`,
      ];

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        responseLines.join('\n'),
        { parse_mode: 'Markdown' }
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