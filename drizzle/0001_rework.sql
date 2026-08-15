-- =============================================================================
-- Migracja 0001: przebudowa schematu po przeglądzie kodu
--
-- Zmiany danych, których `drizzle-kit push` nie zrobi za Ciebie:
--   • daily_records.fuel_price / fuel_liters  -> tabela fuel_receipts
--   • daily_records.fuel_distance (integer)   -> distance_km (numeric, dystans dnia)
--   • course_offers.total_distance            -> distance_total_km + rozbicie na odcinki
--   • wallet_transactions.external_id NULL    -> '' (NULL psuł unikalny indeks)
--   • balance_checkpoints                     -> ostatni checkpoint jako 'korekta'
--
-- ZRÓB KOPIĘ BAZY PRZED URUCHOMIENIEM:
--   pg_dump "$DATABASE_URL" > backup_$(date +%F).sql
-- =============================================================================

BEGIN;

-- --- 1. users: uzupełnienie i backfill ---------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name   text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamp NOT NULL DEFAULT now();

-- Tabela była pusta mimo danych w pozostałych tabelach (4.2).
INSERT INTO users (telegram_id)
SELECT DISTINCT telegram_id FROM daily_records
UNION SELECT DISTINCT telegram_id FROM cash_tips
UNION SELECT DISTINCT telegram_id FROM wallet_transactions
UNION SELECT DISTINCT telegram_id FROM course_offers
UNION SELECT DISTINCT telegram_id FROM earning_targets
ON CONFLICT (telegram_id) DO NOTHING;

-- --- 2. fuel_receipts: osobna tabela na paragony (2.8, 5.3) ------------------

CREATE TABLE IF NOT EXISTS fuel_receipts (
  id              serial PRIMARY KEY,
  telegram_id     text NOT NULL,
  date            date NOT NULL,
  total_cost      numeric(10, 2) NOT NULL,
  liters          numeric(10, 2),
  price_per_liter numeric(10, 3),
  created_at      timestamp NOT NULL DEFAULT now()
);

-- Przeniesienie istniejących danych. `fuel_price` mimo nazwy trzymało
-- kwotę CAŁEGO paragonu, więc idzie do total_cost.
INSERT INTO fuel_receipts (telegram_id, date, total_cost, liters, price_per_liter, created_at)
SELECT
  telegram_id,
  date,
  fuel_price,
  fuel_liters,
  CASE WHEN fuel_liters > 0 THEN ROUND(fuel_price / fuel_liters, 3) END,
  created_at
FROM daily_records
WHERE fuel_price IS NOT NULL AND fuel_price > 0;

CREATE INDEX IF NOT EXISTS fuel_receipts_user_date_idx ON fuel_receipts (telegram_id, date);

-- --- 3. daily_records: dystans dnia zamiast stanu licznika (2.7) -------------

ALTER TABLE daily_records ADD COLUMN IF NOT EXISTS distance_km numeric(10, 2);

-- UWAGA: jeżeli w fuel_distance zapisywałeś STANY LICZNIKA, a nie dystans dnia,
-- ten UPDATE przepisze bezsensowne wartości. Wtedy zamiast niego uruchom:
--   UPDATE daily_records SET distance_km = NULL;
-- i wpisz dystanse od nowa.
UPDATE daily_records SET distance_km = fuel_distance WHERE fuel_distance IS NOT NULL;

ALTER TABLE daily_records DROP COLUMN IF EXISTS fuel_distance;
ALTER TABLE daily_records DROP COLUMN IF EXISTS fuel_price;
ALTER TABLE daily_records DROP COLUMN IF EXISTS fuel_liters;

-- --- 4. wallet_transactions: naprawa deduplikacji (2.5) ----------------------

UPDATE wallet_transactions SET external_id = '' WHERE external_id IS NULL;
UPDATE wallet_transactions SET time = ''        WHERE time IS NULL;

-- Usunięcie duplikatów, które przeszły przez zepsuty indeks (NULL != NULL).
DELETE FROM wallet_transactions a
USING wallet_transactions b
WHERE a.id > b.id
  AND a.telegram_id = b.telegram_id
  AND a.date        = b.date
  AND a.time        = b.time
  AND a.type        = b.type
  AND a.amount      = b.amount
  AND a.external_id = b.external_id;

ALTER TABLE wallet_transactions ALTER COLUMN external_id SET DEFAULT '';
ALTER TABLE wallet_transactions ALTER COLUMN external_id SET NOT NULL;
ALTER TABLE wallet_transactions ALTER COLUMN time        SET DEFAULT '';
ALTER TABLE wallet_transactions ALTER COLUMN time        SET NOT NULL;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'OCR';

DROP INDEX IF EXISTS wallet_tx_dedup_idx;
CREATE UNIQUE INDEX wallet_tx_dedup_idx
  ON wallet_transactions (telegram_id, date, time, type, amount, external_id);
CREATE INDEX IF NOT EXISTS wallet_tx_user_date_idx ON wallet_transactions (telegram_id, date);

-- --- 5. balance_checkpoints -> korekta (2.2) ---------------------------------
-- Saldo liczymy teraz wyłącznie jako sumę transakcji. Żeby wyświetlana kwota
-- się nie zmieniła, zapisujemy różnicę jako transakcję typu 'korekta'.

INSERT INTO wallet_transactions (telegram_id, date, time, type, amount, external_id, source)
SELECT
  c.telegram_id,
  c.date,
  '00:00',
  'korekta',
  ROUND(
    c.balance_value
      + COALESCE((
          SELECT SUM(w.amount) FROM wallet_transactions w
          WHERE w.telegram_id = c.telegram_id AND w.date >= c.date
        ), 0)
      - COALESCE((
          SELECT SUM(w.amount) FROM wallet_transactions w
          WHERE w.telegram_id = c.telegram_id
        ), 0),
    2
  ),
  'migracja-checkpoint',
  'MANUAL'
FROM balance_checkpoints c
WHERE c.date = (
  SELECT MAX(c2.date) FROM balance_checkpoints c2 WHERE c2.telegram_id = c.telegram_id
)
ON CONFLICT DO NOTHING;

-- Wiersze o zerowej korekcie nie wnoszą nic poza szumem.
DELETE FROM wallet_transactions WHERE external_id = 'migracja-checkpoint' AND amount = 0;

DROP TABLE IF EXISTS balance_checkpoints;

-- --- 6. course_offers: rozbicie dystansu (2.3) -------------------------------

ALTER TABLE course_offers ADD COLUMN IF NOT EXISTS distance_pickup_km   numeric(10, 2);
ALTER TABLE course_offers ADD COLUMN IF NOT EXISTS distance_delivery_km numeric(10, 2);
ALTER TABLE course_offers ADD COLUMN IF NOT EXISTS distance_total_km    numeric(10, 2);
ALTER TABLE course_offers ADD COLUMN IF NOT EXISTS distance_source      text NOT NULL DEFAULT 'APP';
ALTER TABLE course_offers ADD COLUMN IF NOT EXISTS pickup_address       text;
ALTER TABLE course_offers ADD COLUMN IF NOT EXISTS delivery_address     text;

UPDATE course_offers SET distance_total_km = total_distance WHERE distance_total_km IS NULL;
UPDATE course_offers SET distance_total_km = 0 WHERE distance_total_km IS NULL;
ALTER TABLE course_offers ALTER COLUMN distance_total_km SET NOT NULL;

-- Adresy leżały w JSON-ie w kolumnie tekstowej.
UPDATE course_offers
SET pickup_address   = COALESCE(pickup_address,   points_json::json ->> 'pickup'),
    delivery_address = COALESCE(delivery_address, points_json::json ->> 'delivery')
WHERE points_json IS NOT NULL AND points_json <> '';

ALTER TABLE course_offers DROP COLUMN IF EXISTS total_distance;
ALTER TABLE course_offers DROP COLUMN IF EXISTS points_json;
ALTER TABLE course_offers DROP COLUMN IF EXISTS verification_text;

CREATE INDEX IF NOT EXISTS course_offers_user_date_idx ON course_offers (telegram_id, date);

-- --- 7. cash_tips: brakujący indeks (4.9) ------------------------------------

CREATE INDEX IF NOT EXISTS cash_tips_user_date_idx ON cash_tips (telegram_id, date);

-- --- 8. Klucze obce do users (4.2) -------------------------------------------

ALTER TABLE daily_records       ADD CONSTRAINT daily_records_user_fk
  FOREIGN KEY (telegram_id) REFERENCES users (telegram_id) ON DELETE CASCADE;
ALTER TABLE cash_tips           ADD CONSTRAINT cash_tips_user_fk
  FOREIGN KEY (telegram_id) REFERENCES users (telegram_id) ON DELETE CASCADE;
ALTER TABLE fuel_receipts       ADD CONSTRAINT fuel_receipts_user_fk
  FOREIGN KEY (telegram_id) REFERENCES users (telegram_id) ON DELETE CASCADE;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_user_fk
  FOREIGN KEY (telegram_id) REFERENCES users (telegram_id) ON DELETE CASCADE;
ALTER TABLE course_offers       ADD CONSTRAINT course_offers_user_fk
  FOREIGN KEY (telegram_id) REFERENCES users (telegram_id) ON DELETE CASCADE;
ALTER TABLE earning_targets     ADD CONSTRAINT earning_targets_user_fk
  FOREIGN KEY (telegram_id) REFERENCES users (telegram_id) ON DELETE CASCADE;

COMMIT;

-- =============================================================================
-- PO MIGRACJI: cele tygodniowe są teraz kluczowane ROKIEM ISO (2.10).
-- Jeżeli masz zapisane cele tygodniowe z przełomu roku, sprawdź je ręcznie:
--   SELECT * FROM earning_targets WHERE period_type = 'WEEKLY' ORDER BY year, period_value;
-- =============================================================================
