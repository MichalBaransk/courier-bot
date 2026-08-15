import 'dotenv/config';
import { GoogleGenAI, Type } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const MODEL_NAME = 'gemini-3.6-flash';

export async function processVisionDocument(imageBuffer: Buffer, mimeType: string, caption?: string, todayStr?: string) {
  const prompt = `Przeanalizuj ten zrzut ekranu / zdjęcie kuriera Glovo. Dzisiejsza data: ${todayStr}.
Wypełnij TYLKO pola widoczne na zdjęciu, reszta null.
A) OFERTA kursu: zielona kwota brutto, punkty z rodzajem (odbior/dostawa), nazwą, adresem i małą szarą liczbą km po prawej.
B) PALIWO / PARAGON / FAKTURA: kwota łączna (paliwo_cena), litry (paliwo_l - szukaj przy "l"/"litr", pomijaj kod CN i oktany 95/98), data zakupu.
C) SALDO GLOVO: pojedyncza kwota salda (ujemna jeśli Glovo winne kurierowi).
D) PORTFEL: lista pojedynczych transakcji z datą, godziną, typem (pobranie/wyplata/wyplata_gotowka/platnosc_punkt/korekta) i kwotą ze znakiem.
${caption ? `Podpis użytkownika: ${caption}` : ''}`;

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: [
      { text: prompt },
      { inlineData: { mimeType, data: imageBuffer.toString('base64') } }
    ],
    config: {
      temperature: 0.15,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          kwota_brutto: { type: Type.NUMBER },
          paliwo_cena: { type: Type.NUMBER },
          paliwo_l: { type: Type.NUMBER },
          saldo_glovo: { type: Type.NUMBER },
          data: { type: Type.STRING },
          punkty: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                rodzaj: { type: Type.STRING },
                nazwa: { type: Type.STRING },
                adres: { type: Type.STRING },
                dystans_km: { type: Type.NUMBER }
              },
              required: ['rodzaj']
            }
          },
          transakcje: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                data: { type: Type.STRING },
                godzina: { type: Type.STRING },
                typ: { type: Type.STRING },
                kwota: { type: Type.NUMBER },
                id: { type: Type.STRING }
              },
              required: ['data', 'typ', 'kwota']
            }
          }
        }
      }
    }
  });

  return JSON.parse(response.text || '{}');
}

export async function processVoiceOrText(input: { text?: string; audioBuffer?: Buffer; mimeType?: string }, todayStr: string) {
  const systemPrompt = `Jesteś asystentem finansowym kuriera. Dzisiejsza data: ${todayStr}.
Zwróć czysty JSON klasyfikujący dane:
- typ: "wpis" (dodanie/edycja danych) lub "pytanie" (o zarobki, saldo itp.)
- pola liczbowe: zarobki_brutto, paliwo_cena, paliwo_l, paliwo_dystans, saldo_glovo, napiwek_gotowka
- godziny: praca_od i praca_do (GG:MM) lub godziny_pracy (liczba)`;

  const parts: any[] = [{ text: systemPrompt }];
  if (input.audioBuffer) {
    parts.push({
      inlineData: {
        mimeType: input.mimeType || 'audio/ogg',
        data: input.audioBuffer.toString('base64')
      }
    });
  }
  if (input.text) parts.push({ text: `Treść: ${input.text}` });

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: parts,
    config: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          typ: { type: Type.STRING },
          data: { type: Type.STRING },
          zarobki_brutto: { type: Type.NUMBER },
          paliwo_cena: { type: Type.NUMBER },
          paliwo_l: { type: Type.NUMBER },
          paliwo_dystans: { type: Type.NUMBER },
          napiwek_gotowka: { type: Type.NUMBER },
          saldo_glovo: { type: Type.NUMBER },
          praca_od: { type: Type.STRING },
          praca_do: { type: Type.STRING },
          godziny_pracy: { type: Type.NUMBER }
        },
        required: ['typ']
      }
    }
  });

  return JSON.parse(response.text || '{}');
}