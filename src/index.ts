import { bot } from './services/bot.js';

bot.launch();
console.log('🤖 Bot kurierski wystartował pomyślnie...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));