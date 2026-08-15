import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { sql } from 'drizzle-orm';

/**
 * FIX (4.2): tabela `users` byla martwa. Teraz kazda interakcja z botem robi
 * upsert, dzieki czemu klucze obce z pozostalych tabel maja na czym stac.
 * Cache w pamieci ogranicza zapis do jednego na uzytkownika na godzine.
 */
const RECENTLY_TOUCHED_MS = 60 * 60 * 1000;
const touchedAt = new Map<string, number>();

export interface TelegramUserInfo {
  id: number | string;
  username?: string | undefined;
  first_name?: string | undefined;
}

export async function ensureUser(from: TelegramUserInfo): Promise<void> {
  const telegramId = String(from.id);
  const last = touchedAt.get(telegramId);
  if (last && Date.now() - last < RECENTLY_TOUCHED_MS) return;

  await db
    .insert(users)
    .values({
      telegramId,
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

  touchedAt.set(telegramId, Date.now());
}

/** Uzywane przez skrypty CLI, ktore pisza do bazy poza kontekstem bota. */
export async function ensureUserById(telegramId: string): Promise<void> {
  await db.insert(users).values({ telegramId }).onConflictDoNothing();
}
