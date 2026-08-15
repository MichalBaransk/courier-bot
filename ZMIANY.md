# GlovoBot — co się zmieniło

Przepisana wersja po przeglądzie kodu. Każda poprawka ma w kodzie komentarz `FIX (numer)` odsyłający do punktu z analizy, więc da się prześledzić po `grep -rn "FIX ("`.

---

## Nowa struktura

```
src/
  index.ts                     start bota, bot.catch, graceful shutdown
  config.ts                    CFG + lista dozwolonych telegram_id
  bot/
    index.ts                   rejestracja handlerów
    cards.ts                   renderowanie wiadomości (HTML)
    keyboards.ts               klawiatury (jedno źródło prawdy)
  services/
    finance.service.ts         operacje na bazie
    finance.calc.ts            NOWY — czysta arytmetyka rozliczeń, testowalna
    gemini.service.ts          Vision/audio + walidacja zod
    maps.service.ts            geokodowanie i dystanse
    user.service.ts            NOWY — upsert do tabeli users
  utils/
    datetime.ts                NOWY — cała logika dat w Europe/Warsaw
    format.ts                  NOWY — escapowanie HTML, formatowanie kwot
  db/
    schema.ts, index.ts
  scripts/import-sheets.ts
drizzle/0001_rework.sql        migracja danych
```

Testy: `src/utils/datetime.test.ts`, `src/services/finance.calc.test.ts` — `npm test`.

---

## Odpowiedzi na Twoje pytania

### 1.1 — dlaczego `"types": []` psuło build

W `tsconfig.json` opcja `types` mówi kompilatorowi, **które paczki typów globalnych automatycznie wczytać** z `node_modules/@types`. Domyślnie (bez tej opcji) TypeScript ładuje wszystkie, jakie znajdzie — w tym `@types/node`.

Ustawienie `"types": []` znaczy dosłownie „nie ładuj żadnych". Efekt: `process`, `Buffer`, `console`, `setInterval`, `fs`, `path` przestają istnieć z punktu widzenia kompilatora, mimo że `@types/node` siedzi w `devDependencies`. Ten sam problem dotyczył `lib` — bez `"lib": ["esnext"]` brakowało typów nowszych API JS.

To była linia z komentarzem `// For nodejs:` w wygenerowanym pliku startowym — instrukcja, żeby ją odkomentować, nigdy nie została wykonana. `npm run build` musiał sypać setkami błędów typu `Cannot find name 'process'`.

Teraz jest `"lib": ["esnext"]` i `"types": ["node"]`.

### 2.9 — o co chodziło z `calculateHours`

Stary kod:

```ts
let diffMinutes = tH * 60 + tM - (fH * 60 + fM);
if (diffMinutes < 0) diffMinutes += 24 * 60;
```

Ta linia jest potrzebna, bo zmiana `22:00 → 02:00` daje ujemną różnicę, a naprawdę trwała 4 h. Problem w tym, że kod nie odróżnia „przejścia przez północ" od **zwykłej pomyłki**.

Wpiszesz `10:00 → 09:00` (literówka, chodziło o `19:00`) — różnica to −60 minut, kod dodaje 24 h i zapisuje **23 godziny pracy**. Ta liczba wchodzi potem do:

- sumy godzin w `/tydzien` i `/miesiac`,
- stawki zł/h (nagle wychodzi 15 zł/h zamiast 45),
- prognozy w celach zarobkowych („zostało Ci 3 h dziennie" liczone złą stawką).

I nic nie sygnalizuje błędu. Drugi przypadek: `hours >= 0.25 ? hours : 0` — zmiana 10-minutowa zapisywała się po cichu jako 0 h, też bez słowa.

Teraz funkcja zwraca `{ hours, error }`. Przejście przez północ dalej działa, ale wynik powyżej 16 h albo poniżej 15 min zwraca `hours: null` plus komunikat, który bot dokleja do odpowiedzi: `⚠️ Zmiana 10:00-09:00 wychodzi 23.00 h (limit 16 h). Sprawdź godziny.`

### 2.4 — co to jest `walletCollections`

To była suma transakcji typu `pobranie` z danego dnia, czyli **gotówka pobrana od klientów przy dostawie**. Liczyło się to w `getDailySummary()` i… nigdzie nie było używane — ani w kartach, ani w raportach, ani w `doPrzelewu`. Martwa zmienna.

Zgodnie z Twoją decyzją (`pobranie` ma tylko aktualizować saldo) usunąłem ją z podsumowania dnia. Te transakcje dalej wpływają na saldo portfela, bo saldo to suma wszystkich kwot ze znakiem.

### 2.4 — „jak wypisać model rozliczenia na kartce"

Chodziło o to, żeby najpierw ustalić po ludzku, co jest czym, a dopiero potem pisać kod — bo w starej wersji `doPrzelewu` mieszało trzy różne intuicje w jednym wyrażeniu. Zrobiłem to za Ciebie i zapisałem w `finance.calc.ts`:

```
netEarnings   = brutto ze zleceń × 0.814      → trafi na konto
cashTips      = napiwki gotówkowe             → już w kieszeni
totalNetto    = netEarnings + cashTips        → ile kurier zarobił
walletPayouts = wyplata + wyplata_gotowka     → już wyszło z portfela
doPrzelewu    = netEarnings − walletPayouts   → co jeszcze przyjdzie
```

Trzy typy transakcji nie występują w tym rachunku w ogóle:

| typ | co robi |
|---|---|
| `pobranie` | tylko podnosi saldo portfela |
| `platnosc_punkt` | tylko obniża saldo portfela |
| `korekta` | tylko koryguje saldo portfela |

Zniknęło też `Math.max(0, ...)` — ujemne „do przelewu" jest teraz widoczne (test to pilnuje).

### 3.8 — czy była autoryzacja

Nie było żadnej. Każdy, kto znalazł nazwę bota, mógł wysłać `/dzis`, zdjęcie albo głosówkę — czyli czytać Twoje dane, zapisywać swoje i palić limit Gemini na Twoim kluczu. Handlery brały `ctx.from.id` i traktowały go jako właściciela danych.

Dodane: `ALLOWED_TELEGRAM_IDS` w `.env` (lista po przecinkach) i middleware, który odrzuca resztę z logiem. Pusta lista = bot otwarty, ale przy starcie leci ostrzeżenie w konsoli.

### 4.6 — te trzy funkcje

Mój punkt dotyczył **dopisania testów** do `calculateHours`, `getEffectiveDate`, `getWeekNumber` i `previewWalletImport` — to czyste funkcje, w których siedziała większość błędów. Usunięcie ich rozłożyłoby bota (nie ma jak wyznaczyć daty wpisu, klucza celu tygodniowego ani wykryć duplikatów).

Zgodnie z Twoim wyborem: funkcje zostają (poprawione i przeniesione do `utils/datetime.ts` oraz `services/finance.calc.ts`), a testy są dopisane — 8 grup asercji pokrywających dokładnie te przypadki, które wcześniej były błędne.

### 5.4 — dwie średnie stawki

`/statystyki` pokazuje teraz obie, bo mówią o czym innym:

```
📈 Średnia z ofert:  2.15 zł/km  — jakie oferty przychodzą
⚖️ Średnia ważona:   1.78 zł/km  — ile realnie wychodzi na km
```

Pierwsza to średnia arytmetyczna stawek (kurs 3 km waży tyle samo co 15 km). Druga to suma netto / suma km. Rozjazd między nimi mówi Ci, że krótkie kursy podbijają statystykę.

---

## Wykaz zmian

### Blokery

| # | Zmiana |
|---|---|
| 1.1 | `tsconfig.json`: `"lib": ["esnext"]`, `"types": ["node"]` |
| 1.2 | `import type` wszędzie, gdzie wymaga tego `verbatimModuleSyntax` (`Schema`, `Context`, `Telegraf`, typy z serwisów) |
| 1.3 | `import-sheets.ts`: `telegramId` jako string, dystans jako `numeric`, paliwo do nowej tabeli |

### Błędy logiczne

| # | Zmiana |
|---|---|
| 2.1 | Cała logika dat w `utils/datetime.ts`, strefa `Europe/Warsaw`. **Doba kończy się o północy — wpis o 01:00 należy do nowego dnia.** Zniknęło cofanie nocnych zmian i `adjustDateForNightShift()` |
| 2.2 | Tabela `balance_checkpoints` usunięta. Saldo = suma `wallet_transactions.amount`. Ręczny wpis zapisuje się jako transakcja `korekta` (Twój wybór), więc historia zostaje audytowalna |
| 2.3 | `course_offers`: kolumny `distance_pickup_km`, `distance_delivery_km`, `distance_total_km` + `distance_source`. `verifyOfferDistance()` liczy oba odcinki, stawka zawsze z całej trasy |
| 2.4 | `doPrzelewu` rozpisane wprost w `finance.calc.ts`, bez skracających się napiwków i bez `Math.max(0, ...)` |
| 2.5 | `external_id` i `time` `NOT NULL DEFAULT ''`, klucz dedupu identyczny z unikalnym indeksem, `.onConflictDoNothing()` przy insercie |
| 2.6 | `previewWalletImport()`: jedno zapytanie zamiast N, wykrywa też duplikaty wewnątrz jednego zrzutu |
| 2.7 | `fuel_distance` → `distance_km` (`numeric`). To **dystans przejechany danego dnia**, nie stan licznika — prompty Gemini i teksty przycisków mówią to wprost |
| 2.8 | Nowa tabela `fuel_receipts`. Wiele tankowań dziennie sumuje się zamiast nadpisywać |
| 2.9 | `calculateHours()` zwraca `{ hours, error }` z limitem 16 h |
| 2.10 | Cele tygodniowe kluczowane **rokiem ISO** (`isoWeek` zwraca `{ year, week }`) |

### Warstwa bota

| # | Zmiana |
|---|---|
| 3.1 | Komendy rejestrowane przed handlerem tekstowym + middleware czyszczący stan przy każdym `/`. Doszło `/anuluj`, przycisk „✖️ Anuluj" i TTL 5 min |
| 3.2 | TTL na wszystkich mapach stanu + sweeper co 60 s (dalej pamięć procesu — świadomy kompromis, opisany w komentarzu) |
| 3.3 | Cały bot na `parse_mode: 'HTML'`, każda wartość od użytkownika/modelu przez `h()` |
| 3.4 | `bot.catch()` + graceful shutdown zamykający pulę Postgresa |
| 3.5 | `bot.launch()` z własnym `.catch()`, komunikat startowy z `getMe()` (weryfikuje też token) |
| 3.6 | Karta oferty przerysowywana z danych z bazy zamiast doklejania linii statusu |
| 3.7 | `updateCourseOfferStatus()` zwraca zaktualizowany wiersz; brak trafienia = alert, nie fałszywe „ZAAKCEPTOWANO" |
| 3.8 | `ALLOWED_TELEGRAM_IDS` + middleware autoryzacji |
| 3.9 | Sprawdzanie `file_size` przed pobraniem, limit po pobraniu, timeout 30 s |
| 3.10 | Wszystkie odpowiedzi Gemini walidowane zod, jeden retry przy błędzie parsowania |

### Porządki

| # | Zmiana |
|---|---|
| 4.1 | `src/gemini.ts` usunięty |
| 4.2 | `users` zapisywane przy każdej interakcji + klucze obce z pozostałych tabel |
| 4.3 | `TOLERANCJA_KM` i `HISTORY_LEN` usunięte; `MAX_AUDIO_BYTES`/`MAX_PHOTO_BYTES` są teraz faktycznie używane |
| 4.4 | Podwójne eksporty `TAX_FACTOR` / `NETTO_FACTOR` / `MIN_STAWKA_NETTO_KM` usunięte |
| 4.5 | `walletCollections` usunięte |
| 4.6 | Testy dopisane, funkcje zostają |
| 4.7 | `.filter(Boolean)` → `compact()` z type guardem |
| 4.8 | Klawiatury w `bot/keyboards.ts` |
| 4.9 | Indeksy na `cash_tips`, `course_offers`, `fuel_receipts`, `wallet_transactions` |

### Dziedzinowe

| # | Zmiana |
|---|---|
| 5.1 | `NETTO_FACTOR` bez zmian (0.814) |
| 5.2 | Paliwo dalej nie pomniejsza „czystego netto" |
| 5.3 | `fuel_receipts` trzyma `total_cost` **i** `price_per_liter`; Gemini wyciąga oba z paragonu |
| 5.4 | `/statystyki` pokazuje średnią z ofert i średnią ważoną |
| 5.5 | Sentinel `999` zastąpiony przez `null` |
| 5.6 | `gemini-3.7-flash` w jednym miejscu (`CFG.GEMINI_MODEL`, nadpisywalne przez env) |

---

## Wdrożenie

```bash
npm install
cp .env.example .env        # uzupełnij BOT_TOKEN, DATABASE_URL, GEMINI_API_KEY, ALLOWED_TELEGRAM_IDS

pg_dump "$DATABASE_URL" > backup_$(date +%F).sql   # KONIECZNIE
psql "$DATABASE_URL" -f drizzle/0001_rework.sql

npm run typecheck
npm test
npm run dev
```

### Na co uważać przy migracji

1. **`fuel_distance` → `distance_km`.** Migracja przepisuje wartości 1:1. Jeżeli zapisywałeś tam **stany licznika**, a nie dystans dnia, te liczby są bezużyteczne — w SQL-u jest zakomentowana alternatywa (`SET distance_km = NULL`).

2. **Saldo portfela.** Migracja przelicza ostatni checkpoint na transakcję `korekta`, żeby wyświetlana kwota się nie zmieniła. Po wdrożeniu porównaj `/saldo` z aplikacją Glovo i w razie czego wyrównaj przez `/saldo <kwota>`.

3. **Duplikaty transakcji.** Migracja kasuje wiersze, które przeszły przez zepsuty indeks. Przed uruchomieniem możesz je policzyć:

```sql
SELECT telegram_id, date, time, type, amount, external_id, COUNT(*)
FROM wallet_transactions
GROUP BY 1,2,3,4,5,6 HAVING COUNT(*) > 1;
```

4. **Cele tygodniowe** z przełomu roku mogą siedzieć pod starym kluczem (rok kalendarzowy). Sprawdź `SELECT * FROM earning_targets WHERE period_type = 'WEEKLY'`.

---

## Czego nie ruszałem

- **Stan w pamięci procesu.** `awaitingInput`, `pendingWalletImports` i `lastCourierLocation` dalej giną przy restarcie. Dodałem TTL i sprzątanie, ale przy jednym użytkowniku przenoszenie tego do Postgresa to przerost formy. Gdyby botów miało być więcej — to pierwsza rzecz do zmiany.
- **Podatki.** `NETTO_FACTOR` to dalej płaskie 18,6% (Twoja decyzja 5.1).
- **Paliwo w rozliczeniu.** Koszt paliwa jest zbierany i raportowany, ale nie pomniejsza `grandTotalNetto` (Twoja decyzja 5.2). Warto do tego wrócić — dla kuriera na motocyklu to główny koszt, więc stawka zł/h jest dziś zawyżona.
- **Wersja `gemini-3.7-flash`** — wpisana zgodnie z tym, co podałeś, do zmiany przez `GEMINI_MODEL` w `.env` bez ruszania kodu.

---

## Weryfikacja

Nie miałem w tym środowisku dostępu do rejestru npm, więc `tsc` i `vitest` nie mogły się uruchomić. Zamiast tego:

- wszystkie pliki `.ts` przeszły sprawdzenie składni,
- czysta logika (`finance.calc.ts` i `datetime.ts`) została **uruchomiona z prawdziwych źródeł** i przeszła 8 grup asercji odpowiadających plikom testowym — daty i strefy czasowe, tygodnie ISO, rozliczenia, deduplikacja, stawki kursów, godziny pracy.

Po `npm install` u siebie odpal `npm run typecheck && npm test` — to domknie weryfikację warstwy typów, której tutaj nie dało się sprawdzić.
