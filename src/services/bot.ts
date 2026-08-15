import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { geminiService } from './gemini.service';
import { financeService } from './finance.service';
import { mapsService } from './maps.service';
import { NETTO_FACTOR, MIN_STAWKA_NETTO_KM } from '../config';

interface CourierLocation {
  latitude: number;
  longitude: number;
  updatedAt: number;
}

const lastCourierLocation: Map<string, CourierLocation> = new Map();

export function registerBotHandlers(bot: Telegraf): void {
  bot.command(['start', 'pomoc', 'help'], async (ctx) => {
    const text = [
      '🤖 *GlovoBot – Asystent Kuriera*',
      '',
      '🎙️ *Głosowe wprowadzanie i usuwanie (Voice-to-Data):*',
      ' • *Dodawanie:* _"Zatankowałem za 75 zł, 11 litrów, licznik 24300"_ lub _"Praca 10:00 do 16:30, zarobek 210 zł"_',
      ' • *Usuwanie/Cofanie:* _"Cofnij ostatni napiwek"_, _"Usuń dzisiejsze paliwo"_, _"Wyczyść godziny"_, _"Usuń cały wczorajszy wpis"_',
      '',
      '📸 *Analiza zdjęć i zrzutów:*',
      ' • *Oferta Glovo:* Prześlij zrzut ekranu – wyliczę opłacalność (zł netto / km).',
      ' • *Paragon paliwowy:* Prześlij zdjęcie z podpisem _"paragon"_ lub _"paliwo"_.',
      '',
      '💵 *Szybkie komendy:*',
      ' • `n 5` / `np 10.50` – natychmiastowy zapis napiwku bez AI.',
      ' • `/dzis` – podsumowanie dzisiejszej zmiany.',
      ' • `/tydzien` – podsumowanie bieżącego tygodnia.',
      ' • `/miesiac` – podsumowanie miesiąca.',
      ' • `/saldo` – aktualny stan portfela Glovo.',
      ' • 📍 *Lokalizacja:* Wyślij pinezkę GPS – bot uwzględni realny dojazd do restauracji przez 30 min.',
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  bot.command('dzis', async (ctx) => {
    const date = financeService.getEffectiveDate();
    const summary = await financeService.getDailySummary(ctx.from.id, date);

    const text = [
      `📅 *Raport dzienny:* \`${summary.date}\``,
      '',
      `💰 *Brutto:* *${summary.grossEarnings.toFixed(2)} zł*`,
      `💵 *Netto (UoP 81.4%):* *${summary.netEarnings.toFixed(2)} zł*`,
      `🪙 *Napiwki gotówka:* *+${summary.cashTipsTotal.toFixed(2)} zł*`,
      `🏁 *Netto łącznie:* *${summary.totalNetto.toFixed(2)} zł*`,
      '',
      `⏱️ *Czas pracy:* *${summary.workHours.toFixed(2)} h*`,
      `📈 *Stawka godzinowa:* *${summary.hourlyRateNetto.toFixed(2)} zł netto/h*`,
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

  bot.command('tydzien', async (ctx) => {
    const now = new Date();
    const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay();
    const monday = new Date(now);
    monday.setDate(monday.getDate() - (dayOfWeek - 1));

    const startDate = monday.toISOString().slice(0, 10);
    const endDate = financeService.getEffectiveDate(now);

    const summary = await financeService.getPeriodSummary(ctx.from.id, startDate, endDate);

    const text = [
      `📊 *Podsumowanie tygodnia (${summary.startDate} - ${summary.endDate}):*`,
      '',
      `💰 *Brutto łączne:* *${summary.totalGross.toFixed(2)} zł*`,
      `💵 *Netto z zleceń:* *${summary.totalNettoEarnings.toFixed(2)} zł*`,
      `🪙 *Napiwki gotówkowe:* *+${summary.totalCashTips.toFixed(2)} zł*`,
      `🏁 *Netto całkowite:* *${summary.grandTotalNetto.toFixed(2)} zł*`,
      '',
      `⏱️ *Przepracowane godziny:* *${summary.totalWorkHours.toFixed(2)} h*`,
      `📈 *Średnia stawka:* *${summary.avgHourlyRateNetto.toFixed(2)} zł netto/h*`,
      `⛽ *Koszty paliwa:* *${summary.totalFuelCost.toFixed(2)} zł*`,
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  bot.command('miesiac', async (ctx) => {
    const now = new Date();
    const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const endDate = financeService.getEffectiveDate(now);

    const summary = await financeService.getPeriodSummary(ctx.from.id, startDate, endDate);

    const text = [
      `🗓️ *Podsumowanie miesiąca (${summary.startDate} - ${summary.endDate}):*`,
      '',
      `💰 *Brutto:* *${summary.totalGross.toFixed(2)} zł*`,
      `💵 *Netto (zlecenia):* *${summary.totalNettoEarnings.toFixed(2)} zł*`,
      `🪙 *Napiwki gotówkowe:* *+${summary.totalCashTips.toFixed(2)} zł*`,
      `🏁 *Czyste Netto:* *${summary.grandTotalNetto.toFixed(2)} zł*`,
      '',
      `⏱️ *Godziny łączone:* *${summary.totalWorkHours.toFixed(2)} h*`,
      `📈 *Średnia netto/h:* *${summary.avgHourlyRateNetto.toFixed(2)} zł/h*`,
      `⛽ *Wydatki na paliwo:* *${summary.totalFuelCost.toFixed(2)} zł*`,
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  bot.command('saldo', async (ctx) => {
    const balanceInfo = await financeService.getRollingBalance(ctx.from.id);
    const text = [
      '💼 *Saldo Portfela Glovo:*',
      `💵 *Aktualny stan:* *${balanceInfo.balance.toFixed(2)} zł*`,
      balanceInfo.checkpointDate
        ? `📍 _Ostatni punkt bazowy z dnia: ${balanceInfo.checkpointDate}_`
        : '⚠️ _Brak checkpointu – liczone z historii transakcji._',
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  bot.on(message('location'), async (ctx) => {
    const { latitude, longitude } = ctx.message.location;
    lastCourierLocation.set(String(ctx.from.id), {
      latitude,
      longitude,
      updatedAt: Date.now(),
    });
    await ctx.reply('📍 *Pozycja GPS zapisana.* Będzie brana pod uwagę przy weryfikacji ofert przez 30 min.', {
      parse_mode: 'Markdown',
    });
  });

  bot.hears(/^(?:n|np|napiwek)\s+(\d+(?:[.,]\d+)?)$/i, async (ctx) => {
    const rawAmount = ctx.match[1].replace(',', '.');
    const tipAmount = parseFloat(rawAmount);

    if (isNaN(tipAmount) || tipAmount <= 0) {
      await ctx.reply('❌ Nieprawidłowa kwota napiwku.');
      return;
    }

    const effectiveDate = financeService.getEffectiveDate();
    await financeService.saveCashTip(ctx.from.id, effectiveDate, tipAmount);

    await ctx.reply(`💵 *Dodano napiwek:* \`+${tipAmount.toFixed(2)} zł\`\n📅 *Data:* \`${effectiveDate}\``, {
      parse_mode: 'Markdown',
    });
  });

  bot.on([message('voice'), message('audio')], async (ctx) => {
    const voiceMsg = 'voice' in ctx.message ? ctx.message.voice : ctx.message.audio;
    if (!voiceMsg) return;

    const processingMsg = await ctx.reply('🎙️ *Przetwarzam notatkę głosową...*', { parse_mode: 'Markdown' });

    try {
      const fileLink = await ctx.telegram.getFileLink(voiceMsg.file_id);
      const res = await fetch(fileLink.href);
      const arrayBuffer = await res.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);

      const mimeType = ('mime_type' in voiceMsg && voiceMsg.mime_type) ? voiceMsg.mime_type : 'audio/ogg';
      const extracted = await geminiService.parseVoiceNote(audioBuffer, mimeType);

      // Ścieżka 1: Usuwanie / Cofanie wpisów głosem
      if (extracted.action === 'DELETE' && extracted.deleteTarget) {
        const delResult = await financeService.handleVoiceDeletion(
          ctx.from.id,
          extracted.deleteTarget,
          extracted.targetDate
        );

        const lines = [
          `🗣️ *Transkrypcja:* _"${extracted.transcription}"_`,
          '',
          delResult.success ? `🗑️ *Sukces:* ${delResult.message}` : `⚠️ *Informacja:* ${delResult.message}`,
        ];

        await ctx.telegram.editMessageText(
          ctx.chat.id,
          processingMsg.message_id,
          undefined,
          lines.join('\n'),
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Ścieżka 2: Dodawanie / Aktualizacja danych (UPSERT)
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

      if (extracted.grossEarnings != null) {
        lines.push(`💰 *Zarobek brutto:* *${extracted.grossEarnings.toFixed(2)} zł*`);
      }

      if (extracted.workFrom && extracted.workTo) {
        lines.push(`⏱️ *Godziny pracy:* \`${extracted.workFrom} - ${extracted.workTo}\``);
      }

      if (extracted.cashTip != null) {
        lines.push(`💵 *Napiwek gotówkowy:* *+${extracted.cashTip.toFixed(2)} zł*`);
      }

      if (!result.hasDailyUpdate && !result.hasTip) {
        lines.push('⚠️ _Zanotowano wypowiedź, ale nie wykryto parametrów finansowych ani licznikowych do zapisu._');
      }

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
        '❌ *Błąd przetwarzania audio:* Nie udało się odczytać danych lub zaktualizować bazy.',
        { parse_mode: 'Markdown' }
      );
    }
  });

  bot.on(message('photo'), async (ctx) => {
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const caption = ctx.message.caption?.toLowerCase() || '';

    const processingMsg = await ctx.reply('🔍 *Analizuję przesłany obraz...*', { parse_mode: 'Markdown' });

    try {
      const fileLink = await ctx.telegram.getFileLink(photo.file_id);
      const res = await fetch(fileLink.href);
      const arrayBuffer = await res.arrayBuffer();
      const imageBuffer = Buffer.from(arrayBuffer);

      if (caption.includes('paragon') || caption.includes('paliwo') || caption.includes('stacja')) {
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
        `🛣️ *Dystans:* *${totalKm.toFixed(1)} km* ${
          calculatedViaMaps ? '_(weryfikacja Google Maps)_' : '_(z aplikacji)_'
        }`,
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
        '❌ *Błąd analizy obrazu:* Nie udało się odczytać parametrów zlecenia.',
        { parse_mode: 'Markdown' }
      );
    }
  });
}