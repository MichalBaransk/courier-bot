import { GoogleGenAI, Type } from '@google/genai';
import { z } from 'zod';
import 'dotenv/config';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export const BotResponseSchema = z.object({
  action: z.enum(['SUMMARY', 'TASK', 'GENERAL']),
  reply: z.string(),
  sentiment: z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE']),
});

export type BotResponse = z.infer<typeof BotResponseSchema>;

export async function processUserMessage(prompt: string): Promise<BotResponse> {
  const response = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: prompt,
    config: {
      systemInstruction:
        'Jesteś pomocnym asystentem w bocie Telegram. Zwracaj odpowiedź wyłącznie w formacie JSON zgodnym ze schematem. Klasyfikuj zadania i sentyment wypowiedzi użytkownika.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          action: {
            type: Type.STRING,
            enum: ['SUMMARY', 'TASK', 'GENERAL'],
          },
          reply: {
            type: Type.STRING,
          },
          sentiment: {
            type: Type.STRING,
            enum: ['POSITIVE', 'NEUTRAL', 'NEGATIVE'],
          },
        },
        required: ['action', 'reply', 'sentiment'],
      },
    },
  });

  const rawJson = JSON.parse(response.text || '{}');
  return BotResponseSchema.parse(rawJson);
}