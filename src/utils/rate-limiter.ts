/**
 * Kolejka zapytan do zewnetrznych API z ograniczeniem rownoleglosci
 * i ponawianiem z wykladniczym backoffem.
 *
 * Po co: Telegram wysyla album 3 zdjec jako 3 osobne update'y, wiec handler
 * zdjec odpala sie 3 razy rownolegle. Kazde zdjecie to 2 wywolania Gemini
 * (klasyfikacja + odczyt), czyli 6 rownoczesnych zapytan z jednego gestu
 * uzytkownika. Darmowy tier Gemini tego nie przepuszcza i zwraca 429,
 * a bot pokazywal wtedy "Blad analizy obrazu" i gubil paragon.
 *
 * Bez zewnetrznej zaleznosci — p-queue nie obsluguje naglowka `Retry-After`
 * ani `retryDelay` z odpowiedzi Google, a to wlasnie one mowia, ile realnie
 * trzeba odczekac.
 */

export interface RequestQueueOptions {
  /** Nazwa do logow. */
  name: string;
  /** Ile zapytan moze leciec jednoczesnie. */
  concurrency: number;
  /** Minimalny odstep miedzy STARTAMI zapytan (ms). */
  minIntervalMs: number;
  /** Ile razy ponowic po bledzie przejsciowym. */
  maxRetries: number;
  /** Bazowe opoznienie backoffu (ms). */
  baseDelayMs: number;
  /** Gorny limit pojedynczego opoznienia (ms). */
  maxDelayMs: number;
  /** Maksymalna dlugosc kolejki — chroni przed zalaniem. */
  maxQueueLength: number;
  /** Wstrzykiwane w testach. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Kody HTTP, po ktorych ma sens sprobowac jeszcze raz. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Bledy sieciowe Node — polaczenie zerwane, DNS chwilowo nie odpowiada itd. */
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND']);

const RETRYABLE_TEXT =
  /(rate.?limit|quota|too many requests|resource_exhausted|unavailable|overloaded|deadline|timeout|socket hang up)/i;

function readStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as Record<string, unknown>;
  for (const key of ['status', 'statusCode', 'code']) {
    const value = e[key];
    if (typeof value === 'number' && value >= 100 && value < 600) return value;
  }
  const nested = e['error'];
  if (typeof nested === 'object' && nested !== null) {
    const code = (nested as Record<string, unknown>)['code'];
    if (typeof code === 'number') return code;
  }
  // SDK Google potrafi wcisnac kod tylko w tresc komunikatu.
  const message = typeof e['message'] === 'string' ? e['message'] : '';
  const match = message.match(/\b(429|500|502|503|504)\b/);
  return match ? Number(match[1]) : null;
}

export function isRetryable(err: unknown): boolean {
  const status = readStatus(err);
  if (status !== null) return RETRYABLE_STATUS.has(status);

  if (typeof err === 'object' && err !== null) {
    const code = (err as Record<string, unknown>)['code'];
    if (typeof code === 'string' && RETRYABLE_CODES.has(code)) return true;

    const name = (err as Record<string, unknown>)['name'];
    if (name === 'AbortError' || name === 'TimeoutError') return true;
  }

  const message = err instanceof Error ? err.message : String(err);
  return RETRYABLE_TEXT.test(message);
}

/**
 * Ile serwer kaze czekac. Kolejno sprawdzamy:
 *  • naglowek `Retry-After` (sekundy),
 *  • `retryDelay: "31s"` z RetryInfo w odpowiedzi Google,
 *  • brak wskazowki -> null, uzyjemy wlasnego backoffu.
 */
export function serverRetryAfterMs(err: unknown): number | null {
  if (typeof err === 'object' && err !== null) {
    const headers = (err as Record<string, unknown>)['headers'];
    if (headers && typeof headers === 'object') {
      const raw = (headers as Record<string, unknown>)['retry-after'];
      const seconds = Number(raw);
      if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/"?retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s/i);
  return match ? Math.round(Number(match[1]) * 1000) : null;
}

/**
 * Opoznienie przed kolejna proba: wykladnicze z pelnym jitterem
 * (losowe 50–100% wyliczonej wartosci), zeby rownolegle zapytania
 * nie wracaly do API dokladnie w tej samej chwili.
 */
export function backoffDelayMs(
  attempt: number,
  opts: { baseDelayMs: number; maxDelayMs: number; retryAfterMs?: number | null; random?: () => number }
): number {
  if (opts.retryAfterMs != null && opts.retryAfterMs > 0) {
    return Math.min(opts.retryAfterMs, opts.maxDelayMs);
  }
  const exponential = Math.min(opts.baseDelayMs * 2 ** Math.max(0, attempt - 1), opts.maxDelayMs);
  const jitter = 0.5 + (opts.random ?? Math.random)() * 0.5;
  return Math.round(exponential * jitter);
}

export class QueueOverflowError extends Error {
  constructor(name: string, limit: number) {
    super(`Kolejka ${name} jest pełna (${limit} oczekujących). Spróbuj za chwilę.`);
    this.name = 'QueueOverflowError';
  }
}

export class RequestQueue {
  private readonly opts: Required<Omit<RequestQueueOptions, 'sleep' | 'random'>> & {
    sleep: (ms: number) => Promise<void>;
    random: () => number;
  };

  private active = 0;
  private lastStartedAt = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: RequestQueueOptions) {
    this.opts = {
      ...options,
      sleep: options.sleep ?? defaultSleep,
      random: options.random ?? Math.random,
    };
  }

  /** Ile zapytan czeka na wolne miejsce. */
  get pending(): number {
    return this.waiting.length;
  }

  /** Ile zapytan leci w tej chwili. */
  get running(): number {
    return this.active;
  }

  async run<T>(task: () => Promise<T>, label = ''): Promise<T> {
    if (this.waiting.length >= this.opts.maxQueueLength) {
      throw new QueueOverflowError(this.opts.name, this.opts.maxQueueLength);
    }

    await this.acquireSlot();
    try {
      return await this.attempt(task, label);
    } finally {
      this.releaseSlot();
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.active >= this.opts.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;

    const sinceLast = Date.now() - this.lastStartedAt;
    const wait = this.opts.minIntervalMs - sinceLast;
    if (wait > 0) await this.opts.sleep(wait);

    this.lastStartedAt = Date.now();
  }

  private releaseSlot(): void {
    this.active--;
    this.waiting.shift()?.();
  }

  private async attempt<T>(task: () => Promise<T>, label: string): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.opts.maxRetries + 1; attempt++) {
      try {
        return await task();
      } catch (err) {
        lastError = err;

        if (!isRetryable(err) || attempt > this.opts.maxRetries) throw err;

        const delay = backoffDelayMs(attempt, {
          baseDelayMs: this.opts.baseDelayMs,
          maxDelayMs: this.opts.maxDelayMs,
          retryAfterMs: serverRetryAfterMs(err),
          random: this.opts.random,
        });

        console.warn(
          `[${this.opts.name}${label ? `:${label}` : ''}] próba ${attempt}/${this.opts.maxRetries} nieudana ` +
            `(${err instanceof Error ? err.message.slice(0, 120) : String(err)}) — ponawiam za ${delay} ms`
        );

        await this.opts.sleep(delay);
      }
    }

    throw lastError;
  }
}
