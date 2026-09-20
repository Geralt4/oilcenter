'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { classifyLink, track } from '@/lib/track';

/** Mounted once in the storefront layout: counts page views and clicks on call / directions / Skroutz / social links. */
export function Tracker() {
  const pathname = usePathname();
  const first = useRef(true);

  useEffect(() => {
    // the referrer only says where the VISIT came from, so it is sent with the first view only
    track({ t: 'view', path: pathname, w: window.innerWidth, ...(first.current && document.referrer ? { ref: document.referrer } : {}) });
    first.current = false;
  }, [pathname]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.('a[href]');
      const what = link ? classifyLink(link.getAttribute('href') ?? '') : null;
      if (what) track({ t: 'click', what });
    };
    document.addEventListener('click', onClick, { capture: true });
    return () => document.removeEventListener('click', onClick, { capture: true });
  }, []);

  return null;
}

/** Rendered by the search results page: records what was searched and whether anything was found. */
export function TrackSearch({ query, results }: { query: string; results: number }) {
  useEffect(() => {
    track({ t: 'search', q: query, n: results });
  }, [query, results]);
  return null;
}
