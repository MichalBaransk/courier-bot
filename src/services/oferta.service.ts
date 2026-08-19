import { geminiService } from './gemini.service.js';
import { verifyOfferDistance } from './maps.service.js';
import { financeService } from './finance.service.js';
import { lokalizacjaService } from './lokalizacja.service.js';
import { computeOfferRate } from './finance.calc.js';
import { kilometrLubNull, wymiaryObrazu } from './obraz.rules.js';

/**
 * Ocena oferty kursu — JEDNA sciezka dla bota i dla aplikacji.
 *
 * DLACZEGO TO ISTNIEJE. Caly ten przebieg siedzial w handlerze zdjec
 * (`bot/index.ts`) jako osiemdziesiat linii w srodku `bot.on('photo')`.
 * Dopoki jedynym wejsciem byl Telegram, nie przeszkadzalo to nikomu.
 * Aplikacja mobilna jest drugim wejsciem — i albo mialaby wlasna kopie tych
 * regul, albo wolaja obie to samo. Kopia oznaczalaby, ze `MIN_STAWKA_NETTO_KM`
 * albo zasada „dystans z aplikacji, nie z Maps" (2.3) moga sie kiedys rozejsc
 * miedzy Telegramem a telefonem, a taki rozjazd nie daje o sobie znac inaczej
 * niz dwiema roznymi decyzjami dla tego samego kursu.
 *
 * Kolejnosc krokow ma znaczenie i nie jest przypadkowa:
 *
 * 1. Gemini czyta ekran oferty (kwota, adresy, kilometry z aplikacji Glovo).
 * 2. Google Maps liczy dojazd — WYLACZNIE jako kontrola, patrz nizej.
 * 3. Stawka liczy sie z dystansu APLIKACJI, gdy tylko jest.
 * 4. Oferta laduje w bazie ze statusem `PENDING`; decyzja przychodzi osobno.
 */

/** Pozycja kuriera w chwili oceny. `ts` to znacznik czasu odczytu. */
export interface PozycjaDoOceny {
  lat: number;
  lng: number;
  ts: number;
}

export interface WynikOceny {
  /** Numer wiersza w `course_offers` — potrzebny do zapisania decyzji. */
  offerId: number;
  isProfitable: boolean;
  grossAmount: number;
  netAmount: number;
  pickupAddress: string;
  deliveryAddress: string;
  appPickupKm: number | null;
  appDeliveryKm: number | null;
  appTotalKm: number | null;
  mapsPickupKm: number | null;
  mapsDeliveryKm: number | null;
  mapsTotalKm: number | null;
  mapsReason: string | null;
  mapsDeliveryReason: string | null;
  mapsAgeMin: number;
  totalKm: number;
  rateBasis: 'APP' | 'MAPS' | 'NONE';
  netRatePerKm: number;
  status: 'PENDING';
}

/**
 * Pozycja do kontroli dojazdu.
 *
 * Kolejnosc zrodel jest istotna. Aplikacja mobilna pobiera pozycje W CHWILI
 * oceny (`biezacaPozycja()`), wiec ma wiek 1–3 sekund — i wtedy budzet bledu
 * z 8j praktycznie przestaje cokolwiek znaczyc. Zapisana pozycja z
 * `courier_locations` jest zapasem: lepsza niz nic, ale to ona odpowiada za
 * przypadek z 2.3, gdzie Maps liczyl dojazd od ostatniego wyslanego GPS-a
 * i wyszlo 7,56 km zamiast 3,37.
 */
async function ustalPozycje(
  telegramId: string | number,
  podana: PozycjaDoOceny | null
): Promise<PozycjaDoOceny | null> {
  if (podana) return podana;

  const zapisana = await lokalizacjaService.swieza(telegramId);
  if (!zapisana) return null;

  return { lat: zapisana.lat, lng: zapisana.lon, ts: zapisana.zapisanoMs };
}

export async function ocenOferte(
  telegramId: string | number,
  obraz: Buffer,
  pozycja: PozycjaDoOceny | null,
  mimeType = 'image/jpeg'
): Promise<WynikOceny> {
  const tId = String(telegramId);

  const surowe = await geminiService.analyzeCourseOffer(obraz, mimeType);

  /**
   * ZERO od modelu znaczy „nie odczytalem" — patrz `kilometrLubNull`.
   * Bez tego do bazy trafia `0.00`, czyli „zero kilometrow do punktu odbioru",
   * i nikt pozniej nie odrozni tego od prawdziwego pomiaru.
   */
  const offer = {
    ...surowe,
    appPickupKm: kilometrLubNull(surowe.appPickupKm),
    appDeliveryKm: kilometrLubNull(surowe.appDeliveryKm),
  };

  /**
   * Log diagnostyczny — jedna linia na ocene.
   *
   * Wymiary sa tu NIE dla ozdoby. Podejrzenie z 19.08 brzmi: zrzut szerszy niz
   * ekran (czarny pas z prawej) odbiera drobnym cyfrom rozdzielczosc, gdy model
   * skaluje obraz. Zeby to sprawdzic albo obalic, trzeba znac wymiary TEGO
   * obrazu, ktory naprawde przyszedl — nie pliku ogladanego gdzie indziej.
   *
   * Bez tego logu kazda nieudana ocena konczy sie zgadywaniem.
   */
  const wym = wymiaryObrazu(obraz);
  console.log(
    `[Oferta] ${wym ? `${wym.szerokosc}x${wym.wysokosc} ${wym.format}` : 'nieznany format'}, ` +
      `${Math.round(obraz.length / 1024)} kB, brutto=${surowe.grossAmount}, ` +
      `km=${surowe.appPickupKm ?? 'null'}/${surowe.appDeliveryKm ?? 'null'}` +
      `${offer.appPickupKm !== surowe.appPickupKm || offer.appDeliveryKm !== surowe.appDeliveryKm ? ' (zero -> null)' : ''}, ` +
      `odbior="${surowe.pickupAddress}"`
  );

  const userLoc = await ustalPozycje(tId, pozycja);

  const route = await verifyOfferDistance(userLoc, offer.pickupAddress, offer.deliveryAddress);

  // Suma z aplikacji: oba odcinki widoczne na ekranie oferty.
  const appTotalKm =
    offer.appPickupKm != null && offer.appDeliveryKm != null
      ? Math.round((offer.appPickupKm + offer.appDeliveryKm) * 100) / 100
      : null;

  /**
   * Podstawa stawki: dystans z APLIKACJI, nie z Google Maps (2.3).
   *
   * Glovo liczy oba odcinki od biezacej pozycji kuriera i zna prawdziwy adres
   * klienta. Maps liczy od ostatniej ZNANEJ pozycji, a odcinka do klienta
   * w ogole nie policzy, bo oferta go nie ujawnia przed przyjeciem.
   */
  const rateBasis: 'APP' | 'MAPS' | 'NONE' =
    appTotalKm != null && appTotalKm > 0
      ? 'APP'
      : route.totalKm != null && route.totalKm > 0
        ? 'MAPS'
        : 'NONE';

  const totalKm = rateBasis === 'APP' ? appTotalKm! : rateBasis === 'MAPS' ? route.totalKm! : 0;

  const { netAmount, netRatePerKm, isProfitable } = computeOfferRate({
    grossAmount: offer.grossAmount,
    totalKm,
  });

  const offerId = await financeService.saveCourseOffer(tId, {
    grossAmount: offer.grossAmount,
    netAmount,
    appPickupKm: offer.appPickupKm,
    appDeliveryKm: offer.appDeliveryKm,
    appTotalKm,
    mapsPickupKm: route.pickupKm,
    mapsDeliveryKm: route.deliveryKm,
    mapsTotalKm: route.totalKm,
    distanceTotalKm: totalKm,
    rateBasis,
    netRatePerKm,
    isProfitable,
    pickupAddress: offer.pickupAddress,
    deliveryAddress: offer.deliveryAddress,
  });

  return {
    offerId,
    isProfitable,
    grossAmount: offer.grossAmount,
    netAmount,
    pickupAddress: offer.pickupAddress,
    deliveryAddress: offer.deliveryAddress,
    appPickupKm: offer.appPickupKm,
    appDeliveryKm: offer.appDeliveryKm,
    appTotalKm,
    mapsPickupKm: route.pickupKm,
    mapsDeliveryKm: route.deliveryKm,
    mapsTotalKm: route.totalKm,
    mapsReason: route.reason,
    mapsDeliveryReason: route.deliveryReason,
    mapsAgeMin: route.ageMin,
    totalKm,
    rateBasis,
    netRatePerKm,
    status: 'PENDING',
  };
}
