'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, Check, Heart, Phone, ShoppingCart } from 'lucide-react';
import { AvailabilityTag } from '@/components/store/availability';
import { useStoreConfig } from '@/components/store/store-context';
import type { CatalogProduct } from '@/lib/catalog';
import { useCart, useHydrated, useWishlist } from '@/lib/cart-store';
import { cn, formatPrice, telHref } from '@/lib/utils';

/**
 * Rendered width of a card's image, for a grid that has the row to itself: the home page, related products and the
 * wishlist. Two cards to a row, then three from 640, then four from 1280; above 1376 the page container stops growing
 * and 320 px is as wide as the image ever gets. A listing with the filters beside it hands ProductGrid its own string.
 */
const GRID_IMAGE_SIZES = '(min-width: 1280px) 320px, (min-width: 640px) 33vw, 50vw';

export function ProductCard({ product, priority = false, sizes = GRID_IMAGE_SIZES }: { product: CatalogProduct; priority?: boolean; sizes?: string }) {
  // open on a size that can actually be bought — on the shelf if possible — and with a confirmed price
  const firstAvailable = product.variants.find((v) => v.availability === 'in_stock' && v.priced) ?? product.variants.find((v) => v.inStock && v.priced) ?? product.variants.find((v) => v.inStock) ?? product.variants[0];
  const { phone, canOrder } = useStoreConfig();
  const [variantId, setVariantId] = useState(firstAvailable.id);
  const [justAdded, setJustAdded] = useState(false);
  const variant = product.variants.find((v) => v.id === variantId) ?? firstAvailable;

  const add = useCart((s) => s.add);
  const hydrated = useHydrated();
  const wished = useWishlist((s) => s.ids.includes(product.id));
  const toggleWish = useWishlist((s) => s.toggle);

  const image = variant.imageUrl ?? product.imageUrl;
  const href = `/product/${product.slug}`;
  const discount = variant.compareAtCents ? Math.round((1 - variant.priceCents / variant.compareAtCents) * 100) : 0;

  const onAdd = () => {
    add(variant.id, {
      productId: product.id,
      slug: product.slug,
      name: product.name,
      brandName: product.brand?.name ?? null,
      variantLabel: variant.label,
      imageUrl: image,
      unitPriceCents: variant.priceCents,
      weightGrams: variant.weightGrams,
      maxQuantity: variant.stockLeft,
      availability: variant.availability,
    });
    setJustAdded(true);
    setTimeout(() => setJustAdded(false), 1600);
  };

  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-tile transition-[box-shadow,transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-ink-200 hover:shadow-lift">
      <div className="relative">
        <Link href={href} tabIndex={-1} aria-hidden="true" className="relative block aspect-square overflow-hidden bg-white">
          {image && (
            <Image
              src={image}
              alt=""
              fill
              priority={priority}
              sizes={sizes}
              className="object-contain p-3 transition-transform duration-300 group-hover:scale-[1.04] sm:p-5"
            />
          )}
        </Link>

        <div className="pointer-events-none absolute top-3 left-3 flex flex-col items-start gap-1.5">
          {discount > 0 && <span className="tabular rounded-md bg-red-600 px-2 py-1 text-xs font-bold text-white">−{discount}%</span>}
          {product.viscosity && <span className="tabular rounded-md bg-ink-900 px-2 py-1 font-display text-sm font-bold tracking-wide text-oil-300">{product.viscosity}</span>}
        </div>

        <button
          type="button"
          onClick={() => toggleWish(product.id)}
          aria-pressed={hydrated && wished}
          aria-label={hydrated && wished ? 'Αφαίρεση από τα αγαπημένα' : 'Προσθήκη στα αγαπημένα'}
          className="absolute top-2 right-2 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-white/90 text-ink-400 shadow-sm backdrop-blur transition-colors hover:text-red-500"
        >
          <Heart className={cn('h-[1.125rem] w-[1.125rem]', hydrated && wished && 'fill-red-500 text-red-500')} />
        </button>

        {!product.inStock && (
          <span className="absolute inset-x-3 bottom-3 rounded-lg bg-ink-900/85 py-1.5 text-center text-xs font-semibold text-white backdrop-blur">Προσωρινά μη διαθέσιμο</span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 border-t border-line p-3 sm:p-4">
        {product.brand && <p className="eyebrow text-[0.6875rem] text-ink-400">{product.brand.name}</p>}
        <h3 className="line-clamp-2 min-h-[2.6em] text-[0.9375rem] leading-snug font-semibold text-ink-900">
          <Link href={href} className="after:absolute after:inset-0 after:z-0 hover:text-oil-700">
            {product.name}
          </Link>
        </h3>

        {product.variants.length > 1 && (
          <div role="radiogroup" aria-label="Συσκευασία" className="relative z-10 flex flex-wrap gap-1.5">
            {product.variants.map((v) => (
              <button
                key={v.id}
                type="button"
                role="radio"
                aria-checked={v.id === variant.id}
                disabled={!v.inStock}
                onClick={() => setVariantId(v.id)}
                className={cn(
                  'tabular h-8 min-w-11 cursor-pointer rounded-lg border px-2 text-xs font-semibold transition-colors',
                  v.id === variant.id ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-700 hover:border-ink-500',
                  !v.inStock && 'cursor-not-allowed border-dashed text-ink-300 line-through hover:border-ink-200',
                )}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}

        {/*
          * The footer answers to the card, not to the viewport: the grid below puts the same card anywhere between
          * 112 px wide (two-up on a small phone) and 358 px (home page), and it is not the wider viewport that makes
          * the wider card — a column is added instead, and next to the filters one is taken away again. 14rem is where
          * the widest state of the button — «Προστέθηκε», 142 px — still fits beside the longest price and the gap;
          * below it the label is dropped and the button is the icon alone. flex-wrap is the last resort for the
          * narrowest cards, where not even that fits.
          */}
        <div className="@container relative z-10 mt-auto flex flex-wrap items-end gap-2 pt-1">
          {/* flex-1, so a long availability note wraps inside this column instead of pushing the button onto its own line */}
          <div className="flex-1 leading-tight">
            {variant.priced ? (
              <>
                {variant.compareAtCents && <p className="tabular text-xs text-ink-400 line-through">{formatPrice(variant.compareAtCents)}</p>}
                <p className="tabular text-lg font-bold text-ink-950 sm:text-xl">{formatPrice(variant.priceCents)}</p>
              </>
            ) : (
              <p className="text-[0.9375rem] font-semibold text-petrol-500">Καλέστε για τιμή</p>
            )}
            {product.variants.length === 1 && <p className="text-xs text-ink-500">{variant.label}</p>}
            {/* says nothing for a size that is on the shelf; a wait is worth a line */}
            {variant.priced && variant.inStock && <AvailabilityTag availability={variant.availability} className="mt-0.5" />}
          </div>
          {!variant.priced ? (
            <a
              href={telHref(phone)}
              aria-label={`Καλέστε για την τιμή: ${product.name} ${variant.label}`}
              className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-ink-900 text-white hover:bg-ink-700 @min-[14rem]:w-auto @min-[14rem]:gap-2 @min-[14rem]:px-4"
            >
              <Phone className="h-5 w-5" />
              <span className="hidden text-sm font-semibold @min-[14rem]:inline">Κλήση</span>
            </a>
          ) : !canOrder ? (
            // catalogue mode: nothing to add to — the card leads to the product, where the phone and the shop's address are
            <Link
              href={href}
              aria-label={`Δείτε το προϊόν: ${product.name}`}
              className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-ink-900 text-white hover:bg-ink-700 @min-[14rem]:w-auto @min-[14rem]:gap-2 @min-[14rem]:px-4"
            >
              <span className="hidden text-sm font-semibold @min-[14rem]:inline">Δείτε το</span>
              <ArrowRight className="h-5 w-5" />
            </Link>
          ) : (
          <button
            type="button"
            onClick={onAdd}
            disabled={!variant.inStock}
            aria-label={`Προσθήκη στο καλάθι: ${product.name} ${variant.label}`}
            className={cn(
              'ml-auto flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl transition-colors disabled:cursor-not-allowed disabled:bg-ink-100 disabled:text-ink-300 @min-[14rem]:w-auto @min-[14rem]:gap-2 @min-[14rem]:px-4',
              justAdded ? 'bg-emerald-600 text-white' : 'bg-oil-500 text-ink-950 hover:bg-oil-400',
            )}
          >
            {justAdded ? <Check className="h-5 w-5" /> : <ShoppingCart className="h-5 w-5" />}
            <span className="hidden text-sm font-semibold @min-[14rem]:inline">{justAdded ? 'Προστέθηκε' : 'Καλάθι'}</span>
          </button>
          )}
        </div>
      </div>
    </article>
  );
}

export function ProductGrid({ products, priorityCount = 0, sizes }: { products: CatalogProduct[]; priorityCount?: number; sizes?: string }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:gap-5 xl:grid-cols-4">
      {products.map((p, i) => (
        <ProductCard key={p.id} product={p} priority={i < priorityCount} sizes={sizes} />
      ))}
    </div>
  );
}
