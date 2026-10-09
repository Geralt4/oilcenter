/*
 * Browser side of the cookieless statistics: fire-and-forget beacons to /api/t. Nothing is stored on the device —
 * no cookie, no localStorage — and browsers that send "Do Not Track" / Global Privacy Control are left alone.
 */

export type TrackEvent =
  | { t: 'view'; path: string; ref?: string; w?: number }
  | { t: 'search'; q: string; n: number }
  | { t: 'cart'; slug: string }
  | { t: 'click'; what: 'call' | 'directions' | 'skroutz' | 'instagram' | 'email' };

export function track(event: TrackEvent): void {
  if (typeof window === 'undefined') return;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  if (nav.globalPrivacyControl || nav.doNotTrack === '1') return;
  try {
    const body = JSON.stringify(event);
    // sendBeacon survives the page being closed or navigated away from (a click on "call" does exactly that)
    if (!navigator.sendBeacon?.('/api/t', new Blob([body], { type: 'application/json' }))) {
      void fetch('/api/t', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
    }
  } catch {
    /* statistics must never break the page */
  }
}

/** Which outbound / contact link was clicked, if it is one we count. */
export function classifyLink(href: string): Extract<TrackEvent, { t: 'click' }>['what'] | null {
  if (href.startsWith('tel:')) return 'call';
  if (href.startsWith('mailto:')) return 'email';
  if (/google\.[a-z.]+\/maps|maps\.google\.|maps\.app\.goo\.gl|goo\.gl\/maps/i.test(href)) return 'directions';
  if (/skroutz\.gr/i.test(href)) return 'skroutz';
  if (/instagram\.com/i.test(href)) return 'instagram';
  return null;
}
