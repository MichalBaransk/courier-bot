import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  isRetryable,
  QueueOverflowError,
  RequestQueue,
  serverRetryAfterMs,
} from './rate-limiter.js';

/** Kolejka bez realnego czekania — testy lecą natychmiast. */
function testQueue(overrides: Partial<ConstructorParameters<typeof RequestQueue>[0]> = {}) {
  const slept: number[] = [];
  const queue = new RequestQueue({
    name: 'test',
    concurrency: 1,
    minIntervalMs: 0,
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 5000,
    maxQueueLength: 10,
    sleep: async (ms) => {
      slept.push(ms);
    },
    random: () => 1, // bez losowości — jitter zawsze 100%
    ...overrides,
  });
  return { queue, slept };
}

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`Request failed with status ${status}`), { status });
}

describe('isRetryable', () => {
  it('rozpoznaje limity i błędy serwera', () => {
    expect(isRetryable(httpError(429))).toBe(true);
    expect(isRetryable(httpError(503))).toBe(true);
    expect(isRetryable(httpError(500))).toBe(true);
  });

  it('nie ponawia błędów, które i tak się powtórzą', () => {
    expect(isRetryable(httpError(400))).toBe(false);
    expect(isRetryable(httpError(401))).toBe(false);
    expect(isRetryable(httpError(404))).toBe(false);
  });

  it('łapie błędy sieciowe Node', () => {
    expect(isRetryable(Object.assign(new Error('socket'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('dns'), { code: 'EAI_AGAIN' }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))).toBe(true);
  });

  it('rozpoznaje komunikaty Gemini bez pola status', () => {
    expect(isRetryable(new Error('[429] RESOURCE_EXHAUSTED: Quota exceeded'))).toBe(true);
    expect(isRetryable(new Error('The model is overloaded. Please try again later.'))).toBe(true);
    expect(isRetryable(new Error('Invalid API key'))).toBe(false);
  });
});

describe('serverRetryAfterMs', () => {
  it('czyta nagłówek Retry-After', () => {
    expect(serverRetryAfterMs({ headers: { 'retry-after': '30' } })).toBe(30_000);
  });

  it('czyta retryDelay z RetryInfo Google', () => {
    const err = new Error('RESOURCE_EXHAUSTED {"retryDelay":"31s"}');
    expect(serverRetryAfterMs(err)).toBe(31_000);
  });

  it('zwraca null, gdy serwer nic nie podpowiada', () => {
    expect(serverRetryAfterMs(new Error('boom'))).toBeNull();
  });
});

describe('backoffDelayMs', () => {
  it('rośnie wykładniczo', () => {
    const opts = { baseDelayMs: 1000, maxDelayMs: 60_000, random: () => 1 };
    expect(backoffDelayMs(1, opts)).toBe(1000);
    expect(backoffDelayMs(2, opts)).toBe(2000);
    expect(backoffDelayMs(3, opts)).toBe(4000);
    expect(backoffDelayMs(4, opts)).toBe(8000);
  });

  it('nie przekracza limitu', () => {
    expect(backoffDelayMs(20, { baseDelayMs: 1000, maxDelayMs: 60_000, random: () => 1 })).toBe(60_000);
  });

  it('jitter skraca opóźnienie maksymalnie o połowę', () => {
    const delay = backoffDelayMs(3, { baseDelayMs: 1000, maxDelayMs: 60_000, random: () => 0 });
    expect(delay).toBe(2000); // 4000 × 0.5
  });

  it('wskazówka serwera ma pierwszeństwo przed własnym backoffem', () => {
    const delay = backoffDelayMs(1, { baseDelayMs: 1000, maxDelayMs: 60_000, retryAfterMs: 31_000, random: () => 1 });
    expect(delay).toBe(31_000);
  });

  it('ale nadal podlega limitowi', () => {
    const delay = backoffDelayMs(1, { baseDelayMs: 1000, maxDelayMs: 10_000, retryAfterMs: 600_000, random: () => 1 });
    expect(delay).toBe(10_000);
  });
});

describe('RequestQueue', () => {
  it('ponawia po 429 i zwraca wynik', async () => {
    const { queue, slept } = testQueue();
    let calls = 0;

    const result = await queue.run(async () => {
      calls++;
      if (calls < 3) throw httpError(429);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(slept).toEqual([100, 200]); // backoff między próbami
  });

  it('poddaje się po wyczerpaniu prób', async () => {
    const { queue } = testQueue({ maxRetries: 2 });
    let calls = 0;

    await expect(
      queue.run(async () => {
        calls++;
        throw httpError(503);
      })
    ).rejects.toThrow('503');

    expect(calls).toBe(3); // pierwsza próba + 2 ponowienia
  });

  it('nie ponawia błędów trwałych', async () => {
    const { queue } = testQueue();
    let calls = 0;

    await expect(
      queue.run(async () => {
        calls++;
        throw httpError(400);
      })
    ).rejects.toThrow('400');

    expect(calls).toBe(1);
  });

  it('respektuje wskazówkę serwera zamiast własnego backoffu', async () => {
    // maxDelayMs musi być wyższe niż wskazówka, inaczej zostanie przycięta.
    const { queue, slept } = testQueue({ maxDelayMs: 30_000 });
    let calls = 0;

    await queue.run(async () => {
      calls++;
      if (calls === 1) throw new Error('RESOURCE_EXHAUSTED {"retryDelay":"7s"}');
      return 'ok';
    });

    expect(slept).toEqual([7000]); // zamiast bazowych 100 ms
  });

  it('przycina wskazówkę serwera do maxDelayMs', async () => {
    const { queue, slept } = testQueue({ maxDelayMs: 5000 });
    let calls = 0;

    await queue.run(async () => {
      calls++;
      if (calls === 1) throw new Error('RESOURCE_EXHAUSTED {"retryDelay":"120s"}');
      return 'ok';
    });

    expect(slept).toEqual([5000]);
  });

  it('pilnuje limitu równoległości', async () => {
    const { queue } = testQueue({ concurrency: 2 });
    let running = 0;
    let peak = 0;

    const task = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    };

    await Promise.all(Array.from({ length: 6 }, () => queue.run(task)));

    expect(peak).toBe(2);
  });

  it('przepuszcza album 3 zdjęć = 6 wywołań, ale pojedynczo', async () => {
    const { queue } = testQueue({ concurrency: 1 });
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 6 }, (_, idx) =>
        queue.run(async () => {
          order.push(idx);
          await new Promise((r) => setTimeout(r, 1));
        })
      )
    );

    expect(order).toHaveLength(6);
    expect(queue.running).toBe(0);
    expect(queue.pending).toBe(0);
  });

  it('odrzuca zadania, gdy kolejka jest przepełniona', async () => {
    const { queue } = testQueue({ concurrency: 1, maxQueueLength: 2 });
    const slow = () => queue.run(() => new Promise((r) => setTimeout(r, 20)));

    const running = [slow(), slow(), slow()]; // 1 aktywne + 2 czekające
    await expect(slow()).rejects.toThrow(QueueOverflowError);

    await Promise.all(running);
  });

  it('zwalnia miejsce także po błędzie', async () => {
    const { queue } = testQueue({ concurrency: 1, maxRetries: 0 });

    await expect(queue.run(async () => Promise.reject(httpError(400)))).rejects.toThrow();
    await expect(queue.run(async () => 'działa')).resolves.toBe('działa');
    expect(queue.running).toBe(0);
  });
});
