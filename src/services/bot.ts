import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import 'dotenv/config';
import {
  getWorkDate,
  parseQuickTip,
  saveCashTip,
  undoLastCashTip,
  getTipsForDay,
  saveDailyRecord,
  getDaySummaryText,
  getWeekSummaryText,
  parseQuickWorkRange,
  calculateHoursFromRange,
  fmt,
  round2,
  saveCourseOffer,
} from './finance.service.js';
import { processVisionDocument, processVoiceOrText } from './gemini.service.js';
import { verifyOfferDistance } from './maps.service.js';
import { CFG } from '../config.js';

export const bot = new Telegraf(process.env.BOT_TOKEN!);

// Pamięć sesji użytkownika
const userLocations = new Map<number, { lat: number; lng: number; ts: number }>();
const awaitingHours = new Map<number, string>(); // telegramId -> dateStr

bot.start(async (ctx) => {
  await ctx.reply(
    `🤖 *Witaj w asystencie kuriera!*\n\n` +
    `Możesz wysyłać:\n` +
    `• Wiadomości tekstowe i głosowe (np. _„zarobiłem 280 zł, 350 km, tankowanie 150 zł”_)\n` +
    `• Szybkie napiwki: \`n 5.50\`, \`np 3\`\n` +
    `• Zrzuty ekranu ofert Glovo, paragonów paliwa oraz Portfela\n` +
    `• Udostępnienie lokalizacji GPS do weryfikacji tras kursów\n\n` +
    `Wpisz /pomoc, aby zobaczyć pełną listę komend.`,
    { parse_mode: 'Markdown' }
  );
});

bot.command(['pomoc', 'help'], async (ctx) => {
  await ctx.reply(
    `📋 *Dostępne komendy:*\n\n` +
    `• /dzis — Podsumowanie dzisiejszego dnia\n` +
    `• /tydzien — Podsumowanie bieżącego tygodnia\n` +
    `• /ptydzien — Podsumowanie poprzedniego tygodnia\n` +
    `• /napiwki — Lista napiwków z dzisiaj\n` +
    `• /napiwki cofnij — Cofnięcie ostatniego napiwku\n` +
    `• /lokalizacja — Prośba o przesłanie punktu GPS`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('dzis', async (ctx) => {
  const summary = await getDaySummaryText(ctx.from.id, getWorkDate());
  await ctx.reply(summary, { parse_mode: 'Markdown' });
});

bot.command('tydzien', async (ctx) => {
  const summary = await getWeekSummaryText(ctx.from.id, 0);
  await ctx.reply(summary, { parse_mode: 'Markdown' });
});

bot.command('ptydzien', async (ctx) => {
  const summary = await getWeekSummaryText(ctx.from.id, -1);
  await ctx.reply(summary, { parse_mode: 'Markdown' });
});

bot.command('napiwki', async (ctx) => {
  const parts = ctx.text.split(' ');
  const args = parts[1];
  if (args === 'cofnij') {
    const res = await undoLastCashTip(ctx.from.id);
    await ctx.reply(res);
    return;
  }
  const dateStr = args && /^\d{4}-\d{2}-\d{2}$/.test(args) ? args : getWorkDate();
  const res = await getTipsForDay(ctx.from.id, dateStr);
  await ctx.reply(res);
});

bot.command('lokalizacja', async (ctx) => {
  await ctx.reply('📍 Wyślij swoją lokalizację GPS przyciskiem poniżej:', {
    reply_markup: {
      keyboard: [[{ text: '📍 Wyślij lokalizację', request_location: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
});

// Obsługa pinezki GPS
bot.on(message('location'), async (ctx) => {
  userLocations.set(ctx.from.id, {
    lat: ctx.message.location.latitude,
    lng: ctx.message.location.longitude,
    ts: Date.now(),
  });
  await ctx.reply('📍 Zaktualizowano lokalizację GPS. Będzie aktywna przez 30 minut.');
});

// Obsługa wiadomości tekstowych
bot.on(message('text'), async (ctx) => {
  const text = ctx.message.text.trim();
  const telegramId = ctx.from.id;
  const today = getWorkDate();

  // 1. Szybki napiwek regex (np. "n 5.5")[cite: 1]
  const quickTip = parseQuickTip(text);
  if (quickTip !== null) {
    const result = await saveCashTip(telegramId, quickTip, today);
    await ctx.reply(
      `💸 Zapisano napiwek: *${fmt(quickTip)} zł* (Dzisiaj łącznie: *${fmt(result.sum)} zł*, ${result.count} szt.)`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // 2. Odpowiedź na pytanie o godziny[cite: 1]
  if (awaitingHours.has(telegramId)) {
    const pendingDate = awaitingHours.get(telegramId)!;
    const timeRange = parseQuickWorkRange(text);
    let hours: number | null = null;
    let from: string | null = null;
    let to: string | null = null;

    if (timeRange) {
      from = timeRange.from;
      to = timeRange.to;
      hours = calculateHoursFromRange(from, to);
    } else {
      const parsedHours = parseFloat(text.replace(',', '.'));
      if (!isNaN(parsedHours) && parsedHours >= 0.25 && parsedHours <= 24) {
        hours = round2(parsedHours);
      }
    }

    if (hours !== null) {
      awaitingHours.delete(telegramId);
      await saveDailyRecord(telegramId, pendingDate, { workHours: hours, workFrom: from, workTo: to });
      await ctx.reply(`⏱ Zapisano *${fmt(hours)} h* pracy na dzień ${pendingDate}.`, { parse_mode: 'Markdown' });
      const summary = await getDaySummaryText(telegramId, pendingDate);
      await ctx.reply(summary, { parse_mode: 'Markdown' });
      return;
    }
  }

  // 3. Pełna analiza AI przez Gemini
  await ctx.sendChatAction('typing');
  try {
    const aiRes = await processVoiceOrText({ text }, today);
    const targetDate = aiRes.data || today;

    let workHours = aiRes.godziny_pracy || null;
    if (aiRes.praca_od && aiRes.praca_do) {
      workHours = calculateHoursFromRange(aiRes.praca_od, aiRes.praca_do);
    }

    await saveDailyRecord(telegramId, targetDate, {
      grossEarnings: aiRes.zarobki_brutto,
      fuelPrice: aiRes.paliwo_cena,
      fuelLiters: aiRes.paliwo_l,
      fuelDistance: aiRes.paliwo_dystans,
      workFrom: aiRes.praca_od,
      workTo: aiRes.praca_do,
      workHours,
    });

    if (aiRes.napiwek_gotowka) {
      await saveCashTip(telegramId, aiRes.napiwek_gotowka, targetDate);
    }

    const summary = await getDaySummaryText(telegramId, targetDate);
    await ctx.reply(summary, { parse_mode: 'Markdown' });

    // Jeśli podano zarobek, ale brakuje godzin – dopytaj[cite: 1]
    if (aiRes.zarobki_brutto && !workHours) {
      awaitingHours.set(telegramId, targetDate);
      await ctx.reply(
        `🕐 Ile godzin przepracowałeś ${targetDate}? (odpisz liczbą np. \`7.5\` lub zakresem \`16:00-22:30\`)`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (err) {
    console.error('Błąd Gemini:', err);
    await ctx.reply('❌ Wystąpił błąd podczas analizy wiadomości.');
  }
});

// Obsługa zdjęć i dokumentów (oferty, paragony, portfel)[cite: 1]
bot.on([message('photo'), message('document')], async (ctx) => {
  await ctx.sendChatAction('typing');
  try {
    let fileId: string | undefined;
    let mimeType = 'image/jpeg';

    if ('photo' in ctx.message) {
      const photos = ctx.message.photo;
      fileId = photos[photos.length - 1].file_id;
    } else if ('document' in ctx.message && ctx.message.document.mime_type?.startsWith('image/')) {
      fileId = ctx.message.document.file_id;
      mimeType = ctx.message.document.mime_type;
    }

    if (!fileId) return;

    const fileUrl = await ctx.telegram.getFileLink(fileId);
    const res = await fetch(fileUrl.toString());
    const buffer = Buffer.from(await res.arrayBuffer());

    const caption = 'caption' in ctx.message ? ctx.message.caption : undefined;
    const today = getWorkDate();
    const parsed = await processVisionDocument(buffer, mimeType, caption, today);

    // Oferta kursu[cite: 1]
    if (parsed.kwota_brutto && parsed.punkty?.length) {
      const gross = round2(parsed.kwota_brutto);
      const net = round2(gross * CFG.NETTO_FACTOR);
      const totalKm = round2(parsed.punkty.reduce((a: number, c: any) => a + (Number(c.dystans_km) || 0), 0));
      const rate = totalKm > 0 ? round2(net / totalKm) : null;
      const isProfitable = rate !== null && rate >= CFG.MIN_STAWKA_NETTO_KM;

      let reply = isProfitable
        ? `✅ <b>OPŁACALNY</b> — <b>${fmt(rate)} zł netto/km</b>\n`
        : `❌ <b>NIEOPŁACALNY</b> — <b>${fmt(rate)} zł netto/km</b>\n`;
      reply += `<i>(${fmt(gross)} zł brutto = ${fmt(net)} zł netto / ${fmt(totalKm)} km)</i>\n`;

      const userLoc = userLocations.get(ctx.from.id) || null;
      const ver = await verifyOfferDistance(userLoc, parsed.punkty);
      let verText: string | null = null;

      if (ver.available && ver.results.length > 0) {
        reply += `\n🔎 <b>Weryfikacja GPS:</b>`;
        const verLines: string[] = [];
        ver.results.forEach((r) => {
          const l = `• ${r.name}: zgłoszone ${fmt(r.reported)} km / GPS ${fmt(r.actual)} km (różnica ${fmt(r.diff)} km)`;
          reply += `\n${l}`;
          verLines.push(l);
        });
        verText = verLines.join('\n');
      } else if (!ver.available) {
        reply += `\n\n📍 <i>Brak aktywnej lokalizacji GPS — wyślij /lokalizacja, aby weryfikować dojazd.</i>`;
      }

      // Zapis do tabeli course_offers
      const now = new Date();
      const timeStr = `${('0' + now.getHours()).slice(-2)}:${('0' + now.getMinutes()).slice(-2)}`;
      await saveCourseOffer({
        telegramId: ctx.from.id,
        date: today,
        time: timeStr,
        grossAmount: gross,
        netAmount: net,
        totalDistance: totalKm > 0 ? totalKm : null,
        netRatePerKm: rate,
        isProfitable,
        pointsJson: parsed.punkty,
        verificationText: verText,
      });

      await ctx.reply(reply, { parse_mode: 'HTML' });
      return;
    }

    // Paragon paliwowy[cite: 1]
    if (parsed.paliwo_cena || parsed.paliwo_l) {
      const targetDate = parsed.data || today;
      await saveDailyRecord(ctx.from.id, targetDate, {
        fuelPrice: parsed.paliwo_cena,
        fuelLiters: parsed.paliwo_l,
      });
      await ctx.reply(
        `⛽ <b>Zapisano tankowanie:</b> ${fmt(parsed.paliwo_cena)} zł | ${fmt(parsed.paliwo_l)} l (${targetDate})`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    await ctx.reply('🤔 Nie rozpoznano danych oferty ani paragonu na zdjęciu.');
  } catch (err) {
    console.error('Błąd analizy zdjęcia:', err);
    await ctx.reply('❌ Wystąpił błąd podczas analizy przesłanego obrazu.');
  }
});