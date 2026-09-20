import type { ProductDetail } from '@/lib/catalog';
import type { ShopSettings } from '@/lib/settings';
import { siteUrl } from '@/lib/site-url';

const DAY_SCHEMA = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export { siteUrl };

/** schema.org AutoPartsStore — feeds Google's local panel with phone, address, geo and opening hours. */
export function localBusinessJsonLd(settings: ShopSettings) {
  const { shop } = settings;
  const phone = `+30${shop.phone.replace(/\D/g, '')}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'AutoPartsStore',
    '@id': `${siteUrl()}/#store`,
    name: `${shop.name} — ${shop.legalName}`,
    url: siteUrl(),
    telephone: phone,
    email: shop.email,
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
    sameAs: [shop.facebookUrl, shop.instagramUrl].filter(Boolean),
  };
}

export function productJsonLd(product: ProductDetail, settings: ShopSettings) {
  const url = `${siteUrl()}/product/${product.slug}`;
  const prices = product.variants.map((v) => v.priceCents / 100);
  const inStock = product.variants.some((v) => !v.trackStock || v.stock > 0);
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: [product.brand?.name, product.name].filter(Boolean).join(' '),
    description: product.shortDescription ?? undefined,
    image: product.images.map((i) => `${siteUrl()}${i.url}`),
    sku: product.variants[0]?.sku,
    brand: product.brand ? { '@type': 'Brand', name: product.brand.name } : undefined,
    category: product.category?.name,
    url,
    // Demo-mode prices are placeholders: never hand them to search engines as offers.
    ...(!settings.storefront.demoMode && {
      offers: {
        '@type': 'AggregateOffer',
        priceCurrency: 'EUR',
        lowPrice: Math.min(...prices).toFixed(2),
        highPrice: Math.max(...prices).toFixed(2),
        offerCount: product.variants.length,
        availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
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
