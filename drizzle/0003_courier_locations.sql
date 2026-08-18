-- Ostatnia znana pozycja kuriera. Jeden wiersz na uzytkownika.
--
-- Migracja BEZPIECZNA: sama dodaje tabele, niczego nie rusza i nie kasuje.
-- Da sie uruchomic na dzialajacej bazie, przy chodzacym bocie.
--
-- Uruchomienie na serwerze (§5 kompendium — ZAWSZE przez `-c`, nigdy `< plik`):
--
--   cd /share/courier-bot
--   docker compose exec -T postgres psql -U postgres -d courierdb -c "$(cat drizzle/0003_courier_locations.sql)"
--
-- Albo, jesli `docker compose` znowu znikl po restarcie dodatku SSH:
--
--   docker exec -i courier-db psql -U postgres -d courierdb < drizzle/0003_courier_locations.sql
--
-- `drizzle-kit push` tez by to zrobil, ale przy realnych danych wolimy jawny
-- SQL — push potrafi zapytac „created or renamed?" i przy zlej odpowiedzi
-- podpiac stare dane pod nowa nazwe (§9c).

CREATE TABLE IF NOT EXISTS "courier_locations" (
  "telegram_id" text PRIMARY KEY NOT NULL,
  "latitude"    numeric(9, 6) NOT NULL,
  "longitude"   numeric(9, 6) NOT NULL,
  "accuracy_m"  integer,
  "source"      text NOT NULL DEFAULT 'APP',
  "recorded_at" timestamp NOT NULL,
  "updated_at"  timestamp NOT NULL DEFAULT now()
);

-- Klucz obcy dokladany osobno i warunkowo: `ADD CONSTRAINT` nie ma wariantu
-- `IF NOT EXISTS`, wiec powtorne uruchomienie migracji wywalilo by sie bledem.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'courier_locations_telegram_id_users_telegram_id_fk'
  ) THEN
    ALTER TABLE "courier_locations"
      ADD CONSTRAINT "courier_locations_telegram_id_users_telegram_id_fk"
      FOREIGN KEY ("telegram_id") REFERENCES "users"("telegram_id") ON DELETE CASCADE;
  END IF;
END $$;
