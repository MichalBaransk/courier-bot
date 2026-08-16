import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { CFG } from './config.js';
import { closeDb } from './db/index.js';
import { registerBotHandlers } from './bot/index.js';
import { startWebhookServer, stopWebhookServer } from './server.js';
import type { Server } from 'node:http';

/**
 * Zawezenie typu zrobione na poziomie modulu (`if (!x) throw`) NIE przenosi sie
 * do wnetrza `main()` — w srodku `botToken` mial dalej typ `string | undefined`
 * i `startWebhookServer` zglaszal TS2345.
 *
 * Funkcja zwracajaca `string` rozwiazuje to bez rzutowania `as` i bez `!`,
 * a przy okazji nadaje sie do kazdej innej wymaganej zmiennej srodowiskowej.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Brak zmiennej ${name} w pliku .env!`);
  return value;
}

const botToken = requireEnv('BOT_TOKEN');

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

  const me = await bot.telegram.getMe();
  let webhookServer: Server | null = null;

  if (CFG.WEBHOOK_DOMAIN) {
    // --- Tryb webhook -------------------------------------------------------
    // Telegram sam puka pod nasz adres, wiec zadna instancja nie odpytuje
    // `getUpdates` i konflikt 409 przy podmianie kontenera nie ma jak wystapic.
    webhookServer = await startWebhookServer(bot, botToken);
    console.log(`🤖 @${me.username} działa w trybie WEBHOOK (model: ${CFG.GEMINI_MODEL}, TZ: ${CFG.TZ})`);
  } else {
    // --- Tryb long polling (rozwoj lokalny) ---------------------------------
    // Webhook i polling wykluczaja sie wzajemnie — jesli poprzednio byl
    // ustawiony webhook, `getUpdates` zwracalby 409, dopoki go nie usuniemy.
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });

    /**
     * FIX (3.5): `bot.launch()` w Telegraf 4 rozwiazuje sie dopiero po
     * ZATRZYMANIU pollingu, wiec `.then(...)` logowal przy zamykaniu bota.
     * Do tego brakowalo `.catch()` — bledny token dawal unhandled rejection.
     */
    void bot.launch().catch((err) => {
      console.error('❌ Polling Telegrama przerwany:', err);
      process.exit(1);
    });

    console.log(`🤖 @${me.username} działa w trybie POLLING (model: ${CFG.GEMINI_MODEL}, TZ: ${CFG.TZ})`);
    console.log('💡 Ustaw WEBHOOK_DOMAIN w .env, żeby przełączyć na webhook.');
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} — zamykam bota…`);

    // Webhooka NIE kasujemy: Telegram kolejkuje update'y do 24 h i dostarczy
    // je, gdy kontener wróci. Usunięcie oznaczałoby utratę wiadomości
    // wysłanych w trakcie wdrożenia.
    if (webhookServer) await stopWebhookServer(webhookServer).catch(() => {});
    else bot.stop(signal);

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
