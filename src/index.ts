import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { registerBotHandlers } from './services/bot';

const botToken = process.env.BOT_TOKEN;
if (!botToken) {
  throw new Error('Brak zmiennej BOT_TOKEN w pliku .env!');
}

const bot = new Telegraf(botToken);

// Rejestracja wszystkich komend, nasłuchu audio, zdjęć i lokalizacji
registerBotHandlers(bot);

// Uruchomienie bota
bot.launch().then(() => {
  console.log('🤖 Bot kurierski wystartował pomyślnie...');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));