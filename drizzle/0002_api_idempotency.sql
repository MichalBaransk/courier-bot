-- Krok 5: pamiec idempotencji dla POST /api/v1/*
--
-- Migracja BEZPIECZNA: tworzy nowa tabele, nie dotyka zadnej istniejacej,
-- nie przenosi ani nie kasuje danych. `drizzle-kit push` tez by sobie
-- poradzil i NIE zapyta „created or renamed?" (9c), bo nic nie znika.
-- Ten plik jest tu po to, zeby dalo sie ja wykonac wprost, bez trybu
-- interaktywnego — na serwerze z prawdziwymi danymi to bezpieczniejsza droga.
--
-- Uruchomienie na serwerze:
--   docker compose exec -T postgres psql -U postgres -d courierdb < drizzle/0002_api_idempotency.sql

CREATE TABLE IF NOT EXISTS api_idempotency (
  key           text PRIMARY KEY,
  telegram_id   text NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  endpoint      text NOT NULL,
  -- 0 = zadanie w toku (wiersz zajety, jeszcze nierozstrzygniety).
  -- >0 = zapamietany kod odpowiedzi.
  status_code   integer NOT NULL,
  response_json text NOT NULL,
  created_at    timestamp NOT NULL DEFAULT now()
);

-- Wylacznie pod sprzatanie wierszy starszych niz 48 h.
CREATE INDEX IF NOT EXISTS api_idempotency_created_at_idx
  ON api_idempotency (created_at);
