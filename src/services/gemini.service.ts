import { GoogleGenAI, Type, type Schema } from '@google/genai';
import { z } from 'zod';
import { CFG } from '../config.js';
import { RequestQueue } from '../utils/rate-limiter.js';

/**
 * Wszystkie wywolania Gemini przechodza przez jedna kolejke procesu.
 * Ogranicza rownoleglosc, wymusza odstep miedzy zapytaniami i ponawia 429/503
 * z wykladniczym backoffem, honorujac `retryDelay` z odpowiedzi Google.
 */
export const geminiQueue = new RequestQueue({
  name: 'gemini',
  concurrency: CFG.GEMINI_CONCURRENCY,
  minIntervalMs: CFG.GEMINI_MIN_INTERVAL_MS,
  maxRetries: CFG.GEMINI_MAX_RETRIES,
  baseDelayMs: CFG.GEMINI_BASE_DELAY_MS,
  maxDelayMs: CFG.GEMINI_MAX_DELAY_MS,
  maxQueueLength: CFG.GEMINI_MAX_QUEUE,
});

/**
 * FIX (3.10): odpowiedzi modelu byly rzutowane przez `as`, bez zadnej walidacji.
 * Przy ucietym albo pustym JSON-ie `extracted.transcription` bylo `undefined`,
 * a `extracted.grossEarnings.toFixed(2)` wywalalo handler. Teraz kazda odpowiedz
 * przechodzi przez zod, a przy bledzie parsowania robimy jeden retry.
 *
 * FIX (5.6 + 1.2): nazwa modelu tylko z `CFG.GEMINI_MODEL`, typ `Schema`
 * importowany jako `import type` (wymog `verbatimModuleSyntax`).
 */

const nullableNumber = z.number().nullish().transform((v) => v ?? null);
const nullableString = z.string().nullish().transform((v) => v ?? null);

export const VoiceExtractedSchema = z.object({
  transcription: z.string().default(''),
  action: z.enum(['UPSERT', 'DELETE']).default('UPSERT'),
  deleteTarget: z
    .enum(['LAST_TIP', 'ALL_TIPS', 'FUEL', 'HOURS', 'EARNINGS', 'DISTANCE', 'ALL_DAY'])
    .nullish()
    .transform((v) => v ?? null),
  targetDate: nullableString,
  fuelTotalCost: nullableNumber,
  fuelLiters: nullableNumber,
  fuelPricePerLiter: nullableNumber,
  distanceKm: nullableNumber,
  grossEarnings: nullableNumber,
  workFrom: nullableString,
  workTo: nullableString,
  cashTip: nullableNumber,
});
export type VoiceExtractedData = z.infer<typeof VoiceExtractedSchema>;

export const FuelReceiptSchema = z.object({
  date: nullableString,
  totalCost: z.number(),
  liters: nullableNumber,
  pricePerLiter: nullableNumber,
});
export type FuelReceiptExtractedData = z.infer<typeof FuelReceiptSchema>;

export const CourseOfferSchema = z.object({
  grossAmount: z.number(),
  pickupAddress: z.string().min(1),
  deliveryAddress: z.string().min(1),
  /** Dystans z aplikacji Glovo: kurier -> punkt odbioru (przy wierszu restauracji). */
  appPickupKm: nullableNumber,
  /** Dystans z aplikacji Glovo: odbior -> klient (przy wierszu "Dostawa"). */
  appDeliveryKm: nullableNumber,
});
export type CourseOfferExtractedData = z.infer<typeof CourseOfferSchema>;

export const WalletTransactionItemSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{1,2}:\d{2}$/),
  type: z.enum(['pobranie', 'wyplata', 'wyplata_gotowka', 'platnosc_punkt', 'korekta']),
  amount: z.number(),
  externalId: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
});
export type WalletTransactionItem = z.infer<typeof WalletTransactionItemSchema>;

const WalletScreenSchema = z.object({
  transactions: z.array(WalletTransactionItemSchema).default([]),
});

const ImageCategorySchema = z.object({
  category: z.enum(['WALLET', 'FUEL', 'OFFER']).default('OFFER'),
});
export type ImageCategory = z.infer<typeof ImageCategorySchema>['category'];

// --- Schematy responseSchema dla Gemini -------------------------------------

const voiceResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    transcription: { type: Type.STRING, description: 'Dosłowna transkrypcja wypowiedzi po polsku.' },
    action: { type: Type.STRING, enum: ['UPSERT', 'DELETE'] },
    deleteTarget: {
      type: Type.STRING,
      enum: ['LAST_TIP', 'ALL_TIPS', 'FUEL', 'HOURS', 'EARNINGS', 'DISTANCE', 'ALL_DAY'],
      nullable: true,
    },
    targetDate: { type: Type.STRING, nullable: true, description: 'YYYY-MM-DD, TODAY albo YESTERDAY.' },
    fuelTotalCost: { type: Type.NUMBER, nullable: true, description: 'Łączna kwota tankowania w zł.' },
    fuelLiters: { type: Type.NUMBER, nullable: true },
    fuelPricePerLiter: { type: Type.NUMBER, nullable: true, description: 'Cena za litr w zł.' },
    distanceKm: { type: Type.NUMBER, nullable: true, description: 'Dystans PRZEJECHANY danego dnia, nie stan licznika.' },
    grossEarnings: { type: Type.NUMBER, nullable: true },
    workFrom: { type: Type.STRING, nullable: true, description: 'HH:MM' },
    workTo: { type: Type.STRING, nullable: true, description: 'HH:MM' },
    cashTip: { type: Type.NUMBER, nullable: true },
  },
  required: ['transcription', 'action'],
};

const fuelReceiptResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    date: { type: Type.STRING, nullable: true },
    totalCost: { type: Type.NUMBER, description: 'Kwota do zapłaty za paliwo w zł.' },
    liters: { type: Type.NUMBER, nullable: true },
    pricePerLiter: { type: Type.NUMBER, nullable: true, description: 'Cena jednostkowa za litr w zł.' },
  },
  required: ['totalCost'],
};

const courseOfferResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    grossAmount: { type: Type.NUMBER },
    pickupAddress: { type: Type.STRING },
    deliveryAddress: { type: Type.STRING },
    appPickupKm: {
      type: Type.NUMBER,
      nullable: true,
      description: 'Kilometry po PRAWEJ stronie wiersza z nazwą i adresem punktu odbioru (np. 3,37 km).',
    },
    appDeliveryKm: {
      type: Type.NUMBER,
      nullable: true,
      description: 'Kilometry po PRAWEJ stronie wiersza "Dostawa" (np. 3,01 km).',
    },
  },
  required: ['grossAmount', 'pickupAddress', 'deliveryAddress'],
};

const walletScreenResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    transactions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          date: {
            type: Type.STRING,
            description: 'Data YYYY-MM-DD na podstawie nagłówka sekcji (np. "czw., 6 sierpnia").',
          },
          time: { type: Type.STRING, description: 'Godzina transakcji HH:MM (np. 15:50).' },
          type: {
            type: Type.STRING,
            enum: ['pobranie', 'wyplata', 'wyplata_gotowka', 'platnosc_punkt', 'korekta'],
            description:
              '"Pobranie gotówki od klienta" -> pobranie, "Wypłata" -> wyplata, "Wypłata w gotówce" -> wyplata_gotowka, "Płatność w punkcie" -> platnosc_punkt, "Korekta" -> korekta.',
          },
          amount: {
            type: Type.NUMBER,
            description: 'Kwota ZE ZNAKIEM (ujemna przy minusie, np. -180.60; dodatnia przy pobraniu, np. 63.34).',
          },
          externalId: { type: Type.STRING, nullable: true, description: 'Identyfikator transakcji (ciąg cyfr).' },
        },
        required: ['date', 'time', 'type', 'amount'],
      },
    },
  },
  required: ['transactions'],
};

const imageCategoryResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    category: { type: Type.STRING, enum: ['WALLET', 'FUEL', 'OFFER'] },
  },
  required: ['category'],
};

export class GeminiService {
  private readonly ai: GoogleGenAI;
  private readonly model: string;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('Brak zmiennej GEMINI_API_KEY w pliku .env!');
    this.ai = new GoogleGenAI({ apiKey });
    this.model = CFG.GEMINI_MODEL;
  }

  /** Jedno wywolanie + walidacja zod. Przy bledzie parsowania jeden retry. */
  private async generate<T>(
    schema: z.ZodType<T>,
    responseSchema: Schema,
    parts: Array<Record<string, unknown>>,
    temperature: number,
    label: string
  ): Promise<T> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      // Kolejka zajmuje sie limitami i ponawianiem bledow sieciowych;
      // ta petla obsluguje wylacznie odpowiedz niezgodna ze schematem.
      const response = await geminiQueue.run(
        () =>
          this.ai.models.generateContent({
            model: this.model,
            contents: [{ role: 'user', parts }],
            config: {
              responseMimeType: 'application/json',
              responseSchema,
              temperature,
            },
          }),
        label
      );

      try {
        return schema.parse(JSON.parse(response.text || '{}'));
      } catch (err) {
        lastError = err;
        console.warn(`[Gemini:${label}] próba ${attempt} — nieprawidłowa odpowiedź:`, err);
      }
    }

    throw new Error(`Model zwrócił odpowiedź niezgodną ze schematem (${label}): ${String(lastError)}`);
  }

  async parseVoiceNote(audioBuffer: Buffer, mimeType = 'audio/ogg'): Promise<VoiceExtractedData> {
    const prompt = `
Jesteś asystentem kuriera. Przeanalizuj nagranie audio i zwróć dane w JSON.
Rozpoznaj akcję:
- UPSERT: tankowanie (łączna kwota, litry, cena za litr), przejechany dystans, godziny od-do, zarobki brutto, napiwek gotówkowy.
- DELETE: 'LAST_TIP', 'ALL_TIPS', 'FUEL', 'HOURS', 'EARNINGS', 'DISTANCE', 'ALL_DAY'.
Uwaga: "distanceKm" to dystans PRZEJECHANY danego dnia, nie stan licznika pojazdu.
Jeśli kurier poda stan licznika, zostaw distanceKm puste.
Ignoruj szum wiatru i wydechu motocykla.
`;
    return this.generate(
      VoiceExtractedSchema,
      voiceResponseSchema,
      [{ inlineData: { mimeType, data: audioBuffer.toString('base64') } }, { text: prompt }],
      0.1,
      'voice'
    );
  }

  async extractFuelReceipt(imageBuffer: Buffer, mimeType = 'image/jpeg'): Promise<FuelReceiptExtractedData> {
    const prompt = `
Przeanalizuj paragon paliwowy. Wyciągnij:
- totalCost: łączną kwotę do zapłaty w PLN,
- liters: ilość litrów,
- pricePerLiter: cenę jednostkową za litr w PLN,
- date: datę w formacie YYYY-MM-DD.
Ignoruj kody CN, numery stacji i oznaczenia 95/98.
`;
    return this.generate(
      FuelReceiptSchema,
      fuelReceiptResponseSchema,
      [{ inlineData: { mimeType, data: imageBuffer.toString('base64') } }, { text: prompt }],
      0.1,
      'fuel'
    );
  }

  async analyzeCourseOffer(imageBuffer: Buffer, mimeType = 'image/jpeg'): Promise<CourseOfferExtractedData> {
    const prompt = `
Przeanalizuj ofertę kursu Glovo. Ekran ma układ pionowej osi z dwoma punktami.

- grossAmount: duża zielona kwota u góry. IGNORUJ "POTRZEBNA GOTÓWKA" i przycisk "ZAPŁAĆ ... zł"
  (to gotówka do pobrania od klienta, nie zarobek).
- pickupAddress: nazwa i adres pierwszego punktu (ikona sklepu).
- deliveryAddress: opis drugiego punktu (ikona osoby, zwykle podpisany "Dostawa").
  Często jest to sama nazwa miasta — przepisz dokładnie to, co widzisz, nie zgaduj adresu.
- appPickupKm: liczba kilometrów wyrównana do PRAWEJ w wierszu punktu odbioru (np. 3,37 km).
- appDeliveryKm: liczba kilometrów wyrównana do PRAWEJ w wierszu "Dostawa" (np. 3,01 km).

Kilometry zapisuj jako liczby, przecinek zamień na kropkę. Jeśli któregoś nie widać, zwróć null.
`;
    return this.generate(
      CourseOfferSchema,
      courseOfferResponseSchema,
      [{ inlineData: { mimeType, data: imageBuffer.toString('base64') } }, { text: prompt }],
      0.1,
      'offer'
    );
  }

  /** Vision: OCR zrzutow ekranu Portfela Glovo (lista transakcji). */
  async analyzeWalletScreenshot(
    imageBuffer: Buffer,
    currentYear: number,
    mimeType = 'image/jpeg'
  ): Promise<WalletTransactionItem[]> {
    const prompt = `
Przeanalizuj zrzut ekranu "Portfel" z aplikacji Glovo. Bieżący rok to ${currentYear}.
Wyodrębnij wszystkie widoczne transakcje z listy:
- Nagłówek dnia (np. "Dzisiaj, 11 sierpnia" -> ${currentYear}-08-11, "czw., 6 sierpnia" -> ${currentYear}-08-06).
- Typ pozycji:
  • "Pobranie gotówki od klienta" -> pobranie (kwota dodatnia, np. 35.99)
  • "Wypłata" -> wyplata (kwota ujemna, np. -174.89)
  • "Wypłata w gotówce" -> wyplata_gotowka (kwota ujemna, np. -100.00)
  • "Płatność w punkcie" -> platnosc_punkt (kwota ujemna, np. -255.69)
  • "Korekta" -> korekta (kwota ze znakiem, np. -2.78)
- Godzina: format HH:MM pod nazwą.
- ID transakcji: ciąg cyfr po kropce obok godziny. Jeśli brak, zwróć pusty string.
- IGNORUJ wiersze podsumowania "Łączna kwota w gotówce".
`;
    const parsed = await this.generate(
      WalletScreenSchema,
      walletScreenResponseSchema,
      [{ inlineData: { mimeType, data: imageBuffer.toString('base64') } }, { text: prompt }],
      0.1,
      'wallet'
    );
    return parsed.transactions;
  }

  /** Automatyczna klasyfikacja rodzaju przeslanego obrazu. */
  async classifyImage(imageBuffer: Buffer, caption = '', mimeType = 'image/jpeg'): Promise<ImageCategory> {
    const lower = caption.toLowerCase();
    if (lower.includes('portfel')) return 'WALLET';
    if (lower.includes('paragon') || lower.includes('paliwo') || lower.includes('stacja')) return 'FUEL';
    if (lower.includes('oferta') || lower.includes('kurs') || lower.includes('zlecenie')) return 'OFFER';

    const prompt = `
Rozpoznaj typ ekranu:
- WALLET (ekran "Portfel" z listą transakcji: Pobranie gotówki, Wypłata, Płatność w punkcie)
- FUEL (paragon ze stacji paliw, faktura Orlen/CircleK/itp.)
- OFFER (nowa oferta zlecenia Glovo z mapą, trasą i zieloną kwotą)
`;
    const res = await this.generate(
      ImageCategorySchema,
      imageCategoryResponseSchema,
      [{ inlineData: { mimeType, data: imageBuffer.toString('base64') } }, { text: prompt }],
      0.0,
      'classify'
    );
    return res.category;
  }
}

export const geminiService = new GeminiService();
