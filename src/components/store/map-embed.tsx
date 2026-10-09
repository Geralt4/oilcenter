'use client';

import { useState, useSyncExternalStore } from 'react';
import { MapPin } from 'lucide-react';

const KEY = 'oilcenter-map';
const subscribe = () => () => {};
const readChoice = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * The Google map, loaded only when the visitor asks for it: an embedded map makes the browser talk to Google (IP
 * address, possibly cookies) before anyone has agreed to that. Until then the box shows the address and one button.
 * The choice is remembered on this device, so the map simply appears on the next page.
 */
export function MapEmbed({ src, title, address }: { src: string; title: string; address: string }) {
  // server + hydration render "not chosen" (the placeholder); the client then reads the real value
  const remembered = useSyncExternalStore(subscribe, readChoice, () => false);
  const [shown, setShown] = useState(false);

  if (remembered || shown) {
    return <iframe title={title} src={src} loading="lazy" referrerPolicy="no-referrer-when-downgrade" allowFullScreen className="absolute inset-0 h-full w-full border-0" />;
  }
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-oil-700 shadow-tile">
        <MapPin className="h-6 w-6" />
      </span>
      <p className="max-w-xs font-semibold text-ink-900">{address}</p>
      <button
        type="button"
        onClick={() => {
          try {
            localStorage.setItem(KEY, '1');
          } catch {
            /* private mode: show it for this page only */
          }
          setShown(true);
        }}
        className="h-11 cursor-pointer rounded-xl bg-ink-900 px-5 text-sm font-semibold text-white hover:bg-ink-700"
      >
        Εμφάνιση χάρτη
      </button>
      <p className="max-w-xs text-xs text-ink-600">Ο χάρτης φορτώνεται από την Google Maps μόνο αφού το ζητήσετε.</p>
    </div>
  );
}
