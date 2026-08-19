-- 0002 — tabela work_sessions (wiele zmian w ciagu doby)
--
-- TEN PLIK JEST ZAPISEM TEGO, CO ZOSTALO WYKONANE — nie skryptem do
-- przekierowania. Migracje uruchamiamy przez `psql -c "..."` w jednej linii,
-- NIGDY przez `< plik.sql` (kompendium §5). Dwa powody, oba z wlasnej skory:
-- wklejona komenda z `<` lamie sie na przekierowaniu i zsh zglasza
-- `parse error near '\n'`, a sam plik trafia na serwer dopiero z patchem,
-- wiec „najpierw migracja, potem patch" jest wewnetrznie sprzeczne.
--
-- Powod, dla ktorego to nie idzie przez `drizzle-kit push`: indeks CZESCIOWY
-- (`WHERE work_to IS NULL`) bywa przez push pomijany bez slowa, a cala ochrona
-- przed dwiema rownoleglymi otwartymi zmianami stoi wlasnie na nim.
--
-- Ten plik NIE przenosi zadnych danych. Sprawdzone na serwerze 19.08.2026:
-- `SELECT count(*) FROM daily_records WHERE work_from IS NOT NULL` = 0,
-- zero wierszy ze zjazdem bez wyjazdu, zero z wyjazdem bez zjazdu.
-- Kolumny godzinowe w `daily_records` sa puste w calej tabeli.
--
-- Kolumny `work_from`, `work_to` i `work_hours` z `daily_records` kasuje
-- dopiero migracja 0003, razem z patchem P3 — dopoki `finance.service.ts`
-- z nich czyta, ich usuniecie wywala `npm run typecheck`.

-- Bez BEGIN/COMMIT celowo: `psql -c` z kilkoma poleceniami wykonuje je
-- w JEDNEJ niejawnej transakcji. Sprawdzone — blad w ostatnim poleceniu cofa
-- utworzenie tabeli i indeksow z poprzednich.

CREATE TABLE IF NOT EXISTS work_sessions (
  id serial PRIMARY KEY,
  telegram_id text NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  date date NOT NULL,
  work_from text NOT NULL,
  work_to text,
  source text NOT NULL DEFAULT 'BOT',
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS work_sessions_user_date_idx
  ON work_sessions (telegram_id, date);

CREATE UNIQUE INDEX IF NOT EXISTS work_sessions_otwarta_idx
  ON work_sessions (telegram_id) WHERE work_to IS NULL;
