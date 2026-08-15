import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { sql } from 'drizzle-orm';

/**
 * FIX (4.2): tabela `users` byla martwa. Teraz kazda interakcja z botem robi
 * upsert, dzieki czemu klucze obce z pozostalych tabel maja na czym stac.
 *
 * Bez cache'a w pamieci — swiadomie.
 * Pierwsza wersja pomijala zapis, jesli widziala tego uzytkownika w ciagu
 * ostatniej godziny. Wystarczylo jednak, ze wiersz zniknal z bazy przy zywym
 * procesie (reset schematu, przywracanie dumpa) i `ensureUser` po cichu nic
 * nie robil, a kazdy kolejny insert lecial na naruszeniu klucza obcego.
 * Jeden upsert na wiadomosc to przy tej skali koszt bez znaczenia.
 */

export interface TelegramUserInfo {
  id: number | string;
  username?: string | undefined;
  first_name?: string | undefined;
}

export async function ensureUser(from: TelegramUserInfo): Promise<void> {
  await db
    .insert(users)
    .values({
      telegramId: String(from.id),
      username: from.username ?? null,
      firstName: from.first_name ?? null,
    })
    .onConflictDoUpdate({
      target: users.telegramId,
      set: {
        username: from.username ?? null,
        firstName: from.first_name ?? null,
        lastSeenAt: sql`now()`,
      },
    });
}

/** Uzywane przez skrypty CLI, ktore pisza do bazy poza kontekstem bota. */
export async function ensureUserById(telegramId: string): Promise<void> {
  await db.insert(users).values({ telegramId }).onConflictDoNothing();
}
