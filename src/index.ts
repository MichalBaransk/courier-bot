import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { CFG } from './config.js';
import { closeDb } from './db/index.js';
import { registerBotHandlers } from './bot/index.js';

const botToken = process.env.BOT_TOKEN;
if (!botToken) {
  throw new Error('Brak zmiennej BOT_TOKEN w pliku .env!');
}

const bot = new Telegraf(botToken);

registerBotHandlers(bot);

/**
 * FIX (3.4): globalny handler bledow.
 * Wczesniej tylko `voice` i `photo` mialy try/catch — komenda `/dzis` przy
 * padnietym polaczeniu z baza po prostu milczala, a slad zostawal w logach.
 */
bot.catch(async (err, ctx) => {
  console.error(`[Bot Error] update=${ctx.updateType}`, err);
  try {
    await ctx.reply('❌ Coś poszło nie tak po mojej stronie. Spróbuj ponownie za chwilę.');
  } catch {
    /* wiadomosc moze byc nie do wyslania (zablokowany bot) — ignorujemy */
  }
});

async function main(): Promise<void> {
  if (CFG.ALLOWED_TELEGRAM_IDS.size === 0) {
    console.warn(
      '⚠️  ALLOWED_TELEGRAM_IDS jest puste — bot przyjmuje wiadomości od KAŻDEGO. ' +
        'Ustaw np. ALLOWED_TELEGRAM_IDS="5066453902".'
    );
  }

  /**
   * FIX (3.5): `bot.launch()` w Telegraf 4 rozwiazuje sie dopiero po ZATRZYMANIU
   * pollingu, wiec `.then(() => console.log('wystartowal'))` logowal przy
   * zamykaniu bota. Do tego brakowalo `.catch()` — bledny token dawal
   * unhandled rejection zamiast czytelnego komunikatu.
   *
   * Dlatego: promise dostaje wlasny catch, a komunikat startowy pochodzi
   * z `getMe()`, ktore od razu weryfikuje token.
   */
  void bot.launch().catch((err) => {
    console.error('❌ Polling Telegrama przerwany:', err);
    process.exit(1);
  });

  const me = await bot.telegram.getMe();
  console.log(`🤖 @${me.username} wystartował (model: ${CFG.GEMINI_MODEL}, TZ: ${CFG.TZ})`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} — zamykam bota…`);
    bot.stop(signal);
    await closeDb().catch((err) => console.error('[DB close]', err));
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('❌ Nie udało się uruchomić bota:', err);
  process.exit(1);
});
