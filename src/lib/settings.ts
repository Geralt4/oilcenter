/*
 * Shop settings: types, defaults and pure helpers. SAFE TO IMPORT FROM CLIENT COMPONENTS —
 * nothing in here touches the database. Loading / saving lives in settings.server.ts.
 *
 * Everything the shop owner may want to change without a developer is editable from
 * /admin/settings. Values are stored as JSON, one row per top-level group, and merged over
 * DEFAULT_SETTINGS so new fields added in code always have a value.
 */

export type DayHours = {
  /** 1 = Monday … 7 = Sunday (ISO) */
  day: number;
  closed: boolean;
  open: string;
  close: string;
  /** optional second shift (split day: 08:30–14:00 & 17:30–20:30) */
  open2?: string;
  close2?: string;
};

export type BankAccount = { bank: string; iban: string; holder: string };

export type ShopSettings = {
  shop: {
    name: string;
    legalName: string;
    tagline: string;
    phone: string;
    mobile: string;
    fax: string;
    email: string;
    street: string;
    city: string;
    postalCode: string;
    region: string;
    lat: number;
    lng: number;
    instagramUrl: string;
    /** the shop's page on skroutz.gr (price-comparison site most Greek shoppers check first) */
    skroutzUrl: string;
    vatNumber: string;
    taxOffice: string;
    gemi: string;
    hours: DayHours[];
    /** true once the owner has confirmed the opening hours (seeded values are a guess) */
    hoursVerified: boolean;
    /** «Από το 19xx». 0 = not known yet: nothing is shown */
    foundedYear: number;
    /** the owner has confirmed the shop is accelerate's authorised dealer; until then the site does not say so */
    accelerateDealer: boolean;
  };
  storefront: {
    /** shows a site-wide "demo / indicative prices" ribbon and flags orders as test orders */
    demoMode: boolean;
    /** false = the public can browse and fill a cart but not check out (pre-launch). A logged-in admin can still place test orders. */
    ordersEnabled: boolean;
    /** while ordering is closed, offer "tell me when online orders open" (collects e-mail addresses) */
    launchSignup: boolean;
    announcement: string;
    lowStockThreshold: number;
    /** «Για συνεργεία & επαγγελματίες»: the page with the quote form, and the links to it. Off = the page does not exist (404). */
    b2bPage: boolean;
  };
  /**
   * What the shop's customers say elsewhere — typed in by the owner exactly as Google / Skroutz show it, never computed
   * or estimated here. 0 = not entered: nothing is shown. The Skroutz link itself is shop.skroutzUrl.
   */
  reviews: {
    googleUrl: string;
    googleRating: number;
    googleCount: number;
    skroutzRating: number;
    skroutzCount: number;
  };
  shipping: {
    courierEnabled: boolean;
    pickupEnabled: boolean;
    carrierName: string;
    deliveryEstimate: string;
    /** price for parcels up to baseWeightKg */
    baseCents: number;
    baseWeightKg: number;
    perExtraKgCents: number;
    /** 0 disables free shipping */
    freeOverCents: number;
    /** free shipping never applies above this weight (20 L drums are expensive to ship). 0 = no cap */
    freeMaxWeightKg: number;
    codFeeCents: number;
  };
  payments: {
    cod: boolean;
    bankTransfer: boolean;
    payInStore: boolean;
    card: boolean;
    bankAccounts: BankAccount[];
  };
  tax: {
    vatRate: number;
  };
  /** the product feed skroutz.gr reads (/feeds/skroutz.xml) */
  skroutz: {
    /** false = the feed address answers 404 to everyone except a logged-in admin */
    feedEnabled: boolean;
    /** one of the first two SKROUTZ_AVAILABILITY phrases: what is declared for a size that is on the shelf (lib/availability.ts covers the rest) */
    availability: string;
    /** units declared for sizes whose stock is not counted (Skroutz requires a number) */
    defaultQuantity: number;
  };
};

/** The fixed availability phrases Skroutz recognises in a feed (developer.skroutz.gr → XML Feed → Availability). */
export const SKROUTZ_AVAILABILITY = ['Άμεσα διαθέσιμο', 'Διαθέσιμο από 1 έως 3 ημέρες', 'Διαθέσιμο από 4 έως 6 ημέρες', 'Διαθέσιμο από 7 έως 12 ημέρες'] as const;

export const DEFAULT_SETTINGS: ShopSettings = {
  shop: {
    name: 'Oil Center',
    legalName: 'Τσακιρίδης Ηλίας',
    tagline: 'Λιπαντικά · Χημικά · Ανταλλακτικά',
    // the one landline the owner keeps (22.09.2026); the old fax, mobile and e-mail are gone — the new store Gmail is still to come
    phone: '2310 850778',
    mobile: '',
    fax: '',
    email: '',
    street: 'Σόλωνος 52',
    city: 'Θεσσαλονίκη',
    postalCode: '546 44',
    region: 'Θεσσαλονίκη',
    lat: 40.606737,
    lng: 22.957507,
    instagramUrl: '',
    skroutzUrl: 'https://www.skroutz.gr/shop/30368/Tsakiridis-Oil-Center/products.html',
    vatNumber: '054243156',
    taxOffice: 'Καλαμαριάς / ΚΕΦΟΔΕ',
    gemi: '58197804000',
    // confirmed by the owner on 22.09.2026: no midday break, no summer timetable
    hours: [
      { day: 1, closed: false, open: '08:30', close: '17:00' },
      { day: 2, closed: false, open: '08:30', close: '17:00' },
      { day: 3, closed: false, open: '08:30', close: '17:00' },
      { day: 4, closed: false, open: '08:30', close: '17:00' },
      { day: 5, closed: false, open: '08:30', close: '17:00' },
      { day: 6, closed: false, open: '09:00', close: '14:00' },
      { day: 7, closed: true, open: '', close: '' },
    ],
    hoursVerified: true,
    foundedYear: 0,
    accelerateDealer: false,
  },
  storefront: {
    demoMode: true,
    ordersEnabled: false,
    launchSignup: true,
    announcement: 'Δωρεάν μεταφορικά για αγορές άνω των 60 € · Παραλαβή από το κατάστημα χωρίς χρέωση',
    lowStockThreshold: 3,
    b2bPage: false,
  },
  reviews: {
    googleUrl: '',
    googleRating: 0,
    googleCount: 0,
    skroutzRating: 0,
    skroutzCount: 0,
  },
  shipping: {
    courierEnabled: true,
    pickupEnabled: true,
    carrierName: 'Courier',
    deliveryEstimate: '1–3 εργάσιμες',
    baseCents: 390,
    baseWeightKg: 2,
    perExtraKgCents: 90,
    freeOverCents: 6000,
    freeMaxWeightKg: 15,
    codFeeCents: 200,
  },
  payments: {
    cod: true,
    bankTransfer: true,
    payInStore: true,
    card: true,
    bankAccounts: [],
  },
  tax: {
    vatRate: 24,
  },
  skroutz: {
    feedEnabled: false,
    availability: 'Διαθέσιμο από 1 έως 3 ημέρες',
    defaultQuantity: 5,
  },
};

// ─── Derived helpers ─────────────────────────────────────────────────────────
export function fullAddress(s: ShopSettings['shop']): string {
  return `${s.street}, ${s.postalCode} ${s.city}`;
}

/** Opens the place in Google Maps (app on mobile, site on desktop). */
export function mapsPlaceUrl(s: ShopSettings['shop']): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${s.street}, ${s.city} ${s.postalCode}`)}`;
}

/** Starts turn-by-turn navigation to the shop from the visitor's current location. */
export function mapsDirectionsUrl(s: ShopSettings['shop']): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${s.street}, ${s.city} ${s.postalCode}`)}&travelmode=driving`;
}

/** Key-less Google Maps embed. */
export function mapsEmbedUrl(s: ShopSettings['shop']): string {
  const q = encodeURIComponent(`${s.street}, ${s.city} ${s.postalCode}`);
  return `https://www.google.com/maps?q=${q}&ll=${s.lat},${s.lng}&z=16&hl=el&output=embed`;
}

export const DAY_NAMES = ['Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο', 'Κυριακή'];
export const DAY_NAMES_SHORT = ['Δευ', 'Τρί', 'Τετ', 'Πέμ', 'Παρ', 'Σάβ', 'Κυρ'];

export function formatDayHours(d: DayHours): string {
  if (d.closed || !d.open || !d.close) return 'Κλειστά';
  const first = `${d.open} – ${d.close}`;
  return d.open2 && d.close2 ? `${first} & ${d.open2} – ${d.close2}` : first;
}

/** Collapses consecutive days with identical hours: "Δευτέρα – Παρασκευή  08:30 – 17:00" */
export function groupedHours(hours: DayHours[]): Array<{ label: string; hours: string }> {
  const sorted = [...hours].sort((a, b) => a.day - b.day);
  const groups: Array<{ from: number; to: number; hours: string }> = [];
  for (const d of sorted) {
    const text = formatDayHours(d);
    const last = groups[groups.length - 1];
    if (last && last.hours === text && last.to === d.day - 1) last.to = d.day;
    else groups.push({ from: d.day, to: d.day, hours: text });
  }
  return groups.map((g) => ({
    label: g.from === g.to ? DAY_NAMES[g.from - 1] : `${DAY_NAMES[g.from - 1]} – ${DAY_NAMES[g.to - 1]}`,
    hours: g.hours,
  }));
}

export type OpenStatus = { open: boolean; label: string };

/** "Ανοιχτά · κλείνει 17:00" / "Κλειστά · ανοίγει Δευτέρα 08:30", evaluated in Athens time. */
export function openStatus(hours: DayHours[], now: Date = new Date()): OpenStatus {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Athens',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const today = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekday) + 1;
  const minutes = hh * 60 + mm;
  const toMin = (t?: string) => {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  };
  const shifts = (d: DayHours) =>
    d.closed
      ? []
      : ([
          [toMin(d.open), toMin(d.close), d.open, d.close],
          [toMin(d.open2), toMin(d.close2), d.open2, d.close2],
        ].filter((s) => s[0] !== null && s[1] !== null) as Array<[number, number, string, string]>);

  const byDay = new Map(hours.map((h) => [h.day, h]));
  const todayHours = byDay.get(today);
  if (todayHours) {
    for (const [from, to, , closeLabel] of shifts(todayHours)) {
      if (minutes >= from && minutes < to) return { open: true, label: `Ανοιχτά · κλείνει ${closeLabel}` };
    }
    const later = shifts(todayHours).find(([from]) => from > minutes);
    if (later) return { open: false, label: `Κλειστά · ανοίγει ${later[2]}` };
  }
  for (let i = 1; i <= 7; i++) {
    const day = ((today - 1 + i) % 7) + 1;
    const d = byDay.get(day);
    const first = d ? shifts(d)[0] : undefined;
    if (first) {
      const name = i === 1 ? 'αύριο' : DAY_NAMES[day - 1];
      return { open: false, label: `Κλειστά · ανοίγει ${name} ${first[2]}` };
    }
  }
  return { open: false, label: 'Κλειστά' };
}
