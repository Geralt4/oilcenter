import { Fragment } from 'react';
import Link from 'next/link';
import { ChevronDown, Heart, MapPin, Navigation, Phone, User } from 'lucide-react';
import { CategoryIcon } from '@/components/category-icon';
import { Logo } from '@/components/logo';
import { CartButton } from '@/components/store/cart-button';
import { MobileNav } from '@/components/store/mobile-nav';
import { SocialLinks } from '@/components/store/social-links';
import { SearchBox } from '@/components/store/search-box';
import type { BrandWithCount, CategoryNode } from '@/lib/catalog';
import { fullAddress, mapsDirectionsUrl, mapsPlaceUrl, openStatus, type ShopSettings } from '@/lib/settings';
import { cn, telHref } from '@/lib/utils';

type Props = {
  settings: ShopSettings;
  tree: CategoryNode[];
  brands: BrandWithCount[];
  customerName: string | null;
};

export function Header({ settings, tree, brands, customerName }: Props) {
  const { shop, storefront } = settings;
  const status = openStatus(shop.hours);

  return (
    <header className="sticky top-0 z-40">
      {!storefront.ordersEnabled ? (
        <div className="bg-petrol-700 px-4 py-1.5 text-center text-xs font-medium text-white">
          Το ηλεκτρονικό κατάστημα ετοιμάζεται — οι online παραγγελίες δεν έχουν ανοίξει ακόμη. Για αγορές καλέστε στο{' '}
          <a href={telHref(shop.phone)} className="tabular font-semibold whitespace-nowrap underline underline-offset-2">{shop.phone}</a>.
        </div>
      ) : (
        storefront.demoMode && (
          <div className="bg-petrol-700 px-4 py-1.5 text-center text-xs font-medium text-white">
            Δοκιμαστική λειτουργία — οι τιμές είναι ενδεικτικές και οι παραγγελίες δεν εκτελούνται.
          </div>
        )
      )}

      {/* Utility bar: the two things a local customer wants most — call and find us */}
      <div className="bg-ink-900 text-ink-200">
        <div className="container-page flex h-9 items-center justify-between gap-4 text-[0.8125rem]">
          <div className="flex min-w-0 items-center gap-4">
            <span className="flex shrink-0 items-center gap-1.5" title={shop.hoursVerified ? undefined : 'Ενδεικτικό ωράριο'}>
              <span className={cn('h-2 w-2 rounded-full', status.open ? 'bg-emerald-400 shadow-[0_0_0_3px_rgb(52_211_153/0.25)]' : 'bg-ink-500')} />
              <span className="hidden sm:inline">{status.label}</span>
              <span className="sm:hidden">{status.open ? 'Ανοιχτά' : 'Κλειστά'}</span>
            </span>
            <a href={mapsPlaceUrl(shop)} target="_blank" rel="noopener noreferrer" className="hidden min-w-0 items-center gap-1.5 truncate hover:text-white md:flex">
              <MapPin className="h-3.5 w-3.5 shrink-0 text-oil-400" />
              <span className="truncate">{fullAddress(shop)}</span>
            </a>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <SocialLinks shop={shop} tone="bar" className="hidden xl:flex" />
            <Link href="/about" className="hidden hover:text-white lg:inline">Το κατάστημα</Link>
            <Link href="/contact" className="hidden hover:text-white lg:inline">Επικοινωνία</Link>
            <a href={mapsDirectionsUrl(shop)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 hover:text-white">
              <Navigation className="h-3.5 w-3.5 text-oil-400" />
              Οδηγίες
            </a>
            <a href={telHref(shop.phone)} className="flex items-center gap-1.5 font-semibold text-white hover:text-oil-300">
              <Phone className="h-3.5 w-3.5 text-oil-400" />
              <span className="tabular">{shop.phone}</span>
            </a>
            {shop.mobile && (
              <a href={telHref(shop.mobile)} className="hidden items-center gap-1.5 font-semibold text-white hover:text-oil-300 lg:flex">
                <span className="tabular">{shop.mobile}</span>
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="border-b border-line bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85">
        <div className="container-page flex h-16 items-center gap-3 lg:h-[4.5rem] lg:gap-8">
          <MobileNav tree={tree} brands={brands} shop={shop} customerName={customerName} />

          <Link href="/" aria-label="Oil Center — αρχική σελίδα" className="shrink-0">
            <Logo />
          </Link>

          <div className="hidden flex-1 lg:block">
            <SearchBox />
          </div>

          <nav className="ml-auto flex items-center gap-1" aria-label="Λογαριασμός και καλάθι">
            <Link
              href={customerName ? '/account' : '/login'}
              className="hidden h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium text-ink-700 hover:bg-ink-100 sm:flex"
            >
              <User className="h-5 w-5" />
              <span className="hidden xl:inline">{customerName ? customerName : 'Σύνδεση'}</span>
            </Link>
            <Link href="/wishlist" aria-label="Αγαπημένα" className="hidden h-11 w-11 items-center justify-center rounded-xl text-ink-700 hover:bg-ink-100 sm:flex">
              <Heart className="h-5 w-5" />
            </Link>
            <CartButton />
          </nav>
        </div>

        <div className="container-page pb-3 lg:hidden">
          <SearchBox />
        </div>

        {/* Desktop category bar with hover / keyboard-accessible dropdowns (no JS needed).
            Below xl the categories cannot share one line, so the row wraps instead of running
            off-screen — that overflow is what gave the whole page a horizontal scrollbar. The
            spacer splits them into two even lines at a fixed point rather than letting the break
            fall where it may, which keeps every item near the left edge of its own line, where its
            20rem panel has room; «Μάρκες» is pushed to the end of its line so that its wider,
            right-aligned panel lands inside the page as well. overflow-x-clip is the backstop
            should the catalogue outgrow this again: it clips sideways only, so the panels still
            hang below the bar. */}
        <nav className="hidden overflow-x-clip border-t border-line lg:block" aria-label="Κατηγορίες">
          <ul className="container-page flex flex-wrap items-center gap-x-0.5 gap-y-1 py-1.5 text-sm font-medium whitespace-nowrap xl:text-[0.9375rem]">
            <li>
              <Link href="/products" className="flex h-9 items-center rounded-lg bg-ink-900 px-4 font-semibold text-white hover:bg-ink-700">
                Όλα τα προϊόντα
              </Link>
            </li>
            {tree.map((cat, i) => (
              <Fragment key={cat.id}>
                {tree.length > 4 && i === Math.ceil(tree.length / 2) && <li aria-hidden="true" className="h-0 basis-full xl:hidden" />}
                <li className="group relative">
                  <Link
                    href={`/category/${cat.slug}`}
                    className="flex h-9 items-center gap-1 rounded-lg px-2.5 text-ink-700 group-focus-within:bg-ink-100 group-hover:bg-ink-100 hover:text-ink-950"
                  >
                    {cat.name}
                    {cat.children.length > 0 && <ChevronDown className="h-3.5 w-3.5 text-ink-400 transition-transform group-hover:rotate-180" />}
                  </Link>
                  {cat.children.length > 0 && (
                    <div className="invisible absolute top-full left-0 z-50 w-80 pt-2 opacity-0 transition-[opacity,visibility] duration-150 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
                      <ul className="rounded-2xl border border-line bg-white p-2 shadow-lift">
                        {cat.children.map((child) => (
                          <li key={child.id}>
                            <Link href={`/category/${child.slug}`} className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-oil-50">
                              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ink-100 text-ink-700">
                                <CategoryIcon name={child.icon} className="h-[1.125rem] w-[1.125rem]" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-semibold text-ink-900">{child.name}</span>
                                <span className="text-xs text-ink-500">{child.productCount} προϊόντα</span>
                              </span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </li>
              </Fragment>
            ))}
            <li className="group relative ml-auto">
              <Link href="/brands" className="flex h-9 items-center gap-1 rounded-lg px-2.5 text-ink-700 group-focus-within:bg-ink-100 group-hover:bg-ink-100 hover:text-ink-950">
                Μάρκες
                <ChevronDown className="h-3.5 w-3.5 text-ink-400 transition-transform group-hover:rotate-180" />
              </Link>
              <div className="invisible absolute top-full right-0 z-50 w-[28rem] pt-2 opacity-0 transition-[opacity,visibility] duration-150 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
                <ul className="grid grid-cols-2 gap-0.5 rounded-2xl border border-line bg-white p-2 shadow-lift">
                  {brands.map((b) => (
                    <li key={b.id}>
                      <Link href={`/brand/${b.slug}`} className="flex items-center justify-between rounded-xl px-3 py-2 hover:bg-oil-50">
                        <span className="font-semibold text-ink-900">{b.name}</span>
                        <span className="text-xs text-ink-400">{b.productCount}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}
