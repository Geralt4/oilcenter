import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, Headset, Phone, ShieldCheck, Store, Truck } from 'lucide-react';
import { CategoryIcon } from '@/components/category-icon';
import { ProductGrid } from '@/components/store/product-card';
import { StoreLocation } from '@/components/store/store-location';
import { TrustBadges } from '@/components/store/trust-badges';
import { buttonClass } from '@/components/ui/button';
import { getBrands, getCategoryTree, getFeaturedProducts, getPopularViscosities, listProducts, viscositySlug } from '@/lib/catalog';
import { jsonLdString, localBusinessJsonLd } from '@/lib/seo';
import { getSettings } from '@/lib/settings.server';
import { formatPrice, telHref } from '@/lib/utils';

// The root layout deliberately sets no canonical; the home page declares its own like every indexable page.
export const metadata: Metadata = { alternates: { canonical: '/' } };

export default async function HomePage() {
  const [settings, tree, brands, featured, viscosities, accelerate] = await Promise.all([
    getSettings(),
    getCategoryTree(),
    getBrands(),
    getFeaturedProducts(8),
    getPopularViscosities(8),
    listProducts({ brandSlug: 'accelerate', perPage: 4, sort: 'featured' }),
  ]);
  const { shop, shipping } = settings;
  const totalProducts = tree.reduce((n, c) => n + c.productCount, 0);

  const usps: Array<{ icon: typeof Truck; title: string; text: string; href?: string; more?: string }> = [
    { icon: Headset, title: 'Το σωστό λάδι για το όχημά σας', text: 'Πείτε μας μάρκα, μοντέλο και έτος — τηλεφωνικά ή με τη φόρμα οχήματος.', href: '/find-my-oil', more: 'Ποιο λάδι θέλω; →' },
    { icon: Truck, title: 'Αποστολή σε όλη την Ελλάδα', text: shipping.freeOverCents > 0 ? `Δωρεάν για αγορές άνω των ${formatPrice(shipping.freeOverCents)}.` : `Παράδοση σε ${shipping.deliveryEstimate}.` },
    { icon: Store, title: 'Παραλαβή από το κατάστημα', text: `${shop.street}, ${shop.city} — χωρίς χρέωση.` },
    { icon: Headset, title: 'Δεν είστε σίγουροι;', text: 'Πάρτε μας τηλέφωνο: βρίσκουμε το σωστό λάδι για το όχημά σας.' },
  ];

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(localBusinessJsonLd(settings)) }} />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="steel relative overflow-hidden text-white">
        <div className="container-page grid items-center gap-10 py-12 sm:py-16 lg:grid-cols-[1.1fr_0.9fr] lg:py-20">
          <div>
            <p className="eyebrow inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 text-oil-300">
              <ShieldCheck className="h-3.5 w-3.5" />
              Εξουσιοδοτημένος αντιπρόσωπος accelerate
            </p>
            <h1 className="display mt-5 text-[2.75rem] sm:text-6xl lg:text-7xl">
              Το σωστό λάδι
              <br />
              <span className="text-oil-400">για κάθε κινητήρα.</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-200">
              Λιπαντικά, βαλβολίνες, αντιψυκτικά και χημικά από τις κορυφαίες μάρκες — και συμβουλή για το σωστό λάδι. Παραγγείλετε online ή περάστε από το κατάστημά μας στη {shop.city}.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/products" className={buttonClass({ size: 'lg' })}>
                Δείτε {totalProducts > 0 ? `${totalProducts} προϊόντα` : 'τα προϊόντα'}
                <ArrowRight className="h-5 w-5" />
              </Link>
              <a href={telHref(shop.phone)} className={buttonClass({ variant: 'light', size: 'lg', className: 'tabular' })}>
                <Phone className="h-5 w-5" />
                {shop.phone}
              </a>
            </div>

            <TrustBadges shop={shop} reviews={settings.reviews} tone="dark" className="mt-6" />

            {viscosities.length > 0 && (
              <div className="mt-10">
                <p className="eyebrow text-ink-300">Ξέρετε το ιξώδες; Διαλέξτε το:</p>
                <ul className="mt-3 flex flex-wrap gap-2">
                  {viscosities.map((v) => (
                    <li key={v.viscosity}>
                      <Link
                        href={`/viscosity/${viscositySlug(v.viscosity)}`}
                        className="tabular flex h-11 items-center rounded-xl border border-white/15 bg-white/5 px-4 font-display text-lg font-bold tracking-wide text-white transition-colors hover:border-oil-400 hover:bg-oil-500 hover:text-ink-950"
                      >
                        {v.viscosity}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="relative mx-auto w-full max-w-md lg:max-w-none">
            <div className="relative aspect-[4/5] overflow-hidden rounded-[2rem] shadow-lift ring-1 ring-white/10">
              <Image src="/shop/counter-mobil-1.webp" alt="Λιπαντικά στον πάγκο του καταστήματος Oil Center, με τα ράφια στο βάθος" fill priority sizes="(min-width: 1024px) 520px, 90vw" className="object-cover" />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-950/90 to-transparent p-6 pt-20">
                <p className="eyebrow text-oil-300">Το κατάστημά μας</p>
                <p className="mt-1 text-lg font-semibold">{shop.street}, {shop.city}</p>
              </div>
            </div>
            <div className="absolute -top-4 -right-2 hidden rotate-3 rounded-2xl bg-oil-500 px-5 py-3 text-ink-950 shadow-lift sm:block">
              <p className="display text-3xl">{brands.length}+ μάρκες</p>
              <p className="text-xs font-semibold">σε ένα κατάστημα</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── USPs ─────────────────────────────────────────────────────────── */}
      <section aria-label="Γιατί Oil Center" className="border-b border-line bg-white">
        <ul className="container-page grid gap-x-8 gap-y-5 py-7 sm:grid-cols-2 lg:grid-cols-4">
          {usps.map(({ icon: Icon, title, text, href, more }) => (
            <li key={title} className="flex items-start gap-3.5">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-oil-100 text-oil-800">
                <Icon className="h-5 w-5" />
              </span>
              <div>
                <p className="font-semibold text-ink-900">{title}</p>
                <p className="text-sm text-ink-500">
                  {text}
                  {href && <> <Link href={href} className="font-semibold text-petrol-500 hover:text-petrol-700">{more}</Link></>}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* ── Categories ───────────────────────────────────────────────────── */}
      <section className="container-page pt-14">
        <div className="flex items-end justify-between gap-4">
          <h2 className="display text-3xl sm:text-4xl">Τι ψάχνετε;</h2>
          <Link href="/products" className="hidden items-center gap-1 text-sm font-semibold text-ink-700 hover:text-ink-950 sm:flex">
            Όλα τα προϊόντα <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tree.map((cat) => (
            <li key={cat.id}>
              <div className="group h-full rounded-2xl border border-line bg-white p-5 shadow-tile transition-[box-shadow,border-color] hover:border-ink-200 hover:shadow-lift">
                <Link href={`/category/${cat.slug}`} className="flex items-center gap-4">
                  <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-ink-900 text-oil-400 transition-colors group-hover:bg-oil-500 group-hover:text-ink-950">
                    <CategoryIcon name={cat.icon} className="h-6 w-6" />
                  </span>
                  <span className="min-w-0">
                    <span className="display block text-xl text-ink-900">{cat.name}</span>
                    <span className="text-sm text-ink-500">{cat.productCount} προϊόντα</span>
                  </span>
                </Link>
                {cat.children.length > 0 && (
                  <ul className="mt-4 flex flex-wrap gap-1.5">
                    {cat.children.filter((c) => c.productCount > 0).map((child) => (
                      <li key={child.id}>
                        <Link href={`/category/${child.slug}`} className="inline-flex h-8 items-center rounded-lg bg-ink-50 px-2.5 text-[0.8125rem] font-medium text-ink-700 hover:bg-oil-100 hover:text-ink-950">
                          {child.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* ── «Ποιο λάδι;» — the shop's answer to the big sites' vehicle selectors: a person who knows ── */}
      <section className="container-page pt-8">
        <div className="steel flex flex-col gap-5 rounded-3xl p-6 text-white sm:flex-row sm:items-center sm:justify-between sm:p-8">
          <div className="flex items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-oil-500 text-ink-950">
              <Headset className="h-6 w-6" />
            </span>
            <div>
              <h2 className="display text-2xl sm:text-3xl">Δεν ξέρετε ποιο λάδι θέλει το όχημά σας;</h2>
              <p className="mt-1 max-w-xl text-ink-300">Πείτε μας μάρκα, μοντέλο και έτος. Σας καλούμε με το ιξώδες και την προδιαγραφή που ζητά ο κατασκευαστής.</p>
            </div>
          </div>
          <Link href="/find-my-oil" className={buttonClass({ size: 'lg', className: 'shrink-0' })}>
            Βρείτε το σωστό λάδι <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* ── Featured ─────────────────────────────────────────────────────── */}
      {featured.length > 0 && (
        <section className="container-page pt-16">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="eyebrow text-oil-700">Οι επιλογές μας</p>
              <h2 className="display mt-1 text-3xl sm:text-4xl">Δημοφιλή προϊόντα</h2>
            </div>
            <Link href="/products" className="flex items-center gap-1 text-sm font-semibold text-ink-700 hover:text-ink-950">
              Δείτε όλα <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="mt-6">
            <ProductGrid products={featured} priorityCount={4} />
          </div>
        </section>
      )}

      {/* ── accelerate spotlight ─────────────────────────────────────────── */}
      {accelerate.products.length > 0 && (
        <section className="container-page pt-16">
          <div className="steel overflow-hidden rounded-3xl text-white">
            <div className="grid gap-8 p-6 sm:p-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-center">
              <div>
                <p className="eyebrow text-oil-300">Made in Germany</p>
                <h2 className="display mt-2 text-4xl sm:text-5xl">accelerate</h2>
                <p className="mt-4 leading-relaxed text-ink-200">
                  Γερμανική ποιότητα και τεχνολογία, με επίσημες εγκρίσεις κατασκευαστών (VW, Mercedes-Benz, BMW). Είμαστε ο εξουσιοδοτημένος αντιπρόσωπος της accelerate — γι&apos; αυτό θα τη βρείτε εδώ στην καλύτερη τιμή.
                </p>
                <Link href="/brand/accelerate" className={buttonClass({ className: 'mt-6' })}>
                  Όλη η γκάμα accelerate
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {accelerate.products.map((p) => (
                  <li key={p.id}>
                    <Link href={`/product/${p.slug}`} className="group block overflow-hidden rounded-2xl bg-white text-ink-900">
                      <span className="relative block aspect-square">
                        {p.imageUrl && <Image src={p.imageUrl} alt={p.name} fill sizes="(min-width: 1024px) 180px, 45vw" className="object-contain p-3 transition-transform duration-300 group-hover:scale-105" />}
                      </span>
                      <span className="block border-t border-line p-3">
                        <span className="line-clamp-1 text-sm font-semibold">{p.name}</span>
                        <span className="tabular text-sm text-ink-500">{p.hasPrice ? `από ${formatPrice(p.minPriceCents)}` : 'Καλέστε για τιμή'}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

      {/* ── Brands ───────────────────────────────────────────────────────── */}
      <section className="container-page pt-16">
        <h2 className="display text-3xl sm:text-4xl">Οι μάρκες μας</h2>
        <ul className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {brands.filter((b) => b.isFeatured).map((b) => (
            <li key={b.id}>
              <Link href={`/brand/${b.slug}`} className="flex h-20 flex-col items-center justify-center rounded-2xl border border-line bg-white px-3 text-center shadow-tile transition-[box-shadow,border-color,transform] hover:-translate-y-0.5 hover:border-oil-400 hover:shadow-lift">
                <span className="font-display text-xl font-extrabold tracking-tight text-ink-900">{b.name}</span>
                <span className="text-xs text-ink-400">{b.productCount} προϊόντα</span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-ink-500">
          <Link href="/brands" className="font-semibold text-ink-800 underline underline-offset-4 hover:text-ink-950">Δείτε και τις {brands.length} μάρκες</Link>
        </p>
      </section>

      {/* ── Visit us ─────────────────────────────────────────────────────── */}
      <section className="container-page pt-16">
        <StoreLocation shop={shop} />
      </section>
    </>
  );
}
