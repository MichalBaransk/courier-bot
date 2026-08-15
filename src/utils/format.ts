/**
 * Formatowanie wiadomosci Telegrama.
 *
 * FIX (3.3): caly bot przechodzi z legacy `parse_mode: 'Markdown'` na `'HTML'`.
 * Powod: transkrypcje glosowe i adresy z OCR trafialy do szablonu bez zadnego
 * escapowania. Adres `ul. Sportowa 5_A` albo gwiazdka w transkrypcji wywalaly
 * cala wiadomosc bledem `400: can't parse entities`, a uzytkownik widzial
 * tylko "Blad analizy obrazu". W HTML escapowanie to trzy znaki i jest pewne.
 */

/** Escape tresci pochodzacej od uzytkownika / modelu. Uzywaj ZAWSZE. */
export function h(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const b = (value: unknown): string => `<b>${h(value)}</b>`;
export const i = (value: unknown): string => `<i>${h(value)}</i>`;
export const code = (value: unknown): string => `<code>${h(value)}</code>`;

/** Kwota w złotówkach, zawsze 2 miejsca po przecinku. */
export const zl = (n: number): string => `${n.toFixed(2)} zł`;
/** Kwota ze znakiem (`+12.00 zł` / `-8.50 zł`). */
export const zlSigned = (n: number): string => `${n > 0 ? '+' : ''}${n.toFixed(2)} zł`;

export const km = (n: number, digits = 1): string => `${n.toFixed(digits)} km`;

/**
 * FIX (4.7): `.filter(Boolean)` nie zawężał typu — tablica dalej była
 * `Array<string | false>` z punktu widzenia TypeScriptu.
 */
export function compact(lines: Array<string | false | null | undefined>): string[] {
  return lines.filter((line): line is string => typeof line === 'string' && line.length > 0);
}

/** Składa wiersze wiadomości, wyrzucając puste/warunkowe. */
export function joinLines(lines: Array<string | false | null | undefined>): string {
  return compact(lines).join('\n');
}

export function progressBar(percent: number, totalBlocks = 10): string {
  const filled = Math.min(totalBlocks, Math.max(0, Math.round((percent / 100) * totalBlocks)));
  return `[${'█'.repeat(filled)}${'░'.repeat(totalBlocks - filled)}]`;
}

export const SEPARATOR = '────────────────';
