'use client';

import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Availability } from '@/lib/availability';
import { track } from '@/lib/track';

/*
 * The cart lives in the browser (localStorage) as {variantId, quantity} pairs.
 * Each line also keeps a display snapshot so the drawer paints instantly; the snapshot is
 * refreshed from /api/cart and is NEVER trusted for money — checkout re-prices on the server.
 */

export type CartSnapshot = {
  productId: number;
  slug: string;
  name: string;
  brandName: string | null;
  variantLabel: string;
  imageUrl: string | null;
  unitPriceCents: number;
  weightGrams: number;
  maxQuantity: number | null;
  /** missing on carts saved before availability labels existed; the server fills it in on the next sync */
  availability?: Availability;
};

export type CartLine = { variantId: number; quantity: number; snapshot: CartSnapshot };

type CartState = {
  lines: CartLine[];
  couponCode: string | null;
  isOpen: boolean;
  /** variantId of the line that was just added, for the drawer's highlight */
  lastAdded: number | null;
  add: (variantId: number, snapshot: CartSnapshot, quantity?: number) => void;
  setQuantity: (variantId: number, quantity: number) => void;
  remove: (variantId: number) => void;
  clear: () => void;
  setCoupon: (code: string | null) => void;
  open: () => void;
  close: () => void;
  syncSnapshots: (fresh: Array<{ variantId: number; quantity: number; snapshot: CartSnapshot | null }>) => void;
};

const clampQty = (qty: number, max: number | null) => Math.max(1, Math.min(qty, max ?? 999, 999));

/**
 * Throwing on the server makes zustand skip persistence there. Node ≥ 25 ships an experimental
 * global `localStorage`, so a bare `() => localStorage` would otherwise be touched during SSR.
 */
const browserStorage = () => {
  if (typeof window === 'undefined') throw new Error('no browser storage during SSR');
  return window.localStorage;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isWholeNumber = (value: unknown, min: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min;

/**
 * What an older (or damaged) saved cart is turned into when the stored version differs from the current one. Without a
 * `migrate`, zustand drops the whole saved state on a version change: a customer's cart would vanish with the next bump.
 * Keeps the lines that are still well-formed (whole variant id, quantity of at least 1, a snapshot with what the drawer
 * paints) and the coupon code; everything else is left out. Prices in a snapshot are display only, the server re-prices.
 */
export function sanitizeCartState(persisted: unknown): { lines: CartLine[]; couponCode: string | null } {
  const state = isRecord(persisted) ? persisted : {};
  const seen = new Set<number>();
  const lines: CartLine[] = [];
  for (const raw of Array.isArray(state.lines) ? state.lines : []) {
    if (!isRecord(raw) || !isWholeNumber(raw.variantId, 1) || !isWholeNumber(raw.quantity, 1) || !isRecord(raw.snapshot) || seen.has(raw.variantId)) continue;
    const s = raw.snapshot;
    if (!isWholeNumber(s.productId, 1) || typeof s.slug !== 'string' || typeof s.name !== 'string' || typeof s.variantLabel !== 'string' || !isWholeNumber(s.unitPriceCents, 0)) continue;
    seen.add(raw.variantId);
    lines.push({ variantId: raw.variantId, quantity: Math.min(raw.quantity, 999), snapshot: s as unknown as CartSnapshot });
  }
  return { lines, couponCode: typeof state.couponCode === 'string' && state.couponCode.trim() ? state.couponCode : null };
}

/** The same for the favourites: whole product ids only, each once. */
export function sanitizeWishlistState(persisted: unknown): { ids: number[] } {
  const ids = isRecord(persisted) && Array.isArray(persisted.ids) ? persisted.ids : [];
  return { ids: [...new Set(ids.filter((id): id is number => isWholeNumber(id, 1)))] };
}

export const useCart = create<CartState>()(
  persist(
    (set) => ({
      lines: [],
      couponCode: null,
      isOpen: false,
      lastAdded: null,

      add: (variantId, snapshot, quantity = 1) => {
        track({ t: 'cart', slug: snapshot.slug });
        set((state) => {
          const existing = state.lines.find((l) => l.variantId === variantId);
          const lines = existing
            ? state.lines.map((l) =>
                l.variantId === variantId ? { ...l, snapshot, quantity: clampQty(l.quantity + quantity, snapshot.maxQuantity) } : l,
              )
            : [...state.lines, { variantId, snapshot, quantity: clampQty(quantity, snapshot.maxQuantity) }];
          return { lines, isOpen: true, lastAdded: variantId };
        });
      },

      setQuantity: (variantId, quantity) =>
        set((state) => ({
          lines:
            quantity <= 0
              ? state.lines.filter((l) => l.variantId !== variantId)
              : state.lines.map((l) => (l.variantId === variantId ? { ...l, quantity: clampQty(quantity, l.snapshot.maxQuantity) } : l)),
        })),

      remove: (variantId) => set((state) => ({ lines: state.lines.filter((l) => l.variantId !== variantId) })),
      clear: () => set({ lines: [], couponCode: null, lastAdded: null }),
      setCoupon: (couponCode) => set({ couponCode }),
      open: () => set({ isOpen: true }),
      close: () => set({ isOpen: false, lastAdded: null }),

      syncSnapshots: (fresh) =>
        set((state) => {
          const byId = new Map(fresh.map((f) => [f.variantId, f]));
          const lines = state.lines.flatMap((l) => {
            const f = byId.get(l.variantId);
            if (!f) return [l];
            if (!f.snapshot || f.quantity <= 0) return []; // discontinued or sold out
            // the reply describes the cart as it was when the request left: keep any quantity changed since, only capped by fresh stock
            return [{ variantId: l.variantId, quantity: clampQty(l.quantity, f.snapshot.maxQuantity), snapshot: f.snapshot }];
          });
          return { lines };
        }),
    }),
    {
      name: 'oilcenter-cart',
      version: 1,
      migrate: (persisted) => sanitizeCartState(persisted),
      storage: createJSONStorage(browserStorage),
      partialize: (state) => ({ lines: state.lines, couponCode: state.couponCode }),
    },
  ),
);

/** localStorage is unknown during SSR; gate cart-dependent UI on this to avoid hydration mismatches. */
const noopSubscribe = () => () => {};
export function useHydrated(): boolean {
  // false on the server and during hydration, true afterwards — without an effect + extra state
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

export function cartCount(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.quantity, 0);
}

/** the lines as the coupon maths wants them */
export function cartCouponLines(lines: CartLine[]): Array<{ variantId: number; lineTotalCents: number }> {
  return lines.map((l) => ({ variantId: l.variantId, lineTotalCents: l.quantity * l.snapshot.unitPriceCents }));
}

export function cartSubtotalCents(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.quantity * l.snapshot.unitPriceCents, 0);
}

export function cartWeightGrams(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.quantity * (l.snapshot.weightGrams ?? 0), 0);
}

// ─── Wishlist (per device) ───────────────────────────────────────────────────
type WishlistState = {
  ids: number[];
  toggle: (productId: number) => void;
  has: (productId: number) => boolean;
};

export const useWishlist = create<WishlistState>()(
  persist(
    (set, get) => ({
      ids: [],
      toggle: (productId) =>
        set((state) => ({
          ids: state.ids.includes(productId) ? state.ids.filter((id) => id !== productId) : [...state.ids, productId],
        })),
      has: (productId) => get().ids.includes(productId),
    }),
    { name: 'oilcenter-wishlist', version: 1, migrate: (persisted) => sanitizeWishlistState(persisted), storage: createJSONStorage(browserStorage) },
  ),
);

// ─── Several tabs ────────────────────────────────────────────────────────────
/*
 * Each tab keeps its own copy of the stores and writes all of it back on every change: a tab that has not heard about
 * the other's additions would save its stale list over them (A added in one tab, B in another → only B survives).
 * The browser tells the OTHER tabs when localStorage changes; re-reading it keeps every tab current before it writes.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === 'oilcenter-cart') void useCart.persist.rehydrate();
    else if (event.key === 'oilcenter-wishlist') void useWishlist.persist.rehydrate();
  });
}
