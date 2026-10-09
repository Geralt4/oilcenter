import { bestAvailability, effectiveAvailability } from '@/lib/availability';
import type { ProductDetail } from '@/lib/catalog';
import type { ShopSettings } from '@/lib/settings';
import { siteUrl } from '@/lib/site-url';
import { telHref } from '@/lib/utils';

const DAY_SCHEMA = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export { siteUrl };

/**
 * Serialise data for a <script type="application/ld+json"> block. A bare JSON.stringify does not escape
 * "<", so a value containing "</script>" (e.g. a manufacturer code pasted into the admin or imported from a
 * distributor CSV) could close the tag and inject markup. Escape the tag-breaking characters, plus the raw
 * line/paragraph separators that are invalid in JSON embedded in HTML. Use this at every JSON-LD site.
 */
export function jsonLdString(data: unknown): string {
  // Built from a string so the source stays ASCII (a raw U+2028 would terminate a regex literal).
  const unsafe = new RegExp('[<>&\\u2028\\u2029]', 'g');
  return JSON.stringify(data).replace(unsafe, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/**
 * What every share card has in common. Next replaces `openGraph` as a whole when a page sets its own, so a page that
 * does must spread this in — and must NOT inherit a url: a card that names the home page as its address sends every
 * share of a category or a product back to the home page.
 */
export const OG_BASE = { type: 'website', locale: 'el_GR', siteName: 'Oil Center — Τσακιρίδης' } as const;
/** the card shown when a page has no picture of its own (1200×630, public/shop/share.jpg) */
export const OG_IMAGE = { url: '/shop/share.jpg', width: 1200, height: 630, alt: 'Oil Center — Τσακιρίδης · Λιπαντικά, Θεσσαλονίκη' } as const;

/** schema.org AutoPartsStore — feeds Google's local panel with phone, address, geo and opening hours. */
export function localBusinessJsonLd(settings: ShopSettings) {
  const { shop } = settings;
  // telHref knows a number may already carry its +30
  const phone = telHref(shop.phone).replace(/^tel:/, '');
  return {
    '@context': 'https://schema.org',
    '@type': 'AutoPartsStore',
    '@id': `${siteUrl()}/#store`,
    name: `${shop.name} — ${shop.legalName}`,
    url: siteUrl(),
    telephone: phone,
    ...(shop.email && { email: shop.email }),
    image: `${siteUrl()}/shop/counter-mobil-1.webp`,
    priceRange: '€',
    currenciesAccepted: 'EUR',
    address: {
      '@type': 'PostalAddress',
      streetAddress: shop.street,
      addressLocality: shop.city,
      postalCode: shop.postalCode.replace(/\s/g, ''),
      addressRegion: shop.region,
      addressCountry: 'GR',
    },
    geo: { '@type': 'GeoCoordinates', latitude: shop.lat, longitude: shop.lng },
    hasMap: `https://www.google.com/maps/search/?api=1&query=${shop.lat},${shop.lng}`,
    // Only publish hours the owner has confirmed; wrong hours in Google are worse than none.
    ...(shop.hoursVerified && {
      openingHoursSpecification: shop.hours
        .filter((d) => !d.closed && d.open && d.close)
        .flatMap((d) => [
          { '@type': 'OpeningHoursSpecification', dayOfWeek: DAY_SCHEMA[d.day - 1], opens: d.open, closes: d.close },
          ...(d.open2 && d.close2 ? [{ '@type': 'OpeningHoursSpecification', dayOfWeek: DAY_SCHEMA[d.day - 1], opens: d.open2, closes: d.close2 }] : []),
        ]),
    }),
    sameAs: [shop.instagramUrl, shop.skroutzUrl].filter(Boolean),
  };
}

export function productJsonLd(product: ProductDetail, settings: ShopSettings) {
  const url = `${siteUrl()}/product/${product.slug}`;
  // Only prices the owner has confirmed, and only while the shop really sells online: an offer tells Google "you can buy
  // this here at this price", which is false in demo mode, while ordering is closed, and for placeholder prices.
  const sellable = product.variants.filter((v) => v.priceVerified);
  const prices = sellable.map((v) => v.priceCents / 100);
  // best state among the sizes: on the shelf → InStock, comes from the supplier / on order → BackOrder
  const best = bestAvailability(sellable.map(effectiveAvailability));
  const { demoMode, ordersEnabled } = settings.storefront;
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: [product.brand?.name, product.name].filter(Boolean).join(' '),
    description: product.shortDescription ?? undefined,
    image: product.images.map((i) => `${siteUrl()}${i.url}`),
    sku: product.variants[0]?.sku,
    // one Product can carry one barcode: only for products sold in a single size (several sizes would need a ProductGroup)
    ...(product.variants.length === 1 && {
      mpn: product.variants[0].mpn ?? undefined,
      gtin: product.variants[0].barcode ?? undefined,
    }),
    brand: product.brand ? { '@type': 'Brand', name: product.brand.name } : undefined,
    category: product.category?.name,
    url,
    ...(!demoMode && ordersEnabled && prices.length > 0 && {
      offers: {
        '@type': 'AggregateOffer',
        priceCurrency: 'EUR',
        lowPrice: Math.min(...prices).toFixed(2),
        highPrice: Math.max(...prices).toFixed(2),
        offerCount: sellable.length,
        availability: `https://schema.org/${best === 'in_stock' ? 'InStock' : best === 'unavailable' ? 'OutOfStock' : 'BackOrder'}`,
        url,
        seller: { '@id': `${siteUrl()}/#store` },
      },
    }),
  };
}

export function breadcrumbJsonLd(items: Array<{ name: string; href: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({ '@type': 'ListItem', position: i + 1, name: item.name, item: `${siteUrl()}${item.href}` })),
  };
}
