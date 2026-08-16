import type { Context, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { CFG, isAllowedUser } from '../config.js';
import { financeService } from '../services/finance.service.js';
import { computeOfferRate } from '../services/finance.calc.js';
import { geminiService, geminiQueue } from '../services/gemini.service.js';
import { verifyOfferDistance } from '../services/maps.service.js';
import { ensureUser } from '../services/user.service.js';
import { isValidDateStr, monthRange, normalizeTime, nowTimeWarsaw, splitDate } from '../utils/datetime.js';
import { b, code, h, i, joinLines, zl, zlSigned, SEPARATOR } from '../utils/format.js';
import type { WalletTransactionItem } from '../services/gemini.service.js';
import {
  cancelInputKeyboard,
  endShiftKeyboard,
  locationRequestKeyboard,
  mainMenuKeyboard,
  offerDecisionKeyboard,
  offerDoneKeyboard,
  removeKeyboard,
  startShiftKeyboard,
  walletImportKeyboard,
} from './keyboards.js';
import {
  dailyCard,
  endShiftCard,
  helpCard,
  offerCard,
  offerStatsCard,
  periodCard,
  startShiftCard,
  targetCard,
} from './cards.js';

const HTML = { parse_mode: 'HTML' as const };

// --- Stan ulotny -------------------------------------------------------------

interface CourierLocation {
  latitude: number;
  longitude: number;
  updatedAt: number;
}

type AwaitedInput =
  | 'START_CUSTOM_TIME'
  | 'START_WALLET_BALANCE'
  | 'END_CUSTOM_TIME'
  | 'END_DISTANCE'
  | 'END_GROSS'
  | 'END_WALLET_BALANCE'
  | 'FUEL_MANUAL';

interface PendingInput {
  kind: AwaitedInput;
  expiresAt: number;
}

interface PendingWalletImport {
  transactions: WalletTransactionItem[];
  expiresAt: number;
}

const lastCourierLocation = new Map<string, CourierLocation>();
const awaitingInput = new Map<string, PendingInput>();
const pendingWalletImports = new Map<string, PendingWalletImport>();

/**
 * FIX (3.2): mapy nigdy nie byly sprzatane z wygaslych wpisow.
 * Przy dlugo dzialajacym procesie to powolny wyciek pamieci.
 *
 * UWAGA: to dalej stan w pamieci procesu — restart go kasuje. Przy jednym
 * uzytkowniku jest to akceptowalne; przy wiekszej skali te trzy mapy powinny
 * trafic do Postgresa albo Redisa.
 */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of awaitingInput) if (value.expiresAt <= now) awaitingInput.delete(key);
  for (const [key, value] of pendingWalletImports) if (value.expiresAt <= now) pendingWalletImports.delete(key);
  for (const [key, value] of lastCourierLocation) {
    if (now - value.updatedAt > CFG.LOCATION_MAX_AGE_MS) lastCourierLocation.delete(key);
  }
}, 60_000);
sweeper.unref();

function setAwaiting(tId: string, kind: AwaitedInput): void {
  awaitingInput.set(tId, { kind, expiresAt: Date.now() + CFG.AWAITING_INPUT_TTL_MS });
}

function takeAwaiting(tId: string): AwaitedInput | null {
  const pending = awaitingInput.get(tId);
  if (!pending) return null;
  if (pending.expiresAt <= Date.now()) {
    awaitingInput.delete(tId);
    return null;
  }
  return pending.kind;
}

function freshLocation(tId: string): CourierLocation | null {
  const loc = lastCourierLocation.get(tId);
  if (!loc) return null;
  return Date.now() - loc.updatedAt <= CFG.LOCATION_MAX_AGE_MS ? loc : null;
}

// --- Pomocnicze --------------------------------------------------------------

function parseAmount(raw: string): number | null {
  const cleaned = raw.trim().replace(',', '.').replace(/z[łl]/gi, '').replace(/\s/g, '');
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** `numeric` z Postgresa przychodzi jako string albo null. */
function dec(value: string | null): number | null {
  return value != null ? parseFloat(value) : null;
}

function parseDistance(raw: string): number | null {
  const cleaned = raw.trim().replace(',', '.').replace(/km/gi, '');
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) && value >= 0 && value < 2000 ? value : null;
}

interface FuelInput {
  date: string | null;
  totalCost: number;
  liters: number | null;
  pricePerLiter: number | null;
}

/**
 * Reczny wpis paragonu paliwowego z jednej linii.
 *
 * Akceptuje kolejno: kwota [litry] [cena/L], z opcjonalna data YYYY-MM-DD
 * w dowolnym miejscu. Przecinki dziesietne i jednostki sa ignorowane, wiec
 * "312,40 zl 48,2 L" znaczy to samo co "312.40 48.2".
 */
export function parseFuelInput(raw: string): FuelInput | string {
  let text = raw.trim();

  let date: string | null = null;
  const dateMatch = text.match(/\d{4}-\d{2}-\d{2}/);
  if (dateMatch) {
    if (!isValidDateStr(dateMatch[0])) return 'Nieprawidłowa data — użyj formatu RRRR-MM-DD.';
    date = dateMatch[0];
    text = text.replace(dateMatch[0], ' ');
  }

  const numbers = (text.replace(/,/g, '.').match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const [cost, liters, price] = numbers;

  if (cost == null || !(cost > 0)) return 'Nie znalazłem kwoty. Podaj np. `312.40` albo `312.40 48.2`.';
  if (cost > 5000) return `Kwota ${cost.toFixed(2)} zł wygląda na pomyłkę — sprawdź paragon.`;

  return {
    date,
    totalCost: cost,
    liters: liters != null && liters > 0 && liters <= 500 ? liters : null,
    pricePerLiter: price != null && price > 0 && price <= 50 ? price : null,
  };
}

/**
 * FIX (3.9): `CFG.MAX_*_BYTES` byly zadeklarowane i nigdy nieuzywane.
 * Plik byl pobierany w calosci do pamieci i kodowany base64 (+33%),
 * bez limitu i bez timeoutu.
 */
async function downloadTelegramFile(
  getLink: () => Promise<URL>,
  fileSize: number | undefined,
  maxBytes: number,
  label: string
): Promise<Buffer> {
  if (fileSize != null && fileSize > maxBytes) {
    throw new Error(
      `${label} ma ${(fileSize / 1024 / 1024).toFixed(1)} MB — limit to ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`
    );
  }

  const link = await getLink();
  const res = await fetch(link.href, { signal: AbortSignal.timeout(CFG.DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Nie udało się pobrać pliku z Telegrama (HTTP ${res.status}).`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`${label} przekracza limit ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`);
  }
  return buffer;
}

function fuelPromptText(): string {
  return joinLines([
    `⛽ ${b('Wpisz dane z paragonu w jednej linii:')}`,
    ` • sama kwota: ${code('312.40')}`,
    ` • kwota i litry: ${code('312.40 48.2')}`,
    ` • kwota, litry, cena/L: ${code('312.40 48.2 6.48')}`,
    '',
    i('Cenę za litr policzę sam, jeśli jej nie podasz. Możesz dopisać datę RRRR-MM-DD.'),
    i('Możesz też po prostu wysłać zdjęcie paragonu — odczytam je automatycznie.'),
  ]);
}

/** Wspolne potwierdzenie zapisu paliwa — dla wpisu recznego i dla OCR-a. */
async function fuelSavedText(tId: string, date: string, data: FuelInput): Promise<string> {
  const summary = await financeService.getDailySummary(tId, date);
  const computedPrice =
    data.pricePerLiter ?? (data.liters && data.liters > 0 ? data.totalCost / data.liters : null);

  return joinLines([
    `⛽ ${b('Zapisano tankowanie')}`,
    `📅 ${b('Data:')} ${code(date)}`,
    `💰 ${b('Kwota:')} ${b(zl(data.totalCost))}`,
    data.liters != null && `🛢️ ${b('Litry:')} ${b(`${data.liters.toFixed(2)} L`)}`,
    computedPrice != null &&
      `🏷️ ${b('Cena za litr:')} ${b(`${computedPrice.toFixed(2)} zł/L`)}` +
        (data.pricePerLiter == null ? ` ${i('(wyliczona)')}` : ''),
    summary.fuelReceiptCount > 1 &&
      `\n📊 ${i(`Tego dnia masz już ${summary.fuelReceiptCount} paragony — razem ${zl(summary.fuelCost)}.`)}`,
  ]);
}

async function shiftCardPayload(tId: string, date: string, mode: 'START' | 'END') {
  const [summary, wallet] = await Promise.all([
    financeService.getDailySummary(tId, date),
    financeService.getWalletBalance(tId),
  ]);
  const now = nowTimeWarsaw();

  return mode === 'START'
    ? { text: startShiftCard(summary, wallet.balance, now), keyboard: startShiftKeyboard(now, Boolean(summary.workFrom)) }
    : { text: endShiftCard(summary, wallet.balance, now), keyboard: endShiftKeyboard(now, Boolean(summary.workTo)) };
}

// --- Rejestracja handlerow ---------------------------------------------------

export function registerBotHandlers(bot: Telegraf): void {
  /**
   * FIX (3.8): wczesniej kazdy, kto znalazl bota, mogl wysylac zdjecia i glosowki,
   * palic limit Gemini i zapisywac smieci do bazy.
   * FIX (4.2): przy okazji upsert do tabeli `users`.
   */
  bot.use(async (ctx, next) => {
    if (!ctx.from) return;
    if (!isAllowedUser(ctx.from.id)) {
      console.warn(`[Auth] odrzucono telegram_id=${ctx.from.id} (@${ctx.from.username ?? '-'})`);
      return;
    }
    await ensureUser({
      id: ctx.from.id,
      username: ctx.from.username,
      first_name: ctx.from.first_name,
    });
    return next();
  });

  /**
   * FIX (3.1): komenda zawsze przerywa oczekiwanie na wpis.
   *
   * Poprzednio `bot.on(message('text'))` byl zarejestrowany PRZED komendami
   * `/dzis`, `/saldo`, `/cel` itd. Gdy `awaitingInput` bylo ustawione, wpisanie
   * `/dzis` dostawalo odpowiedz "Podaj liczbe kilometrow" i nigdy nie wolalo
   * `next()`. Uzytkownik zostawal uwieziony bez mozliwosci wyjscia.
   */
  bot.use(async (ctx, next) => {
    const msg = ctx.message;
    if (ctx.from && msg && 'text' in msg && msg.text.startsWith('/')) {
      awaitingInput.delete(String(ctx.from.id));
    }
    return next();
  });

  // === 1. Pomoc i menu =======================================================

  bot.command(['start', 'pomoc', 'help', 'menu'], async (ctx) => {
    await ctx.reply(helpCard(), { ...HTML, ...mainMenuKeyboard() });
  });

  /**
   * Diagnostyka dostarczania update'ow. Bez tego jedyne, co widac przy
   * zepsutym webhooku, to cisza — Telegram nie ma jak zglosic bledu botowi,
   * bo wlasnie do niego nie potrafi sie dobic.
   */
  bot.command('webhook', async (ctx) => {
    const info = await ctx.telegram.getWebhookInfo();

    await ctx.reply(
      joinLines([
        `🌐 ${b('Stan dostarczania')}`,
        '',
        info.url
          ? `${b('Tryb:')} webhook\n${b('Adres:')} ${code(info.url.replace(/\/tg\/[a-f0-9]+$/, '/tg/…'))}`
          : `${b('Tryb:')} long polling ${i('(webhook nieustawiony)')}`,
        `${b('Oczekujące update’y:')} ${info.pending_update_count}`,
        info.max_connections != null && `${b('Limit połączeń:')} ${info.max_connections}`,
        info.ip_address && `${b('IP Telegrama:')} ${code(info.ip_address)}`,
        info.has_custom_certificate ? `${b('Certyfikat:')} własny` : null,
        '',
        info.last_error_message
          ? joinLines([
              `⚠️ ${b('Ostatni błąd dostarczenia:')}`,
              code(info.last_error_message),
              info.last_error_date != null &&
                i(new Date(info.last_error_date * 1000).toLocaleString('pl-PL', { timeZone: CFG.TZ })),
            ])
          : `✅ ${i('Brak błędów dostarczania.')}`,
        info.last_synchronization_error_date != null &&
          i(
            `Ostatni problem z synchronizacją: ${new Date(
              info.last_synchronization_error_date * 1000
            ).toLocaleString('pl-PL', { timeZone: CFG.TZ })}`
          ),
      ]),
      HTML
    );
  });

  bot.command('anuluj', async (ctx) => {
    const had = awaitingInput.delete(String(ctx.from.id));
    pendingWalletImports.delete(String(ctx.from.id));
    await ctx.reply(had ? '✖️ Anulowano oczekiwanie na wpis.' : 'ℹ️ Nic nie oczekiwało na wpis.');
  });

  // === 2. Start zmiany =======================================================

  bot.command(['wyjazd', 'startzmiana', 'poczatek', 'start_zmiana'], async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/).slice(1);
    const date = financeService.getEffectiveDate();
    const tId = String(ctx.from.id);

    if (parts.length > 0) {
      let workFrom = nowTimeWarsaw();
      let walletBalance: number | null = null;

      for (const part of parts) {
        const time = normalizeTime(part);
        if (time) {
          workFrom = time;
          continue;
        }
        const amount = parseAmount(part);
        if (amount != null) walletBalance = amount;
      }

      const { hoursError } = await financeService.setShiftStart(tId, date, workFrom);

      let walletLine: string | null = null;
      if (walletBalance != null) {
        const { delta, balance } = await financeService.adjustWalletBalance(tId, date, walletBalance);
        walletLine = `💼 ${b('Portfel wyrównany do:')} ${b(zl(balance))} ${i(`(korekta ${zlSigned(delta)})`)}`;
      }

      await ctx.reply(
        joinLines([
          `🚀 ${b('Zmiana rozpoczęta!')}`,
          `📅 ${b('Data:')} ${code(date)}`,
          `⏱️ ${b('Godzina wyjazdu:')} ${b(workFrom)}`,
          walletLine,
          hoursError && `⚠️ ${i(hoursError)}`,
        ]),
        {
          ...HTML,
          ...(freshLocation(tId) ? removeKeyboard() : locationRequestKeyboard()),
        }
      );
      return;
    }

    const { text, keyboard } = await shiftCardPayload(tId, date, 'START');
    await ctx.reply(text, { ...HTML, ...keyboard });
  });

  bot.action('btn_quick_start_shift', async (ctx) => {
    await ctx.answerCbQuery();
    const { text, keyboard } = await shiftCardPayload(
      String(ctx.from.id),
      financeService.getEffectiveDate(),
      'START'
    );
    await ctx.reply(text, { ...HTML, ...keyboard });
  });

  bot.action(/^startshift_(start_now|custom_time|set_cash)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const action = ctx.match[1];
    const tId = String(ctx.from.id);
    const date = financeService.getEffectiveDate();

    if (action === 'start_now') {
      const { hoursError } = await financeService.setShiftStart(tId, date, nowTimeWarsaw());
      const { text, keyboard } = await shiftCardPayload(tId, date, 'START');
      await ctx.editMessageText(hoursError ? `${text}\n\n⚠️ ${i(hoursError)}` : text, { ...HTML, ...keyboard });
      return;
    }

    if (action === 'custom_time') {
      setAwaiting(tId, 'START_CUSTOM_TIME');
      await ctx.reply(`⏱️ ${b('Wpisz godzinę wyjazdu')} w formacie ${code('GG:MM')} (np. ${code('19:30')}):`, {
        ...HTML,
        ...cancelInputKeyboard(),
      });
      return;
    }

    setAwaiting(tId, 'START_WALLET_BALANCE');
    await ctx.reply(
      `💵 ${b('Wpisz stan portfela Glovo przed wyjazdem')} (np. ${code('150.00')}).\n${i('Różnica zapisze się jako korekta.')}`,
      { ...HTML, ...cancelInputKeyboard() }
    );
  });

  // === 3. Koniec zmiany ======================================================

  bot.command(['koniec', 'zjazd'], async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/).slice(1);
    const date = financeService.getEffectiveDate();
    const tId = String(ctx.from.id);

    if (parts.length > 0) {
      let workTo: string | null = null;
      let distanceKm: number | null = null;
      let walletBalance: number | null = null;

      for (const part of parts) {
        const time = normalizeTime(part);
        if (time) {
          workTo = time;
          continue;
        }
        if (/km$/i.test(part)) {
          distanceKm = parseDistance(part);
          continue;
        }
        // Pierwsza "goła" liczba to dystans, druga to stan portfela.
        const value = parseAmount(part);
        if (value == null) continue;
        if (distanceKm === null) distanceKm = value;
        else walletBalance = value;
      }

      const { summary, hoursError } = await financeService.setShiftEnd(tId, date, { workTo, distanceKm });

      let walletLine: string | null = null;
      if (walletBalance != null) {
        const { delta, balance } = await financeService.adjustWalletBalance(tId, date, walletBalance);
        walletLine = `💼 ${b('Portfel wyrównany do:')} ${b(zl(balance))} ${i(`(korekta ${zlSigned(delta)})`)}`;
      }

      await ctx.reply(
        joinLines([
          `🏁 ${b('Zmiana zamknięta!')}`,
          '',
          `📅 ${b('Data:')} ${code(summary.date)}`,
          summary.workFrom &&
            summary.workTo &&
            `⏱️ ${b('Godziny:')} ${code(`${summary.workFrom} - ${summary.workTo}`)} (${b(`${summary.workHours.toFixed(2)} h`)})`,
          summary.distanceKm != null && `🚗 ${b('Dystans dnia:')} ${b(`${summary.distanceKm.toFixed(1)} km`)}`,
          `💰 ${b('Zarobek brutto:')} ${b(zl(summary.grossEarnings))}`,
          `💵 ${b('Zarobek łącznie netto:')} ${b(zl(summary.totalNetto))} (stawka ${b(`${summary.hourlyRateNetto.toFixed(2)} zł/h`)})`,
          `🪙 ${b('Napiwki gotówka:')} ${b(zlSigned(summary.cashTipsTotal))}`,
          summary.walletPayouts > 0 && `🏧 ${b('Wypłacone z portfela:')} ${b(`-${summary.walletPayouts.toFixed(2)} zł`)}`,
          `💳 ${b('Do przelewu:')} ${b(zl(summary.doPrzelewu))}`,
          walletLine,
          hoursError && `⚠️ ${i(hoursError)}`,
        ]),
        HTML
      );
      return;
    }

    const { text, keyboard } = await shiftCardPayload(tId, date, 'END');
    await ctx.reply(text, { ...HTML, ...keyboard });
  });

  bot.action('btn_quick_end_shift', async (ctx) => {
    await ctx.answerCbQuery();
    const { text, keyboard } = await shiftCardPayload(String(ctx.from.id), financeService.getEffectiveDate(), 'END');
    await ctx.reply(text, { ...HTML, ...keyboard });
  });

  bot.action(/^endshift_(set_now|custom_time|set_dist|set_gross|add_fuel|set_cash)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const action = ctx.match[1];
    const tId = String(ctx.from.id);
    const date = financeService.getEffectiveDate();

    if (action === 'set_now') {
      const { hoursError } = await financeService.setShiftEnd(tId, date, { workTo: nowTimeWarsaw() });
      const { text, keyboard } = await shiftCardPayload(tId, date, 'END');
      await ctx.editMessageText(hoursError ? `${text}\n\n⚠️ ${i(hoursError)}` : text, { ...HTML, ...keyboard });
      return;
    }

    if (action === 'custom_time') {
      setAwaiting(tId, 'END_CUSTOM_TIME');
      await ctx.reply(`⏱️ ${b('Wpisz godzinę zjazdu')} w formacie ${code('GG:MM')} (np. ${code('23:30')}):`, {
        ...HTML,
        ...cancelInputKeyboard(),
      });
      return;
    }

    if (action === 'set_dist') {
      setAwaiting(tId, 'END_DISTANCE');
      await ctx.reply(
        `🚗 ${b('Wpisz dystans PRZEJECHANY dzisiaj')} w km (np. ${code('48')}).\n${i('To nie jest stan licznika pojazdu.')}`,
        { ...HTML, ...cancelInputKeyboard() }
      );
      return;
    }

    if (action === 'set_gross') {
      setAwaiting(tId, 'END_GROSS');
      await ctx.reply(
        joinLines([
          `💰 ${b('Wpisz zarobek BRUTTO z aplikacji Glovo')} (np. ${code('438.60')}).`,
          i(`Netto policzy się samo: ${(CFG.NETTO_FACTOR * 100).toFixed(1)}% kwoty brutto.`),
        ]),
        { ...HTML, ...cancelInputKeyboard() }
      );
      return;
    }

    if (action === 'add_fuel') {
      setAwaiting(tId, 'FUEL_MANUAL');
      await ctx.reply(fuelPromptText(), { ...HTML, ...cancelInputKeyboard() });
      return;
    }

    setAwaiting(tId, 'END_WALLET_BALANCE');
    await ctx.reply(
      `💵 ${b('Wpisz aktualny stan portfela z aplikacji Glovo')} (np. ${code('142.50')}).\n${i('Różnica zapisze się jako korekta.')}`,
      { ...HTML, ...cancelInputKeyboard() }
    );
  });

  bot.action('input_cancel', async (ctx) => {
    await ctx.answerCbQuery('Anulowano.');
    awaitingInput.delete(String(ctx.from.id));
    await ctx.editMessageText('✖️ Anulowano oczekiwanie na wpis.');
  });

  // === 3b. Zarobek brutto i paliwo — komendy skrótowe ========================

  bot.command(['brutto', 'zarobek'], async (ctx) => {
    const param = ctx.message.text.trim().split(/\s+/)[1];
    const tId = String(ctx.from.id);
    const date = financeService.getEffectiveDate();

    if (!param) {
      setAwaiting(tId, 'END_GROSS');
      await ctx.reply(`💰 ${b('Wpisz zarobek brutto')} (np. ${code('438.60')}):`, {
        ...HTML,
        ...cancelInputKeyboard(),
      });
      return;
    }

    const value = parseAmount(param);
    if (value == null || value < 0) {
      await ctx.reply(`❌ Nieprawidłowa kwota. Użyj np. ${code('/brutto 438.60')}.`, HTML);
      return;
    }

    await financeService.setGrossEarnings(tId, date, value);
    const summary = await financeService.getDailySummary(tId, date);
    await ctx.reply(
      joinLines([
        `✅ ${b('Zarobek brutto zapisany:')} ${b(zl(value))}`,
        `💵 ${b('Netto ze zleceń:')} ${b(zl(summary.netEarnings))}`,
        `🏁 ${b('Netto łącznie:')} ${b(zl(summary.totalNetto))}`,
      ]),
      HTML
    );
  });

  bot.command(['paliwo', 'tankowanie'], async (ctx) => {
    const rest = ctx.message.text.trim().split(/\s+/).slice(1).join(' ');
    const tId = String(ctx.from.id);

    if (!rest) {
      setAwaiting(tId, 'FUEL_MANUAL');
      await ctx.reply(fuelPromptText(), { ...HTML, ...cancelInputKeyboard() });
      return;
    }

    const parsed = parseFuelInput(rest);
    if (typeof parsed === 'string') {
      await ctx.reply(`❌ ${h(parsed)}`, HTML);
      return;
    }

    const fuelDate = parsed.date ?? financeService.getEffectiveDate();
    await financeService.saveFuelReceipt(tId, fuelDate, {
      totalCost: parsed.totalCost,
      liters: parsed.liters,
      pricePerLiter: parsed.pricePerLiter,
    });
    await ctx.reply(await fuelSavedText(tId, fuelDate, parsed), HTML);
  });

  // === 4. Lokalizacja ========================================================

  bot.command('lokalizacja', async (ctx) => {
    await ctx.reply(
      `📍 ${b('Kliknij przycisk poniżej')}, aby udostępnić lokalizację GPS. Będzie używana do weryfikacji tras ofert Glovo przez 30 minut.`,
      { ...HTML, ...locationRequestKeyboard() }
    );
  });

  bot.on(message('location'), async (ctx) => {
    const { latitude, longitude } = ctx.message.location;
    lastCourierLocation.set(String(ctx.from.id), { latitude, longitude, updatedAt: Date.now() });
    await ctx.reply('✅ Pozycja GPS zapisana. Weryfikacja tras Glovo aktywna na 30 minut.', removeKeyboard());
  });

  // === 5. Raporty ============================================================

  bot.command(['dzis', 'dzien'], async (ctx) => {
    const param = ctx.message.text.trim().split(/\s+/)[1];
    const date = isValidDateStr(param) ? param : financeService.getEffectiveDate();
    const summary = await financeService.getDailySummary(ctx.from.id, date);
    await ctx.reply(dailyCard(summary), HTML);
  });

  bot.action('btn_quick_today', async (ctx) => {
    await ctx.answerCbQuery();
    const summary = await financeService.getDailySummary(ctx.from.id, financeService.getEffectiveDate());
    await ctx.reply(dailyCard(summary), HTML);
  });

  bot.command(['tydzien', 'ptydzien'], async (ctx) => {
    const isPrevious = ctx.message.text.toLowerCase().includes('ptydzien');
    const { startDate, endDate } = financeService.getWeekRange(isPrevious ? -1 : 0);
    const summary = await financeService.getPeriodSummary(ctx.from.id, startDate, endDate);
    const target = isPrevious ? null : await financeService.getTargetProgress(ctx.from.id, 'WEEKLY');
    await ctx.reply(periodCard(isPrevious ? 'Poprzedni tydzień' : 'Bieżący tydzień', summary, target), HTML);
  });

  bot.command('miesiac', async (ctx) => {
    const param = ctx.message.text.trim().split(/\s+/)[1];
    const today = financeService.getEffectiveDate();

    let startDate: string;
    let endDate: string;

    if (param && /^\d{4}-\d{2}$/.test(param)) {
      const [yearStr, monthStr] = param.split('-');
      const year = Number(yearStr);
      const month = Number(monthStr);
      if (!Number.isInteger(year) || month < 1 || month > 12) {
        await ctx.reply(`❌ Nieprawidłowy miesiąc. Użyj np. ${code('/miesiac 2026-07')}.`, HTML);
        return;
      }
      ({ startDate, endDate } = monthRange(year, month));
    } else {
      const { year, month } = splitDate(today);
      startDate = monthRange(year, month).startDate;
      endDate = today; // biezacy miesiac liczymy do dzisiaj
    }

    const summary = await financeService.getPeriodSummary(ctx.from.id, startDate, endDate);
    const target = await financeService.getTargetProgress(ctx.from.id, 'MONTHLY');
    await ctx.reply(periodCard('Podsumowanie miesiąca', summary, target), HTML);
  });

  bot.command('statystyki', async (ctx) => {
    const param = ctx.message.text.trim().split(/\s+/)[1];
    const date = isValidDateStr(param) ? param : financeService.getEffectiveDate();
    const stats = await financeService.getCourseOfferStats(ctx.from.id, date);

    if (stats.totalOffers === 0) {
      await ctx.reply(`ℹ️ Brak zapisanych ofert kursów w dniu ${code(date)}.`, HTML);
      return;
    }
    await ctx.reply(offerStatsCard(stats), HTML);
  });

  // === 6. Saldo portfela =====================================================

  bot.command('saldo', async (ctx) => {
    const param = ctx.message.text.trim().split(/\s+/)[1];
    const tId = String(ctx.from.id);

    if (param) {
      const value = parseAmount(param);
      if (value == null) {
        await ctx.reply(`❌ Nieprawidłowa kwota. Użyj np. ${code('/saldo 127.50')}.`, HTML);
        return;
      }
      const { delta, balance } = await financeService.adjustWalletBalance(
        tId,
        financeService.getEffectiveDate(),
        value
      );
      await ctx.reply(
        joinLines([
          `💳 ${b('Saldo wyrównane do:')} ${b(zl(balance))}`,
          `📝 ${i(`Zapisano korektę ${zlSigned(delta)}, żeby saldo dalej wynikało wyłącznie z transakcji.`)}`,
        ]),
        HTML
      );
      return;
    }

    const wallet = await financeService.getWalletBalance(tId);
    await ctx.reply(
      joinLines([
        `💼 ${b('Saldo Portfela Glovo')}`,
        `💵 ${b('Aktualny stan:')} ${b(zl(wallet.balance))}`,
        '',
        wallet.transactionCount > 0
          ? i(`Suma ${wallet.transactionCount} transakcji, ostatnia z dnia ${wallet.lastDate}.`)
          : i('Brak transakcji — wyślij zrzut ekranu Portfela Glovo.'),
        '',
        `💡 Aby wyrównać saldo ręcznie: ${code('/saldo 127.50')}`,
      ]),
      HTML
    );
  });

  // === 7. Cele ===============================================================

  bot.command(['cel', 'target', 'cele'], async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/).slice(1);

    if (parts.length === 0) {
      await replyWithTargets(ctx);
      return;
    }

    let periodType: 'MONTHLY' | 'WEEKLY' = 'MONTHLY';
    let amountStr = parts[0];

    if (parts.length >= 2) {
      const sub = parts[0]?.toLowerCase() ?? '';
      if (['tydzien', 'tydzień', 'week', 'w'].includes(sub)) periodType = 'WEEKLY';
      amountStr = parts[1];
    }

    const amount = amountStr ? parseAmount(amountStr) : null;
    if (amount == null || amount <= 0) {
      await ctx.reply(`❌ Nieprawidłowa kwota. Użyj np. ${code('/cel 4000')} lub ${code('/cel tydzien 1200')}.`, HTML);
      return;
    }

    await financeService.setEarningTarget(ctx.from.id, periodType, amount);
    const progress = await financeService.getTargetProgress(ctx.from.id, periodType);
    if (progress) {
      await ctx.reply(`✅ ${b('Cel zapisany!')}\n\n${targetCard(progress)}`, HTML);
    }
  });

  bot.action('btn_quick_targets', async (ctx) => {
    await ctx.answerCbQuery();
    await replyWithTargets(ctx);
  });

  async function replyWithTargets(ctx: Context): Promise<void> {
    const id = ctx.from?.id;
    if (id == null) return;

    const [monthly, weekly] = await Promise.all([
      financeService.getTargetProgress(id, 'MONTHLY'),
      financeService.getTargetProgress(id, 'WEEKLY'),
    ]);

    if (!monthly && !weekly) {
      await ctx.reply(
        `🎯 ${b('Brak celów.')} Ustaw np. ${code('/cel 4500')} lub ${code('/cel tydzien 1200')}.`,
        HTML
      );
      return;
    }

    const cards = [monthly, weekly].filter((p): p is NonNullable<typeof p> => p !== null).map(targetCard);
    await ctx.reply(cards.join(`\n\n${SEPARATOR}\n\n`), HTML);
  }

  // === 8. Wpisy tekstowe (oczekiwanie na wartosc) ============================
  // Rejestrowane PO komendach — patrz FIX (3.1).

  bot.on(message('text'), async (ctx, next) => {
    const tId = String(ctx.from.id);
    const rawText = ctx.message.text.trim();
    const pending = takeAwaiting(tId);
    const date = financeService.getEffectiveDate();

    if (pending) {
      switch (pending) {
        case 'START_CUSTOM_TIME':
        case 'END_CUSTOM_TIME': {
          const time = normalizeTime(rawText);
          if (!time) {
            await ctx.reply(`❌ Błędny format godziny. Podaj np. ${code('19:30')} albo ${code('/anuluj')}.`, HTML);
            return;
          }
          awaitingInput.delete(tId);

          if (pending === 'START_CUSTOM_TIME') {
            const { hoursError } = await financeService.setShiftStart(tId, date, time);
            await ctx.reply(
              joinLines([`✅ ${b(`Godzina wyjazdu ${time} zapisana.`)}`, hoursError && `⚠️ ${i(hoursError)}`]),
              HTML
            );
          } else {
            const { summary, hoursError } = await financeService.setShiftEnd(tId, date, { workTo: time });
            await ctx.reply(
              joinLines([
                `✅ ${b(`Godzina zjazdu ${time} zapisana.`)} Czas pracy: ${b(`${summary.workHours.toFixed(2)} h`)}`,
                hoursError && `⚠️ ${i(hoursError)}`,
              ]),
              HTML
            );
          }
          return;
        }

        case 'END_DISTANCE': {
          const distance = parseDistance(rawText);
          if (distance == null) {
            await ctx.reply(`❌ Podaj liczbę kilometrów (np. ${code('52')}) albo ${code('/anuluj')}.`, HTML);
            return;
          }
          awaitingInput.delete(tId);
          await financeService.setDailyDistance(tId, date, distance);
          await ctx.reply(`✅ ${b(`Dystans dnia ${distance.toFixed(1)} km zapisany.`)}`, HTML);
          return;
        }

        case 'END_GROSS': {
          const value = parseAmount(rawText);
          if (value == null || value < 0) {
            await ctx.reply(`❌ Podaj kwotę brutto (np. ${code('438.60')}) albo ${code('/anuluj')}.`, HTML);
            return;
          }
          awaitingInput.delete(tId);
          await financeService.setGrossEarnings(tId, date, value);
          const summary = await financeService.getDailySummary(tId, date);
          await ctx.reply(
            joinLines([
              `✅ ${b('Zarobek brutto zapisany:')} ${b(zl(value))}`,
              `💵 ${b('Netto ze zleceń:')} ${b(zl(summary.netEarnings))}`,
              summary.workHours > 0 && `⏱️ ${b('Stawka:')} ${b(`${summary.hourlyRateNetto.toFixed(2)} zł netto/h`)}`,
            ]),
            HTML
          );
          return;
        }

        case 'FUEL_MANUAL': {
          const parsed = parseFuelInput(rawText);
          if (typeof parsed === 'string') {
            await ctx.reply(`❌ ${h(parsed)} Albo ${code('/anuluj')}.`, HTML);
            return;
          }
          awaitingInput.delete(tId);
          const fuelDate = parsed.date ?? date;
          await financeService.saveFuelReceipt(tId, fuelDate, {
            totalCost: parsed.totalCost,
            liters: parsed.liters,
            pricePerLiter: parsed.pricePerLiter,
          });
          await ctx.reply(await fuelSavedText(tId, fuelDate, parsed), HTML);
          return;
        }

        case 'START_WALLET_BALANCE':
        case 'END_WALLET_BALANCE': {
          const value = parseAmount(rawText);
          if (value == null) {
            await ctx.reply(`❌ Podaj poprawną kwotę (np. ${code('145.00')}) albo ${code('/anuluj')}.`, HTML);
            return;
          }
          awaitingInput.delete(tId);
          const { delta, balance } = await financeService.adjustWalletBalance(tId, date, value);
          await ctx.reply(
            joinLines([
              `✅ ${b('Portfel Glovo wyrównany do:')} ${b(zl(balance))}`,
              `📝 ${i(`Korekta ${zlSigned(delta)} zapisana jako transakcja.`)}`,
            ]),
            HTML
          );
          return;
        }
      }
    }

    // Potwierdzenie importu Portfela slowem "tak"/"nie".
    const importPending = pendingWalletImports.get(tId);
    if (importPending && Date.now() <= importPending.expiresAt) {
      const lower = rawText.toLowerCase();
      if (['tak', 't', 'zapisz', 'ok', 'yes', 'y'].includes(lower)) {
        pendingWalletImports.delete(tId);
        const result = await financeService.saveWalletTransactions(tId, importPending.transactions);
        await ctx.reply(
          joinLines([
            `✅ ${b(`Zapisano ${result.added} transakcji.`)}`,
            `📅 ${b('Dotknięte dni:')} ${code(result.dates.join(', '))}`,
            `💼 ${b('Saldo portfela:')} ${b(zl(result.balance))}`,
          ]),
          HTML
        );
        return;
      }
      if (['nie', 'n', 'anuluj'].includes(lower)) {
        pendingWalletImports.delete(tId);
        await ctx.reply('✖️ Anulowano import Portfela. Nic nie zostało zapisane.');
        return;
      }
    }

    return next();
  });

  // === 9. Szybkie napiwki ====================================================

  bot.hears(/^(?:n|np|napiwek)\s+(\d+(?:[.,]\d+)?)$/i, async (ctx) => {
    const amount = parseAmount(ctx.match[1] ?? '');
    if (amount == null || amount <= 0) return;

    const date = financeService.getEffectiveDate();
    await financeService.saveCashTip(ctx.from.id, date, amount);
    await ctx.reply(`💵 ${b('Dodano napiwek:')} ${b(zlSigned(amount))}\n📅 ${b('Data:')} ${code(date)}`, HTML);
  });

  // === 10. Oferty kursow — decyzje ==========================================

  bot.action(/^offer:(accept|reject):(\d+)$/, async (ctx) => {
    const accepted = ctx.match[1] === 'accept';
    const offerId = Number.parseInt(ctx.match[2] ?? '0', 10);

    // FIX (3.7): wynik byl ignorowany — bot potwierdzal zapis, ktorego nie bylo.
    const offer = await financeService.updateCourseOfferStatus(
      offerId,
      ctx.from.id,
      accepted ? 'ACCEPTED' : 'REJECTED'
    );

    if (!offer) {
      await ctx.answerCbQuery('Nie znaleziono tej oferty — status nie został zmieniony.', { show_alert: true });
      return;
    }

    await ctx.answerCbQuery(accepted ? 'Zaakceptowano' : 'Odrzucono');

    /**
     * FIX (3.6): karta jest przerysowywana z danych z bazy.
     * Stary kod filtrowal tekst wiadomosci po `'🔘 Status:'`, co nigdy nie
     * trafialo (linia miala gwiazdki), wiec karta konczyla z dwoma statusami.
     * Doklejanie do `message.text` i tak nie zadziala — Telegram zwraca tam
     * czysty tekst bez znacznikow formatowania.
     */
    await ctx.editMessageText(
      offerCard({
        isProfitable: offer.isProfitable,
        grossAmount: parseFloat(offer.grossAmount),
        netAmount: parseFloat(offer.netAmount),
        pickupAddress: offer.pickupAddress ?? '—',
        deliveryAddress: offer.deliveryAddress ?? '—',
        appPickupKm: dec(offer.appPickupKm),
        appDeliveryKm: dec(offer.appDeliveryKm),
        appTotalKm: dec(offer.appTotalKm),
        mapsPickupKm: dec(offer.mapsPickupKm),
        mapsDeliveryKm: dec(offer.mapsDeliveryKm),
        mapsTotalKm: dec(offer.mapsTotalKm),
        mapsReason: offer.mapsPickupKm ? null : 'brak danych z Google Maps',
        mapsDeliveryReason: 'oferta nie podaje adresu klienta',
        mapsAgeMin: 0,
        totalKm: parseFloat(offer.distanceTotalKm),
        rateBasis: offer.rateBasis === 'MAPS' ? 'MAPS' : offer.rateBasis === 'NONE' ? 'NONE' : 'APP',
        netRatePerKm: parseFloat(offer.netRatePerKm),
        status: accepted ? 'ACCEPTED' : 'REJECTED',
      }),
      { ...HTML, ...offerDoneKeyboard(accepted) }
    );
  });

  bot.action('offer_done', async (ctx) => {
    await ctx.answerCbQuery('Status tego zlecenia został już zarejestrowany.');
  });

  // === 11. Import Portfela — przyciski ======================================

  bot.action(/^wallet_(confirm|cancel)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const tId = String(ctx.from.id);
    const pending = pendingWalletImports.get(tId);

    if (!pending || Date.now() > pending.expiresAt) {
      pendingWalletImports.delete(tId);
      await ctx.editMessageText('⌛ Ta prośba o potwierdzenie wygasła. Wyślij zrzut ponownie.');
      return;
    }

    pendingWalletImports.delete(tId);

    if (ctx.match[1] === 'cancel') {
      await ctx.editMessageText('✖️ Anulowano import. Nic nie zmieniono.');
      return;
    }

    const result = await financeService.saveWalletTransactions(tId, pending.transactions);
    await ctx.editMessageText(
      joinLines([
        `✅ ${b(`Zapisano ${result.added} transakcji.`)}`,
        result.skipped > 0 && `⏭ ${b('Pominięte duplikaty:')} ${result.skipped}`,
        `📅 ${b('Zaktualizowane dni:')} ${code(result.dates.join(', '))}`,
        `💼 ${b('Saldo portfela:')} ${b(zl(result.balance))}`,
      ]),
      HTML
    );
  });

  // === 12. Voice-to-Data =====================================================

  bot.on([message('voice'), message('audio')], async (ctx) => {
    const voiceMsg = 'voice' in ctx.message ? ctx.message.voice : ctx.message.audio;
    if (!voiceMsg) return;

    const processing = await ctx.reply('🎙️ Przetwarzam notatkę głosową…');
    const editProcessing = (text: string) =>
      ctx.telegram.editMessageText(ctx.chat.id, processing.message_id, undefined, text, HTML);

    try {
      const audio = await downloadTelegramFile(
        () => ctx.telegram.getFileLink(voiceMsg.file_id),
        voiceMsg.file_size,
        CFG.MAX_AUDIO_BYTES,
        'Nagranie'
      );

      const mimeType = 'mime_type' in voiceMsg && voiceMsg.mime_type ? voiceMsg.mime_type : 'audio/ogg';
      const extracted = await geminiService.parseVoiceNote(audio, mimeType);

      if (extracted.action === 'DELETE' && extracted.deleteTarget) {
        const result = await financeService.handleVoiceDeletion(
          ctx.from.id,
          extracted.deleteTarget,
          extracted.targetDate
        );
        await editProcessing(
          joinLines([
            `🗣️ ${i(`„${extracted.transcription}”`)}`,
            '',
            `${result.success ? '🗑️' : '⚠️'} ${h(result.message)}`,
          ])
        );
        return;
      }

      const saved = await financeService.saveVoiceEvent(ctx.from.id, extracted);

      await editProcessing(
        joinLines([
          `🗣️ ${b('Transkrypcja:')} ${i(`„${extracted.transcription}”`)}`,
          `📅 ${b('Data wpisu:')} ${code(saved.date)}`,
          '',
          saved.hasFuel && `⛽ ${b('Zapisano tankowanie:')}`,
          saved.hasFuel && extracted.fuelTotalCost != null && ` • Koszt: ${b(zl(extracted.fuelTotalCost))}`,
          saved.hasFuel && extracted.fuelLiters != null && ` • Ilość: ${b(`${extracted.fuelLiters} L`)}`,
          saved.hasFuel &&
            extracted.fuelPricePerLiter != null &&
            ` • Cena: ${b(`${extracted.fuelPricePerLiter.toFixed(2)} zł/L`)}`,
          extracted.distanceKm != null && `🚗 ${b('Dystans dnia:')} ${b(`${extracted.distanceKm} km`)}`,
          extracted.grossEarnings != null && `💰 ${b('Zarobek brutto:')} ${b(zl(extracted.grossEarnings))}`,
          extracted.workFrom &&
            extracted.workTo &&
            `⏱️ ${b('Godziny:')} ${code(`${extracted.workFrom} - ${extracted.workTo}`)}`,
          extracted.cashTip != null && `💵 ${b('Napiwek gotówkowy:')} ${b(zlSigned(extracted.cashTip))}`,
          saved.hoursError && `⚠️ ${i(saved.hoursError)}`,
          !saved.hasDailyUpdate && !saved.hasTip && !saved.hasFuel && i('Nie rozpoznano żadnych danych do zapisania.'),
        ])
      );
    } catch (err) {
      console.error('[VoiceHandler]', err);
      await editProcessing(`❌ ${b('Błąd przetwarzania audio.')} ${h(err instanceof Error ? err.message : '')}`).catch(
        () => {}
      );
    }
  });

  // === 13. Vision — zdjecia ==================================================

  bot.on(message('photo'), async (ctx) => {
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;

    const caption = ctx.message.caption ?? '';

    // Przy albumie zdjec Telegram wysyla osobny update na kazde — warto pokazac,
    // ze reszta czeka w kolejce, zamiast zostawiac "Analizuję…" na minute.
    const queued = geminiQueue.pending + geminiQueue.running;
    const processing = await ctx.reply(
      queued > 0 ? `🔍 Analizuję obraz… ${i(`(w kolejce: ${queued})`)}` : '🔍 Analizuję obraz…',
      HTML
    );
    const editProcessing = (text: string, extra?: Record<string, unknown>) =>
      ctx.telegram.editMessageText(ctx.chat.id, processing.message_id, undefined, text, { ...HTML, ...extra });

    try {
      const image = await downloadTelegramFile(
        () => ctx.telegram.getFileLink(photo.file_id),
        photo.file_size,
        CFG.MAX_PHOTO_BYTES,
        'Zdjęcie'
      );

      const category = await geminiService.classifyImage(image, caption);
      const tId = String(ctx.from.id);

      // --- Portfel Glovo ---
      if (category === 'WALLET') {
        const currentYear = splitDate(financeService.getEffectiveDate()).year;
        const transactions = await geminiService.analyzeWalletScreenshot(image, currentYear);

        if (transactions.length === 0) {
          await editProcessing('⚠️ Nie rozpoznano żadnych pozycji w zrzucie Portfela.');
          return;
        }

        const preview = await financeService.previewWalletImport(tId, transactions);

        if (preview.newTransactions.length === 0) {
          await editProcessing(
            `ℹ️ Wszystkie ${transactions.length} transakcji z tego zrzutu są już w bazie (brak nowych).`
          );
          return;
        }

        pendingWalletImports.set(tId, {
          transactions: preview.newTransactions,
          expiresAt: Date.now() + CFG.WALLET_IMPORT_TTL_MS,
        });

        await editProcessing(
          joinLines([
            `📥 ${b('Rozpoznano transakcje Portfela Glovo:')}`,
            '',
            ...preview.newTransactions.map(
              (t) => `• ${code(`${t.date} ${t.time}`)} ${b(t.type)} ➔ ${b(zlSigned(t.amount))}`
            ),
            '',
            `➕ ${b('Nowe:')} ${preview.newTransactions.length} szt.  |  ⏭ ${b('Duplikaty:')} ${preview.existingCount}`,
            `💵 ${b('Wpływ na saldo:')} ${b(zlSigned(preview.totalAmountDelta))}`,
          ]),
          // Spread, nie sama instancja: `Markup` to klasa bez sygnatury indeksu,
          // wiec nie pasuje do `Record<string, unknown>`. Reszta pliku juz tak robi.
          { ...walletImportKeyboard() }
        );
        return;
      }

      // --- Paragon paliwowy ---
      if (category === 'FUEL') {
        const receipt = await geminiService.extractFuelReceipt(image);
        const date = isValidDateStr(receipt.date) ? receipt.date : financeService.getEffectiveDate();

        await financeService.saveFuelReceipt(tId, date, {
          totalCost: receipt.totalCost,
          liters: receipt.liters,
          pricePerLiter: receipt.pricePerLiter,
        });

        // Ta sama tresc potwierdzenia co przy wpisie recznym.
        await editProcessing(
          `🧾 ${i('odczytano z paragonu')}\n` +
            (await fuelSavedText(tId, date, {
              date,
              totalCost: receipt.totalCost,
              liters: receipt.liters,
              pricePerLiter: receipt.pricePerLiter,
            }))
        );
        return;
      }

      // --- Oferta kursu ---
      const offer = await geminiService.analyzeCourseOffer(image);
      const userLoc = freshLocation(tId);

      const route = await verifyOfferDistance(
        userLoc ? { lat: userLoc.latitude, lng: userLoc.longitude, ts: userLoc.updatedAt } : null,
        offer.pickupAddress,
        offer.deliveryAddress
      );

      // Suma z aplikacji: oba odcinki widoczne na ekranie oferty.
      const appTotalKm =
        offer.appPickupKm != null && offer.appDeliveryKm != null
          ? Math.round((offer.appPickupKm + offer.appDeliveryKm) * 100) / 100
          : null;

      /**
       * Podstawa stawki: dystans z APLIKACJI, nie z Google Maps.
       *
       * Glovo liczy oba odcinki od biezacej pozycji kuriera i zna prawdziwy
       * adres klienta. Maps liczy od ostatniego wyslanego GPS-a, a odcinka
       * do klienta w ogole nie policzy, bo oferta go nie ujawnia. Wczesniej
       * bot dzielil kwote przez zmyslona liczbe i kazal odrzucac oplacalne kursy.
       */
      const rateBasis: 'APP' | 'MAPS' | 'NONE' =
        appTotalKm != null && appTotalKm > 0
          ? 'APP'
          : route.totalKm != null && route.totalKm > 0
            ? 'MAPS'
            : 'NONE';

      const totalKm = rateBasis === 'APP' ? appTotalKm! : rateBasis === 'MAPS' ? route.totalKm! : 0;

      const { netAmount, netRatePerKm, isProfitable } = computeOfferRate({
        grossAmount: offer.grossAmount,
        totalKm,
      });

      const offerId = await financeService.saveCourseOffer(tId, {
        grossAmount: offer.grossAmount,
        netAmount,
        appPickupKm: offer.appPickupKm,
        appDeliveryKm: offer.appDeliveryKm,
        appTotalKm,
        mapsPickupKm: route.pickupKm,
        mapsDeliveryKm: route.deliveryKm,
        mapsTotalKm: route.totalKm,
        distanceTotalKm: totalKm,
        rateBasis,
        netRatePerKm,
        isProfitable,
        pickupAddress: offer.pickupAddress,
        deliveryAddress: offer.deliveryAddress,
      });

      await editProcessing(
        offerCard({
          isProfitable,
          grossAmount: offer.grossAmount,
          netAmount,
          pickupAddress: offer.pickupAddress,
          deliveryAddress: offer.deliveryAddress,
          appPickupKm: offer.appPickupKm,
          appDeliveryKm: offer.appDeliveryKm,
          appTotalKm,
          mapsPickupKm: route.pickupKm,
          mapsDeliveryKm: route.deliveryKm,
          mapsTotalKm: route.totalKm,
          mapsReason: route.reason,
          mapsDeliveryReason: route.deliveryReason,
          mapsAgeMin: route.ageMin,
          totalKm,
          rateBasis,
          netRatePerKm,
          status: 'PENDING',
        }),
        // Jak wyzej — `Markup` musi wejsc jako rozlozony obiekt.
        { ...offerDecisionKeyboard(offerId) }
      );
    } catch (err) {
      console.error('[PhotoHandler]', err);
      await editProcessing(`❌ ${b('Błąd analizy obrazu.')} ${h(err instanceof Error ? err.message : '')}`).catch(
        () => {}
      );
    }
  });
}
