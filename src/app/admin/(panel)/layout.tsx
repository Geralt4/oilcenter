import type { Metadata } from 'next';
import Link from 'next/link';
import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import { ExternalLink, LogOut } from 'lucide-react';
import { logoutAdmin } from '@/app/admin/actions';
import { AdminNav } from '@/components/admin/admin-nav';
import { Logo } from '@/components/logo';
import { requireAdmin } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { contactMessages, orders, unmatchedPayments, variants } from '@/lib/db/schema';

export const metadata: Metadata = { title: { default: 'Διαχείριση', template: '%s · Διαχείριση Oil Center' }, robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  const [[openOrders], [unverified], [unread], [flaggedOrders], [unmatched]] = await Promise.all([
    db.select({ n: count() }).from(orders).where(inArray(orders.status, ['pending', 'confirmed', 'processing'])),
    db.select({ n: count() }).from(variants).where(and(eq(variants.priceVerified, false), eq(variants.isActive, true))),
    db.select({ n: count() }).from(contactMessages).where(eq(contactMessages.isRead, false)),
    // payment problems waiting for the owner: orders flagged for review + paid payments that matched no order
    db.select({ n: count() }).from(orders).where(eq(orders.paymentFlag, 'review')),
    db.select({ n: count() }).from(unmatchedPayments).where(isNull(unmatchedPayments.resolvedAt)),
  ]);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_1fr]">
      <aside className="steel sticky top-0 z-30 flex items-center justify-between gap-3 px-4 py-3 lg:h-dvh lg:flex-col lg:items-stretch lg:justify-start lg:gap-6 lg:p-4">
        {/*
          The menu scrolls on its own when it is taller than the window, so «Αποσύνδεση» below it never leaves the screen.
          Plain `flex-col` here: with `flex-col-reverse` the overflow lands on the side a scroller cannot reach and the
          lower menu items are clipped. The logo is moved above the menu with `order`, so the markup (and the phone layout,
          hamburger first) stays as it was.
        */}
        <div className="flex items-center gap-2 lg:min-h-0 lg:flex-col lg:items-stretch lg:gap-6 lg:overflow-y-auto">
          <div className="lg:order-2">
            <AdminNav badges={{ orders: openOrders.n, prices: unverified.n, messages: unread.n, attention: flaggedOrders.n + unmatched.n }} />
          </div>
          <Link href="/admin" className="lg:order-1 lg:px-2 lg:pt-2"><Logo tone="light" /></Link>
        </div>
        <div className="hidden lg:block lg:flex-1" />
        <div className="flex items-center gap-1 lg:flex-col lg:items-stretch lg:gap-1 lg:border-t lg:border-white/10 lg:pt-4">
          <p className="hidden truncate px-3 pb-1 text-xs text-ink-400 lg:block">{admin.name || admin.email}</p>
          <Link href="/" target="_blank" className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-ink-200 hover:bg-white/10 hover:text-white">
            <ExternalLink className="h-[1.125rem] w-[1.125rem]" /><span className="hidden sm:inline">Προβολή καταστήματος</span>
          </Link>
          <form action={logoutAdmin}>
            <button type="submit" className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-ink-200 hover:bg-white/10 hover:text-white">
              <LogOut className="h-[1.125rem] w-[1.125rem]" /><span className="hidden sm:inline">Αποσύνδεση</span>
            </button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
    </div>
  );
}
