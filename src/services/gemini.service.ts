import { GoogleGenAI, Type, Schema } from '@google/genai';

export interface VoiceExtractedData {
  transcription: string;
  action: 'UPSERT' | 'DELETE';
  deleteTarget?: 'LAST_TIP' | 'ALL_TIPS' | 'FUEL' | 'HOURS' | 'EARNINGS' | 'ALL_DAY' | null;
  targetDate?: string | null;
  fuelPrice?: number | null;
  fuelLiters?: number | null;
  fuelDistance?: number | null;
  grossEarnings?: number | null;
  workFrom?: string | null;
  workTo?: string | null;
  cashTip?: number | null;
}

export interface FuelReceiptExtractedData {
  date?: string | null;
  fuelPrice?: number | null;
  fuelLiters?: number | null;
}

export interface CourseOfferExtractedData {
  grossAmount: number;
  pickupAddress: string;
  deliveryAddress: string;
  appDistanceKm?: number | null;
}

export interface WalletTransactionItem {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  type: 'pobranie' | 'wyplata' | 'wyplata_gotowka' | 'platnosc_punkt' | 'korekta';
  amount: number;
  externalId?: string | null;
}

const voiceExtractionSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    transcription: {
      type: Type.STRING,
      description: 'Dosłowna transkrypcja wypowiedzi w języku polskim.',
    },
    action: {
      type: Type.STRING,
      enum: ['UPSERT', 'DELETE'],
    },
    deleteTarget: {
      type: Type.STRING,
      enum: ['LAST_TIP', 'ALL_TIPS', 'FUEL', 'HOURS', 'EARNINGS', 'ALL_DAY'],
      nullable: true,
    },
    targetDate: {
      type: Type.STRING,
      nullable: true,
    },
    fuelPrice: { type: Type.NUMBER, nullable: true },
    fuelLiters: { type: Type.NUMBER, nullable: true },
    fuelDistance: { type: Type.INTEGER, nullable: true },
    grossEarnings: { type: Type.NUMBER, nullable: true },
    workFrom: { type: Type.STRING, nullable: true },
    workTo: { type: Type.STRING, nullable: true },
    cashTip: { type: Type.NUMBER, nullable: true },
  },
  required: ['transcription', 'action'],
};

const fuelReceiptSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    date: { type: Type.STRING, nullable: true },
    fuelPrice: { type: Type.NUMBER, nullable: true },
    fuelLiters: { type: Type.NUMBER, nullable: true },
  },
  required: ['fuelPrice'],
};

const courseOfferSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    grossAmount: { type: Type.NUMBER },
    pickupAddress: { type: Type.STRING },
    deliveryAddress: { type: Type.STRING },
    appDistanceKm: { type: Type.NUMBER, nullable: true },
  },
  required: ['grossAmount', 'pickupAddress', 'deliveryAddress'],
};

const walletScreenSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    transactions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          date: {
            type: Type.STRING,
            description: 'Data w formacie YYYY-MM-DD na podstawie nagłówka sekcji (np. "czw., 6 sierpnia" -> 2026-08-06).',
          },
          time: {
            type: Type.STRING,
            description: 'Godzina transakcji w formacie HH:MM (np. 15:50).',
          },
          type: {
            type: Type.STRING,
            enum: ['pobranie', 'wyplata', 'wyplata_gotowka', 'platnosc_punkt', 'korekta'],
            description: 'Dokładny typ: "Pobranie gotówki od klienta" -> pobranie, "Wypłata" -> wyplata, "Wypłata w gotówce" -> wyplata_gotowka, "Płatność w punkcie" -> platnosc_punkt, "Korekta" -> korekta.',
          },
          amount: {
            type: Type.NUMBER,
            description: 'Kwota ze znakiem (ujemna jeśli jest minus, np. -180.60 dla wypłaty, 63.34 dla pobrania).',
          },
          externalId: {
            type: Type.STRING,
            nullable: true,
            description: 'Identyfikator transakcji (długi ciąg cyfr, np. 101735350998).',
          },
        },
        required: ['date', 'time', 'type', 'amount'],
      },
    },
  },
  required: ['transactions'],
};

export class GeminiService {
  private ai: GoogleGenAI;
  private model: string;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this.model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  }

  async parseVoiceNote(audioBuffer: Buffer, mimeType = 'audio/ogg'): Promise<VoiceExtractedData> {
    const base64Audio = audioBuffer.toString('base64');
    const prompt = `
Jesteś asystentem kuriera. Przeanalizuj nagranie audio.
Rozpoznaj akcję:
- UPSERT: tankowanie (koszt, litry, licznik), godziny od-do, zarobki brutto, napiwek gotówkowy.
- DELETE: 'LAST_TIP', 'ALL_TIPS', 'FUEL', 'HOURS', 'EARNINGS', 'ALL_DAY'.
Ignoruj szum wiatru i wydechu motocykla.
`;

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: base64Audio } },
            { text: prompt },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: voiceExtractionSchema,
        temperature: 0.1,
      },
    });

    return JSON.parse(response.text || '{}') as VoiceExtractedData;
  }

  async extractFuelReceipt(imageBuffer: Buffer, mimeType = 'image/jpeg'): Promise<FuelReceiptExtractedData> {
    const base64Image = imageBuffer.toString('base64');
    const prompt = `
Przeanalizuj paragon paliwowy. Wyciągnij: łączną kwotę w PLN, ilość litrów, datę (YYYY-MM-DD).
Ignoruj kody CN, numery stacji i oznaczenia 95/98.
`;

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: base64Image } },
            { text: prompt },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: fuelReceiptSchema,
        temperature: 0.1,
      },
    });

    return JSON.parse(response.text || '{}') as FuelReceiptExtractedData;
  }

  async analyzeCourseOffer(imageBuffer: Buffer, mimeType = 'image/jpeg'): Promise<CourseOfferExtractedData> {
    const base64Image = imageBuffer.toString('base64');
    const prompt = `
Przeanalizuj ofertę kursu Glovo.
Wyciągnij: kwotę brutto za kurs (ignoruj "POTRZEBNA GOTÓWKA" i "ZAPŁAĆ"), adres odbioru, adres klienta, szacowany dystans km.
`;

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: base64Image } },
            { text: prompt },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: courseOfferSchema,
        temperature: 0.1,
      },
    });

    return JSON.parse(response.text || '{}') as CourseOfferExtractedData;
  }

  /**
   * Vision: OCR zrzutów ekranu Portfela Glovo (lista transakcji).
   */
  async analyzeWalletScreenshot(
    imageBuffer: Buffer,
    currentYear = new Date().getFullYear(),
    mimeType = 'image/jpeg'
  ): Promise<WalletTransactionItem[]> {
    const base64Image = imageBuffer.toString('base64');
    const prompt = `
Przeanalizuj zrzut ekranu "Portfel" z aplikacji Glovo. Bieżący rok to ${currentYear}.
Wyodrębnij wszystkie widoczne transakcje z listy:
- Nagłówek dnia (np. "Dzisiaj, 11 sierpnia" -> ${currentYear}-08-11, "czw., 6 sierpnia" -> ${currentYear}-08-06, "niedz., 26 lipca" -> ${currentYear}-07-26).
- Typ pozycji:
  • "Pobranie gotówki od klienta" -> pobranie (kwota dodatnia, np. 35.99)
  • "Wypłata" -> wyplata (kwota ujemna, np. -174.89)
  • "Wypłata w gotówce" -> wyplata_gotowka (kwota ujemna, np. -100.00)
  • "Płatność w punkcie" -> platnosc_punkt (kwota ujemna, np. -255.69)
  • "Korekta" -> korekta (kwota ze znakiem, np. -2.78)
- Godzina: format HH:MM pod nazwą.
- ID transakcji: ciąg cyfr po kropce obok godziny (np. 101735350998). Jeśli brak, zwróć null.
- IGNORUJ wiersze podsumowania "Łączna kwota w gotówce".
`;

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: base64Image } },
            { text: prompt },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: walletScreenSchema,
        temperature: 0.1,
      },
    });

    const parsed = JSON.parse(response.text || '{}') as { transactions?: WalletTransactionItem[] };
    return parsed.transactions || [];
  }

  /**
   * Automatyczna klasyfikacja rodzaju przesłanego obrazu.
   */
  async classifyImage(imageBuffer: Buffer, caption = '', mimeType = 'image/jpeg'): Promise<'WALLET' | 'FUEL' | 'OFFER'> {
    const lowerCaption = caption.toLowerCase();
    if (lowerCaption.includes('portfel')) return 'WALLET';
    if (lowerCaption.includes('paragon') || lowerCaption.includes('paliwo') || lowerCaption.includes('stacja')) return 'FUEL';

    const base64Image = imageBuffer.toString('base64');
    const prompt = `
Rozpoznaj typ ekranu:
- WALLET (ekran z nagłówkiem "Portfel", listą transakcji: Pobranie gotówki, Wypłata, Płatność w punkcie)
- FUEL (paragon ze stacji paliw, faktura Orlen/CircleK/itp.)
- OFFER (nowa oferta zlecenia Glovo z mapą, trasą i zieloną kwotą)
Zwróć obiekt JSON z polem "category": "WALLET" | "FUEL" | "OFFER".
`;

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: base64Image } },
            { text: prompt },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            category: { type: Type.STRING, enum: ['WALLET', 'FUEL', 'OFFER'] },
          },
          required: ['category'],
        },
        temperature: 0.0,
      },
    });

    const res = JSON.parse(response.text || '{}') as { category?: 'WALLET' | 'FUEL' | 'OFFER' };
    return res.category || 'OFFER';
  }
}

export const geminiService = new GeminiService();