/**
 * Wymiary obrazu z jego wlasnych bajtow — bez zadnej biblioteki.
 *
 * PO CO TO ISTNIEJE. Przy pierwszym uzyciu oceny oferty z aplikacji dwa zrzuty
 * na piec nie oddaly kilometrow. Podejrzenie padlo na to, ze obraz przychodzi
 * szerszy niz ekran telefonu (czarny pas z prawej), przez co drobne cyfry
 * `3,52 km` traca rozdzielczosc, gdy model skaluje obrazek do swojej siatki.
 *
 * Podejrzenie — nie ustalenie. Pliki, ktore da sie obejrzec w czacie, zdazyly
 * przejsc przez cudze przetwarzanie, wiec ich wymiary niczego nie dowodza.
 * Jedyny wiarygodny pomiar to ten zrobiony na serwerze, na bajtach, ktore
 * naprawde przyszly z telefonu. Stad ta funkcja: log przy kazdej ocenie mowi,
 * co dostal model, a nastepna nieudana proba jest do sprawdzenia jednym
 * `docker compose logs bot`, a nie kolejna runda zgadywania.
 *
 * Czysty modul, bez bazy i bez sieci — te sama zasada, co przy
 * `idempotency.rules.ts` i `finance.calc.ts`.
 */

export interface WymiaryObrazu {
  szerokosc: number;
  wysokosc: number;
  format: 'jpeg' | 'png';
}

/** PNG: sygnatura 8 bajtow, potem naglowek IHDR z szerokoscia i wysokoscia. */
function png(buf: Buffer): WymiaryObrazu | null {
  if (buf.length < 24) return null;
  const sygnatura = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sygnatura.length; i++) {
    if (buf[i] !== sygnatura[i]) return null;
  }
  // 8 sygnatura + 4 dlugosc + 4 'IHDR' = 16, potem 4 bajty szerokosci i 4 wysokosci.
  return { szerokosc: buf.readUInt32BE(16), wysokosc: buf.readUInt32BE(20), format: 'png' };
}

/**
 * JPEG: przechodzimy po znacznikach az do SOF (Start Of Frame).
 *
 * Wymiary NIE stoja w stalym miejscu — przed nimi moze byc EXIF, profil koloru
 * albo miniatura, kazde o innej dlugosci. Dlatego skaczemy po dlugosciach
 * segmentow zamiast liczyc offsety.
 *
 * `C4`, `C8` i `CC` wygladaja jak SOF, ale nimi nie sa (tablice Huffmana
 * i rozszerzenia arytmetyczne) — stad wykluczenie.
 */
function jpeg(buf: Buffer): WymiaryObrazu | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;

  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }

    const znacznik = buf[i + 1]!;

    // Wypelniacze i znaczniki bez ladunku — idziemy dalej.
    if (znacznik === 0xff || znacznik === 0x01 || (znacznik >= 0xd0 && znacznik <= 0xd9)) {
      i += 2;
      continue;
    }

    const dlugosc = buf.readUInt16BE(i + 2);
    const czySof =
      znacznik >= 0xc0 && znacznik <= 0xcf && znacznik !== 0xc4 && znacznik !== 0xc8 && znacznik !== 0xcc;

    if (czySof) {
      // i+4 to precyzja, potem 2 bajty wysokosci i 2 szerokosci — w tej kolejnosci.
      return { wysokosc: buf.readUInt16BE(i + 5), szerokosc: buf.readUInt16BE(i + 7), format: 'jpeg' };
    }

    if (dlugosc < 2) return null;
    i += 2 + dlugosc;
  }

  return null;
}

/** `null`, gdy to nie jest JPEG ani PNG albo naglowek jest uciety. */
export function wymiaryObrazu(buf: Buffer): WymiaryObrazu | null {
  return png(buf) ?? jpeg(buf);
}

/**
 * Kilometry z ekranu oferty: ZERO znaczy „nie odczytalem", nie „zero km".
 *
 * Zaobserwowane 19.08 na dwoch ofertach z piatki: model pytany o liczbe,
 * ktorej nie potrafi odczytac, zwracal `appPickupKm: 0` zamiast `null` — mimo
 * ze schemat odpowiedzi dopuszcza `null`. W bazie ladowalo `0.00`, czyli
 * „zero kilometrow do punktu odbioru".
 *
 * Taka wartosc jest gorsza od braku. Brak widac i mozna go obsluzyc; zero
 * wyglada na pomiar. To ta sama zasada co przy `isSpecificAddress()` (8f):
 * lepiej nie podac nic niz podac liczbe, ktora wyglada wiarygodnie i nie
 * znaczy nic.
 *
 * Odcinek o dlugosci dokladnie 0,00 km nie istnieje na ekranie oferty —
 * gdyby kurier stal w drzwiach restauracji, Glovo pokazaloby `0,01 km`
 * albo metry. Zerowanie nie odbiera wiec zadnej prawdziwej wartosci.
 */
export function kilometrLubNull(v: number | null): number | null {
  if (v === null || !Number.isFinite(v) || v <= 0) return null;
  return v;
}
