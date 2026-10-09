'use client';

import Link from 'next/link';
import { useState, useSyncExternalStore } from 'react';
import { useStoreConfig } from '@/components/store/store-context';

/*
 * The shop sets only strictly-necessary first-party storage (cart, login). No analytics or ad
 * trackers ship with the site, so this is an information notice rather than a consent wall.
 * If tracking scripts are ever added, this must become a real opt-in before they load.
 */
const KEY = 'oilcenter-cookie-notice';
const subscribe = () => () => {};
const readSeen = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return true; // storage blocked: don't nag on every page
  }
};

export function CookieNotice() {
  const { canOrder } = useStoreConfig();
  // server + hydration render "seen" (nothing), the client then reads the real value
  const seen = useSyncExternalStore(subscribe, readSeen, () => true);
  const [dismissed, setDismissed] = useState(false);

  if (seen || dismissed) return null;
  return (
    <div role="region" aria-label="Ενημέρωση για cookies" className="animate-slide-up fixed inset-x-3 bottom-20 z-30 mx-auto flex max-w-xl items-center gap-3 rounded-2xl border border-line bg-white p-3 shadow-lift sm:p-4 md:right-auto md:bottom-4 md:left-4 md:mx-0 md:max-w-sm">
      {/* the Google map is no longer mentioned here: it loads only when the visitor asks for it (map-embed.tsx) */}
      <p className="text-[0.8125rem] leading-snug text-ink-700 sm:text-sm">
        Χρησιμοποιούμε μόνο τα απολύτως απαραίτητα cookies{canOrder ? ' για τη λειτουργία του καλαθιού και της σύνδεσής σας' : ''}.{' '}
        <Link href="/cookies" className="font-semibold text-petrol-500 underline underline-offset-2">Μάθετε περισσότερα</Link>
      </p>
      <button
        type="button"
        onClick={() => {
          try {
            localStorage.setItem(KEY, '1');
          } catch {
            /* private mode */
          }
          setDismissed(true);
        }}
        className="h-10 shrink-0 cursor-pointer rounded-xl bg-ink-900 px-4 text-sm font-semibold text-white hover:bg-ink-700"
      >
        Εντάξει
      </button>
    </div>
  );
}
