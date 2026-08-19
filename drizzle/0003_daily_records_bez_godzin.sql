-- 0003 — kolumny godzinowe wychodza z daily_records
--
-- ZAPIS TEGO, CO ZOSTALO WYKONANE. Uruchamiamy przez `psql -c "..."`
-- w jednej linii, NIGDY przez `< plik.sql` (kompendium §5).
--
-- Idzie RAZEM z patchem P3, nie wczesniej. Dopoki `finance.service.ts`
-- czyta te kolumny, ich skasowanie zostawia dzialajacego bota z zapytaniami
-- do nieistniejacych kolumn, a `npm run typecheck` przestaje sie zgadzac
-- ze schematem Drizzle.
--
-- Kolumny sa PUSTE. Sprawdzone na serwerze 19.08.2026:
-- `SELECT count(*) FROM daily_records WHERE work_from IS NOT NULL` = 0.
-- Nie ma czego przenosic i nie ma czego stracic.
--
-- Wycofanie (gdyby trzeba bylo wrocic do poprzedniego obrazu bota):
--   ALTER TABLE daily_records
--     ADD COLUMN work_from text,
--     ADD COLUMN work_to text,
--     ADD COLUMN work_hours numeric(5,2);

ALTER TABLE daily_records
  DROP COLUMN IF EXISTS work_from,
  DROP COLUMN IF EXISTS work_to,
  DROP COLUMN IF EXISTS work_hours;
