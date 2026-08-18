-- Predkosc w chwili odczytu pozycji.
--
-- DLACZEGO OSOBNA MIGRACJA, A NIE POPRAWKA 0003: 0003 mogl juz pojsc na
-- produkcje. Migracja, ktora zmienia sie po wykonaniu, jest gorsza niz dwie
-- migracje po kolei.
--
-- DLACZEGO TA KOLUMNA W OGOLE: pierwsza wersja mierzyla swiezosc pozycji
-- w sekundach („wazna 60 s"). Przy 100 km/h to 1,7 km bledu — a reguła
-- w sekundach nic o predkosci nie wie. Od tej kolumny zalezy, czy pozycja
-- jest jeszcze cokolwiek warta:
--
--   blad = niepewnosc odczytu + predkosc x wiek
--
-- URUCHOMIENIE (po 0003, ktore tworzy tabele):
--
--   cd /share/courier-bot
--   docker exec -i courier-db psql -U postgres -d courierdb < drizzle/0004_courier_locations_speed.sql
--
-- Bezpieczna: tylko dodaje kolumne dopuszczajaca NULL, niczego nie przepisuje.
-- Istniejace wiersze dostana `NULL`, co warstwa regul czyta jako „nie wiem"
-- i podstawia zalozenie ostrozne, a nie zerowa predkosc.

ALTER TABLE "courier_locations"
  ADD COLUMN IF NOT EXISTS "speed_mps" numeric(6, 2);
