'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { BadgeEuro, Boxes, Inbox, LayoutDashboard, Menu, Package, Settings, ShoppingBag, Tags, Ticket, X } from 'lucide-react';
import { cn } from '@/lib/utils';

const ITEMS = [
  { href: '/admin', label: 'Επισκόπηση', icon: LayoutDashboard, exact: true },
  { href: '/admin/orders', label: 'Παραγγελίες', icon: ShoppingBag, badge: 'orders' as const },
  { href: '/admin/prices', label: 'Τιμές', icon: BadgeEuro, badge: 'prices' as const },
  { href: '/admin/products', label: 'Προϊόντα', icon: Package },
  { href: '/admin/categories', label: 'Κατηγορίες', icon: Boxes },
  { href: '/admin/brands', label: 'Μάρκες', icon: Tags },
  { href: '/admin/coupons', label: 'Κουπόνια', icon: Ticket },
  { href: '/admin/messages', label: 'Μηνύματα', icon: Inbox, badge: 'messages' as const },
  { href: '/admin/settings', label: 'Ρυθμίσεις', icon: Settings },
];

export function AdminNav({ badges }: { badges: { orders: number; prices: number; messages: number } }) {
  const pathname = usePathname();
  // Remember WHERE the drawer was opened: navigating away closes it with no effect / extra render.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt === pathname;
  const setOpen = (next: boolean) => setOpenedAt(next ? pathname : null);

  const list = (
    <ul className="space-y-0.5">
      {ITEMS.map(({ href, label, icon: Icon, exact, badge }) => {
        const active = exact ? pathname === href : pathname.startsWith(href);
        const count = badge ? badges[badge] : 0;
        return (
          <li key={href}>
            <Link href={href} aria-current={active ? 'page' : undefined} className={cn('flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors', active ? 'bg-oil-500 text-ink-950' : 'text-ink-200 hover:bg-white/10 hover:text-white')}>
              <Icon className="h-[1.125rem] w-[1.125rem] shrink-0" />
              <span className="flex-1">{label}</span>
              {count > 0 && <span className={cn('tabular rounded-full px-2 py-0.5 text-xs font-bold', active ? 'bg-ink-950 text-oil-300' : 'bg-oil-500 text-ink-950')}>{count}</span>}
            </Link>
          </li>
        );
      })}
    </ul>
  );

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label="Μενού διαχείρισης" className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl text-white hover:bg-white/10 lg:hidden">
        <Menu className="h-5 w-5" />
      </button>
      <nav aria-label="Διαχείριση" className="hidden lg:block">{list}</nav>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <button type="button" aria-label="Κλείσιμο" onClick={() => setOpen(false)} className="absolute inset-0 h-full w-full cursor-default bg-ink-950/60" />
          <div className="animate-slide-in-left steel absolute inset-y-0 left-0 w-72 p-4">
            <div className="mb-4 flex justify-end">
              <button type="button" onClick={() => setOpen(false)} aria-label="Κλείσιμο" className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl text-white hover:bg-white/10"><X className="h-5 w-5" /></button>
            </div>
            {list}
          </div>
        </div>
      )}
    </>
  );
}
