import { createHash } from 'node:crypto';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { Telegraf } from 'telegraf';
import { CFG } from './config.js';
import { geminiQueue } from './services/gemini.service.js';
import { API_PREFIX, createApiSetup } from './api/router.js';

/**
 * Tryb webhook.
 *
 * Long polling wymaga, zeby dokladnie jedna instancja odpytywala `getUpdates`.
 * Przy `docker compose up --build` stary kontener potrafi jeszcze chwile zyc
 * obok nowego i wtedy Telegram zwraca 409 Conflict, a czesc wiadomosci ginie.
 * Webhook nie ma tego problemu: Telegram sam puka pod adres, ktory dostal.
 *
 * Ruch wchodzi przez Cloudflare Tunnel, wiec kontener nie wystawia
 * zadnego portu na zewnatrz — tunel siega go po sieci Dockera.
 */

/**
 * Sciezka webhooka. Domyslnie wyprowadzona z tokenu bota, wiec jest
 * nieodgadywalna bez jego znajomosci i stabilna miedzy restartami.
 */
export function webhookPath(botToken: string): string {
  if (process.env.WEBHOOK_PATH) {
    return process.env.WEBHOOK_PATH.startsWith('/')
      ? process.env.WEBHOOK_PATH
      : `/${process.env.WEBHOOK_PATH}`;
  }
  return `/tg/${createHash('sha256').update(botToken).digest('hex').slice(0, 32)}`;
}

/**
 * Sekret przekazywany w naglowku `X-Telegram-Bot-Api-Secret-Token`.
 * Telegraf odrzuca zadania bez niego, wiec nawet ktos, kto zgadnie sciezke,
 * nie wstrzyknie botowi falszywego update'u.
 */
export function webhookSecret(botToken: string): string {
  return (
    process.env.WEBHOOK_SECRET ||
    createHash('sha256').update(`webhook-secret:${botToken}`).digest('hex').slice(0, 48)
  );
}

interface HealthPayload {
  status: 'ok';
  mode: 'webhook';
  uptimeSeconds: number;
  gemini: { running: number; pending: number };
}

function healthPayload(): HealthPayload {
  return {
    status: 'ok',
    mode: 'webhook',
    uptimeSeconds: Math.round(process.uptime()),
    gemini: { running: geminiQueue.running, pending: geminiQueue.pending },
  };
}

/**
 * Serwer HTTP obslugujacy webhook i endpoint zdrowia.
 * `/healthz` uzywa go healthcheck Dockera oraz Cloudflare — dzieki temu
 * tunel nie kieruje ruchu do kontenera, ktory jeszcze nie wstal.
 */
export async function startWebhookServer(bot: Telegraf, botToken: string): Promise<Server> {
  const domain = CFG.WEBHOOK_DOMAIN;
  if (!domain) throw new Error('startWebhookServer wywołane bez WEBHOOK_DOMAIN');

  const path = webhookPath(botToken);
  const secretToken = webhookSecret(botToken);

  // createWebhook rejestruje adres w Telegramie i zwraca handler HTTP.
  const telegrafHandler = await bot.createWebhook({
    domain,
    path,
    secret_token: secretToken,
    drop_pending_updates: process.env.WEBHOOK_DROP_PENDING === 'true',
    // Bot nie reaguje na nic poza tym, wiec nie ma po co odbierac reszty.
    allowed_updates: ['message', 'edited_message', 'callback_query'],
    max_connections: CFG.WEBHOOK_MAX_CONNECTIONS,
  });

  // REST API dla aplikacji mobilnej. Budowane raz, przy starcie.
  const api = createApiSetup();

  const handler: RequestListener = (req, res) => {
    if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/health')) {
      const body = JSON.stringify(healthPayload());
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    if (req.url === path) {
      telegrafHandler(req, res);
      return;
    }

    /**
     * Cala reszta ruchu spod /api/ idzie do Hono.
     *
     * `startsWith` zamiast `===`, bo `req.url` zawiera query string —
     * `/api/v1/okres?od=…` nigdy nie zrownalo by sie ze stala sciezka.
     *
     * Gdyby API mialo kiedykolwiek zaszkodzic botowi, usuniecie tego
     * jednego `if` przywraca zachowanie sprzed zmiany.
     */
    if (req.url?.startsWith(API_PREFIX)) {
      api.listener(req, res);
      return;
    }

    // Skanery trafiajace na losowe sciezki nie maja sie czego dowiedziec.
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  };

  const server = createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(CFG.WEBHOOK_PORT, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });

  console.log(`🌐 Webhook: https://${domain}${path}`);
  console.log(`🩺 Health:  http://0.0.0.0:${CFG.WEBHOOK_PORT}/healthz`);
  console.log(
    api.enabled
      ? `📱 API:     https://${domain}${API_PREFIX}v1/  (Bearer API_TOKEN)`
      : `📱 API:     WYŁĄCZONE — ${api.disabledReason ?? 'nieznany powód'}`
  );

  return server;
}

export async function stopWebhookServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
