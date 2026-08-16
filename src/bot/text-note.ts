/**
 * Filtr decydujacy, czy wolny tekst warto oddac Gemini.
 *
 * Bez niego KAZDA nierozpoznana wiadomosc — „ok”, „dzięki”, przypadkowy
 * klikniety emoji — bylaby wywolaniem modelu. Przy jednym uzytkowniku to
 * jeszcze nie problem finansowy, ale zajmuje miejsce w kolejce i psuje
 * czas odpowiedzi realnym wpisom.
 *
 * Kryterium: **kazdy sensowny wpis zawiera liczbe** — kwote, kilometry albo
 * godzine. Tekst bez zadnej cyfry na pewno nie jest wpisem do zapisania.
 *
 * Czysta funkcja, bez odwolan do CFG — limit wchodzi parametrem, zeby dalo sie
 * ja testowac bez ustawiania srodowiska.
 */

const HAS_DIGIT = /\d/;

export function shouldParseAsNote(text: string, maxChars: number): boolean {
  const trimmed = text.trim();

  if (trimmed.length === 0) return false;
  if (trimmed.length > maxChars) return false;

  // Komendy obsluguje `bot.command`; tu trafic nie powinny, ale gdyby
  // kiedys kolejnosc rejestracji sie zmienila (10a), niech nie ida do modelu.
  if (trimmed.startsWith('/')) return false;

  return HAS_DIGIT.test(trimmed);
}
