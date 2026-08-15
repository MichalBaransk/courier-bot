import { GoogleGenAI, Type, Schema } from '@google/genai';

export interface VoiceExtractedData {
  transcription: string;
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

const voiceExtractionSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    transcription: {
      type: Type.STRING,
      description: 'Precyzyjna, dosłowna transkrypcja wypowiedzi kuriera w języku polskim.',
    },
    fuelPrice: {
      type: Type.NUMBER,
      nullable: true,
      description: 'Kwota zapłacona za paliwo w PLN (np. 75 dla 75 zł).',
    },
    fuelLiters: {
      type: Type.NUMBER,
      nullable: true,
      description: 'Liczba zatankowanych litrów paliwa (np. 11.2).',
    },
    fuelDistance: {
      type: Type.INTEGER,
      nullable: true,
      description: 'Stan licznika / całkowity przebieg pojazdu w km (np. 24300).',
    },
    grossEarnings: {
      type: Type.NUMBER,
      nullable: true,
      description: 'Zarobek brutto w PLN jeśli podano.',
    },
    workFrom: {
      type: Type.STRING,
      nullable: true,
      description: 'Godzina rozpoczęcia pracy w formacie HH:MM.',
    },
    workTo: {
      type: Type.STRING,
      nullable: true,
      description: 'Godzina zakończenia pracy w formacie HH:MM.',
    },
    cashTip: {
      type: Type.NUMBER,
      nullable: true,
      description: 'Kwota napiwku gotówkowego w PLN.',
    },
  },
  required: ['transcription'],
};

const fuelReceiptSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    date: {
      type: Type.STRING,
      nullable: true,
      description: 'Data transakcji z paragonu w formacie YYYY-MM-DD.',
    },
    fuelPrice: {
      type: Type.NUMBER,
      nullable: true,
      description: 'Łączna kwota do zapłaty (Suma PLN) za paliwo.',
    },
    fuelLiters: {
      type: Type.NUMBER,
      nullable: true,
      description: 'Ilość zatankowanego paliwa w litrach.',
    },
  },
  required: ['fuelPrice'],
};

const courseOfferSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    grossAmount: {
      type: Type.NUMBER,
      description: 'Kwota wynagrodzenia brutto dla kuriera za realizację zlecenia. Ignoruj kwoty "POTRZEBNA GOTÓWKA", "ZAPŁAĆ" i "ODBIERZ".',
    },
    pickupAddress: {
      type: Type.STRING,
      description: 'Adres lub nazwa punktu odbioru (restauracja / sklep).',
    },
    deliveryAddress: {
      type: Type.STRING,
      description: 'Adres doręczenia do klienta.',
    },
    appDistanceKm: {
      type: Type.NUMBER,
      nullable: true,
      description: 'Szacowany dystans w kilometrach, jeśli jest podany na zrzucie ekranu.',
    },
  },
  required: ['grossAmount', 'pickupAddress', 'deliveryAddress'],
};

export class GeminiService {
  private ai: GoogleGenAI;
  private model: string;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this.model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  }

  /**
   * Voice-to-Data: Przetwarzanie notatek głosowych nagranych podczas jazdy.
   */
  async parseVoiceNote(audioBuffer: Buffer, mimeType = 'audio/ogg'): Promise<VoiceExtractedData> {
    const base64Audio = audioBuffer.toString('base64');
    const prompt = `
Jesteś asystentem kuriera dostarczającego zamówienia. Przeanalizuj notatkę głosową nagraną w trasie.
Wyodrębnij parametry:
1. Tankowanie: koszt całkowity w PLN, ilość litrów, stan licznika kilometrów (przebieg całkowity).
2. Czas pracy: zakres godzin (od-do w formacie HH:MM).
3. Finanse: zarobek brutto lub napiwek gotówkowy.
Ignoruj szum wiatru, silnika i odgłosy uliczne. Przypisz wartości do odpowiednich pól schematu JSON.
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

    const text = response.text;
    if (!text) throw new Error('Gemini API zwróciło pustą odpowiedź dla notatki audio.');
    return JSON.parse(text) as VoiceExtractedData;
  }

  /**
   * Vision: Odczyt danych z paragonu/faktury za paliwo.
   */
  async extractFuelReceipt(imageBuffer: Buffer, mimeType = 'image/jpeg'): Promise<FuelReceiptExtractedData> {
    const base64Image = imageBuffer.toString('base64');
    const prompt = `
Przeanalizuj zdjęcie paragonu/faktury za paliwo.
Wyciągnij:
- Łączną kwotę do zapłaty (PLN)
- Ilość zatankowanych litrów
- Datę transakcji (YYYY-MM-DD)
Ignoruj kody CN, numery stacji benzynowej, numery dystrybutorów oraz oznaczenia oktanowe (PB95, ON, 98).
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

    const text = response.text;
    if (!text) throw new Error('Gemini API zwróciło pustą odpowiedź dla paragonu.');
    return JSON.parse(text) as FuelReceiptExtractedData;
  }

  /**
   * Vision: Analiza zrzutu ekranu oferty kursu Glovo.
   */
  async analyzeCourseOffer(imageBuffer: Buffer, mimeType = 'image/jpeg'): Promise<CourseOfferExtractedData> {
    const base64Image = imageBuffer.toString('base64');
    const prompt = `
Przeanalizuj zrzut ekranu oferty kursu z aplikacji kurierskiej Glovo.
Wyciągnij:
1. Kwotę wynagrodzenia brutto dla kuriera za realizację zlecenia.
   Pomiń etykiety "POTRZEBNA GOTÓWKA" i "ZAPŁAĆ" (pobrania gotówkowe od klienta).
2. Adres/nazwę punktu odbioru (restauracja / sklep).
3. Adres doręczenia do klienta.
4. Szacowany dystans w km, jeśli występuje.
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

    const text = response.text;
    if (!text) throw new Error('Gemini API zwróciło pustą odpowiedź dla zrzutu ekranu.');
    return JSON.parse(text) as CourseOfferExtractedData;
  }
}

export const geminiService = new GeminiService();