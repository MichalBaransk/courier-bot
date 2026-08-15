import { describe, it, expect } from 'vitest';
import { GeminiResponseSchema } from '../src/index';

describe('Gemini Data Validation', () => {
  it('powinien poprawnie przetworzyć poprawny payload z AI', () => {
    const rawAiOutput = {
      action: 'SUMMARY',
      confidence: 0.95,
      reply: 'Oto podsumowanie transakcji.',
    };

    const parsed = GeminiResponseSchema.safeParse(rawAiOutput);
    expect(parsed.success).toBe(true);
  });

  it('powinien odrzucić niepoprawne pole akcji', () => {
    const badOutput = {
      action: 'UNKNOWN_ACTION',
      confidence: 0.5,
      reply: 'Błąd',
    };

    const parsed = GeminiResponseSchema.safeParse(badOutput);
    expect(parsed.success).toBe(false);
  });
});