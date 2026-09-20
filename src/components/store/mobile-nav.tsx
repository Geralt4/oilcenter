'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ChevronDown, Heart, Menu, Navigation, Phone, User, X } from 'lucide-react';
import { CategoryIcon } from '@/components/category-icon';
import { Logo } from '@/components/logo';
import type { BrandWithCount, CategoryNode } from '@/lib/catalog';
import { mapsDirectionsUrl, type ShopSettings } from '@/lib/settings';
import { cn, telHref } from '@/lib/utils';

type Props = { tree: CategoryNode[]; brands: BrandWithCount[]; shop: ShopSettings['shop']; customerName: string | null };

export function MobileNav({ tree, brands, shop, customerName }: Props) {
  const pathname = usePathname();
  // Remember WHERE the drawer was opened: navigating away closes it with no effect / extra render.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt === pathname;
  const setOpen = (next: boolean) => setOpenedAt(next ? pathname : null);
  const [expanded, setExpanded] = useState<number | 'brands' | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpenedAt(null);
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [open]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label="Μενού" aria-expanded={open} className="-ml-2 flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl text-ink-800 hover:bg-ink-100 lg:hidden">
        <Menu className="h-6 w-6" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Μενού πλοήγησης">
          <button type="button" aria-label="Κλείσιμο μενού" onClick={() => setOpen(false)} className="animate-fade-in absolute inset-0 h-full w-full cursor-default bg-ink-950/55 backdrop-blur-[2px]" />
          <div className="animate-slide-in-left absolute inset-y-0 left-0 flex w-[88%] max-w-sm flex-col bg-white shadow-lift">
            <div className="flex h-16 shrink-0 items-center justify-between border-b border-line px-4">
              <Logo />
              <button type="button" onClick={() => setOpen(false)} aria-label="Κλείσιμο" className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl text-ink-600 hover:bg-ink-100">
                <X className="h-5 w-5" />
              </button>
            </div>

            <nav className="flex-1 overflow-y-auto px-2 py-3">
              <Link href="/products" className="mb-2 flex h-12 items-center justify-center rounded-xl bg-ink-900 font-semibold text-white">
                Όλα τα προϊόντα
              </Link>
              <ul>
                {tree.map((cat) => (
                  <li key={cat.id} className="border-b border-line last:border-0">
                    <div className="flex items-center">
                      <Link href={`/category/${cat.slug}`} className="flex flex-1 items-center gap-3 px-2 py-3.5 font-semibold text-ink-900">
                        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink-100 text-ink-700">
                          <CategoryIcon name={cat.icon} className="h-[1.125rem] w-[1.125rem]" />
                        </span>
                        {cat.name}
                      </Link>
                      {cat.children.length > 0 && (
                        <button type="button" onClick={() => setExpanded(expanded === cat.id ? null : cat.id)} aria-expanded={expanded === cat.id} aria-label={`Υποκατηγορίες: ${cat.name}`} className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl text-ink-500 hover:bg-ink-100">
                          <ChevronDown className={cn('h-5 w-5 transition-transform', expanded === cat.id && 'rotate-180')} />
                        </button>
                      )}
                    </div>
                    {expanded === cat.id && (
                      <ul className="mb-3 ml-[3.25rem] space-y-0.5 border-l-2 border-oil-300 pl-3">
                        {cat.children.map((child) => (
                          <li key={child.id}>
                            <Link href={`/category/${child.slug}`} className="flex items-center justify-between rounded-lg px-2 py-2.5 text-[0.9375rem] text-ink-700 hover:bg-ink-50">
                              {child.name}
                              <span className="text-xs text-ink-400">{child.productCount}</span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
                <li>
                  <button type="button" onClick={() => setExpanded(expanded === 'brands' ? null : 'brands')} aria-expanded={expanded === 'brands'} className="flex w-full cursor-pointer items-center justify-between px-2 py-3.5 font-semibold text-ink-900">
                    <span className="pl-12">Μάρκες</span>
                    <ChevronDown className={cn('mr-3 h-5 w-5 text-ink-500 transition-transform', expanded === 'brands' && 'rotate-180')} />
                  </button>
                  {expanded === 'brands' && (
                    <ul className="mb-3 ml-[3.25rem] grid grid-cols-2 gap-0.5 border-l-2 border-oil-300 pl-3">
                      {brands.map((b) => (
                        <li key={b.id}>
                          <Link href={`/brand/${b.slug}`} className="block rounded-lg px-2 py-2.5 text-[0.9375rem] text-ink-700 hover:bg-ink-50">
                            {b.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              </ul>

              <ul className="mt-3 grid grid-cols-2 gap-2 border-t border-line pt-4 text-sm font-medium text-ink-700">
                <li><Link href={customerName ? '/account' : '/login'} className="flex items-center gap-2 rounded-xl bg-ink-50 px-3 py-3"><User className="h-4 w-4" />{customerName ? 'Λογαριασμός' : 'Σύνδεση'}</Link></li>
                <li><Link href="/wishlist" className="flex items-center gap-2 rounded-xl bg-ink-50 px-3 py-3"><Heart className="h-4 w-4" />Αγαπημένα</Link></li>
                <li><Link href="/about" className="block rounded-xl bg-ink-50 px-3 py-3">Το κατάστημα</Link></li>
                <li><Link href="/contact" className="block rounded-xl bg-ink-50 px-3 py-3">Επικοινωνία</Link></li>
                <li><Link href="/order-status" className="block rounded-xl bg-ink-50 px-3 py-3">Η παραγγελία μου</Link></li>
                <li><Link href="/shipping-payments" className="block rounded-xl bg-ink-50 px-3 py-3">Αποστολές</Link></li>
              </ul>
            </nav>

            <div className="safe-bottom grid shrink-0 grid-cols-2 gap-2 border-t border-line bg-ink-50 p-3">
              <a href={telHref(shop.phone)} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-oil-500 font-semibold text-ink-950">
                <Phone className="h-4 w-4" />
                Κλήση
              </a>
              <a href={mapsDirectionsUrl(shop)} target="_blank" rel="noopener noreferrer" className="flex h-12 items-center justify-center gap-2 rounded-xl bg-ink-900 font-semibold text-white">
                <Navigation className="h-4 w-4" />
                Οδηγίες
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
