'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, Check, Heart, Phone, ShieldCheck, ShoppingCart, Store, Truck } from 'lucide-react';
import { QuantityStepper } from '@/components/store/quantity-stepper';
import { useStoreConfig } from '@/components/store/store-context';
import { AVAILABILITY_HINTS, AVAILABILITY_HINTS_IN_STORE, AVAILABILITY_LABELS, AVAILABILITY_TONE, type Availability } from '@/lib/availability';
import { useCart, useHydrated, useWishlist } from '@/lib/cart-store';
import { courierRateCents } from '@/lib/pricing';
import { cn, formatPrice, formatWeight, telHref } from '@/lib/utils';

export type ViewVariant = {
  id: number;
  sku: string;
  label: string;
  volumeMl: number | null;
  priceCents: number;
  compareAtCents: number | null;
  availability: Availability;
  /** can be bought (anything but 'unavailable') */
  inStock: boolean;
  stockLeft: number | null;
  imageUrl: string | null;
  weightGrams: number;
  /** false = placeholder price the owner has not confirmed yet */
  priceVerified: boolean;
};

type Props = {
  product: { id: number; slug: string; name: string; brandName: string | null; shortDescription: string | null };
  images: Array<{ url: string; alt: string | null }>;
  variants: ViewVariant[];
  /** pack size asked for in the URL (?v=), e.g. by a link from the Skroutz feed */
  initialVariantId?: number | null;
};

export function ProductView({ product, images, variants, initialVariantId }: Props) {
  const config = useStoreConfig();
  // open on a size that is on the shelf and priced, if there is one
  const initial = variants.find((v) => v.id === initialVariantId) ?? variants.find((v) => v.availability === 'in_stock' && v.priceVerified) ?? variants.find((v) => v.inStock && v.priceVerified) ?? variants.find((v) => v.inStock) ?? variants[0];
  const [variantId, setVariantId] = useState(initial.id);
  const [activeImage, setActiveImage] = useState(initial.imageUrl ?? images[0]?.url ?? null);
  const [quantity, setQuantity] = useState(1);
  const [justAdded, setJustAdded] = useState(false);

  const add = useCart((s) => s.add);
  const hydrated = useHydrated();
  const wished = useWishlist((s) => s.ids.includes(product.id));
  const toggleWish = useWishlist((s) => s.toggle);

  const variant = variants.find((v) => v.id === variantId) ?? initial;
  const discount = variant.compareAtCents ? Math.round((1 - variant.priceCents / variant.compareAtCents) * 100) : 0;
  const perLitre = variant.volumeMl && variant.volumeMl >= 1000 ? Math.round(variant.priceCents / (variant.volumeMl / 1000)) : null;
  const lowStock = variant.stockLeft !== null && variant.stockLeft > 0 && variant.stockLeft <= config.lowStockThreshold;

  const lineTotal = variant.priceCents * quantity;
  const lineWeight = variant.weightGrams * quantity;
  const { shipping } = config;
  const hints = config.canOrder ? AVAILABILITY_HINTS : AVAILABILITY_HINTS_IN_STORE;
  const freeShipping = shipping.freeOverCents > 0 && lineTotal >= shipping.freeOverCents && (shipping.freeMaxWeightKg <= 0 || lineWeight <= shipping.freeMaxWeightKg * 1000);

  const selectVariant = (v: ViewVariant) => {
    setVariantId(v.id);
    setQuantity(1);
    if (v.imageUrl) setActiveImage(v.imageUrl);
  };

  const onAdd = () => {
    add(
      variant.id,
      {
        productId: product.id,
        slug: product.slug,
        name: product.name,
        brandName: product.brandName,
        variantLabel: variant.label,
        imageUrl: variant.imageUrl ?? images[0]?.url ?? null,
        unitPriceCents: variant.priceCents,
        weightGrams: variant.weightGrams,
        maxQuantity: variant.stockLeft,
        availability: variant.availability,
      },
      quantity,
    );
    setJustAdded(true);
    setTimeout(() => setJustAdded(false), 1800);
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[1.05fr_1fr] lg:gap-12">
      {/* ── Gallery ── */}
      <div className="lg:sticky lg:top-44 lg:self-start">
        <div className="relative aspect-square overflow-hidden rounded-3xl border border-line bg-white shadow-tile">
          {activeImage && <Image key={activeImage} src={activeImage} alt={`${product.brandName ?? ''} ${product.name}`.trim()} fill priority quality={85} sizes="(min-width: 1024px) 600px, 100vw" className="animate-fade-in object-contain p-6 sm:p-10" />}
          {discount > 0 && <span className="tabular absolute top-4 left-4 rounded-lg bg-red-600 px-2.5 py-1.5 text-sm font-bold text-white">−{discount}%</span>}
        </div>
        {images.length > 1 && (
          <ul className="no-scrollbar mt-3 flex gap-2 overflow-x-auto pb-1">
            {images.map((img) => (
              <li key={img.url} className="shrink-0">
                <button
                  type="button"
                  onClick={() => setActiveImage(img.url)}
                  aria-label="Προβολή φωτογραφίας"
                  aria-pressed={img.url === activeImage}
                  className={cn('relative block h-20 w-20 cursor-pointer overflow-hidden rounded-xl border-2 bg-white transition-colors', img.url === activeImage ? 'border-oil-500' : 'border-line hover:border-ink-300')}
                >
                  <Image src={img.url} alt="" fill sizes="80px" className="object-contain p-1.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Purchase panel ── */}
      <div>
        {product.brandName && <p className="eyebrow text-oil-700">{product.brandName}</p>}
        <h1 className="mt-1 text-3xl leading-tight font-bold tracking-tight text-ink-950 sm:text-4xl">{product.name}</h1>
        {product.shortDescription && <p className="mt-3 text-lg text-ink-600">{product.shortDescription}</p>}

        {variant.priceVerified ? (
          <div className="mt-6 flex flex-wrap items-end gap-x-3 gap-y-1">
            <p className="tabular text-4xl font-bold text-ink-950">{formatPrice(variant.priceCents)}</p>
            {variant.compareAtCents && <p className="tabular pb-1 text-lg text-ink-500 line-through">{formatPrice(variant.compareAtCents)}</p>}
            <p className="pb-1.5 text-sm text-ink-500">
              με ΦΠΑ{perLitre && variant.volumeMl !== 1000 ? <> · <span className="tabular">{formatPrice(perLitre)}</span> / λίτρο</> : null}
            </p>
          </div>
        ) : (
          // the owner has not confirmed this price yet (Admin → Τιμές): the placeholder never reaches the browser
          <div className="mt-6">
            <p className="text-3xl font-bold text-petrol-500">Καλέστε για τιμή</p>
            <p className="mt-1 text-sm text-ink-600">Η τιμή αυτής της συσκευασίας ενημερώνεται. Πάρτε μας ένα τηλέφωνο και θα σας την πούμε αμέσως.</p>
          </div>
        )}

        {variants.length > 1 && (
          <fieldset className="mt-7">
            <legend className="label">Συσκευασία</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {variants.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => selectVariant(v)}
                  disabled={!v.inStock}
                  aria-pressed={v.id === variant.id}
                  className={cn(
                    'cursor-pointer rounded-xl border-2 p-3 text-left transition-colors',
                    v.id === variant.id ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 bg-white text-ink-900 hover:border-ink-500',
                    !v.inStock && 'cursor-not-allowed border-dashed opacity-50 hover:border-ink-200',
                  )}
                >
                  <span className="tabular block font-display text-xl font-bold">{v.label}</span>
                  <span className={cn('tabular text-sm', v.id === variant.id ? 'text-oil-300' : 'text-ink-500')}>{!v.inStock ? 'Μη διαθέσιμο' : v.priceVerified ? formatPrice(v.priceCents) : 'Καλέστε'}</span>
                </button>
              ))}
            </div>
          </fieldset>
        )}

        <div className="mt-7 flex flex-wrap items-stretch gap-3">
          {/* catalogue mode (ordering closed): the way to buy is the phone, exactly as for a size without a confirmed price */}
          {variant.priceVerified && config.canOrder ? (
            <>
              <QuantityStepper value={quantity} onChange={setQuantity} max={variant.stockLeft} />
              <button
                type="button"
                onClick={onAdd}
                disabled={!variant.inStock}
                className={cn(
                  'flex h-12 min-w-52 flex-1 cursor-pointer items-center justify-center gap-2.5 rounded-xl px-6 text-base font-semibold transition-colors disabled:cursor-not-allowed disabled:bg-ink-100 disabled:text-ink-500',
                  justAdded ? 'bg-emerald-600 text-white' : 'bg-oil-500 text-ink-950 shadow-[0_8px_20px_-8px_rgb(242_163_11/0.8)] hover:bg-oil-400',
                )}
              >
                {justAdded ? <Check className="h-5 w-5" /> : <ShoppingCart className="h-5 w-5" />}
                {!variant.inStock ? 'Μη διαθέσιμο' : justAdded ? 'Προστέθηκε στο καλάθι' : `Προσθήκη · ${formatPrice(lineTotal)}`}
              </button>
            </>
          ) : (
            <a href={telHref(config.phone)} className="tabular flex h-12 min-w-52 flex-1 items-center justify-center gap-2.5 rounded-xl bg-ink-900 px-6 text-base font-semibold text-white hover:bg-ink-700">
              <Phone className="h-5 w-5" />
              {config.phone}
            </a>
          )}
          <button
            type="button"
            onClick={() => toggleWish(product.id)}
            aria-pressed={hydrated && wished}
            aria-label={hydrated && wished ? 'Αφαίρεση από τα αγαπημένα' : 'Προσθήκη στα αγαπημένα'}
            className="flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-ink-200 bg-white text-ink-500 hover:border-ink-400 hover:text-red-500"
          >
            <Heart className={cn('h-5 w-5', hydrated && wished && 'fill-red-500 text-red-500')} />
          </button>
        </div>

        {/* availability of the selected size: set by the owner per size, overridden by counted stock (lib/availability.ts) */}
        <div className="mt-3 text-sm">
          <p className={cn('flex items-center gap-2 font-medium', lowStock ? 'text-amber-700' : AVAILABILITY_TONE[variant.availability].text)}>
            <span className={cn('h-2 w-2 shrink-0 rounded-full', lowStock ? 'bg-amber-500' : AVAILABILITY_TONE[variant.availability].dot)} />
            {lowStock ? `Τελευταία ${variant.stockLeft} τεμάχια` : AVAILABILITY_LABELS[variant.availability]}
          </p>
          {!lowStock && hints[variant.availability] && <p className="mt-1 pl-4 text-ink-600">{hints[variant.availability]}</p>}
        </div>

        <ul className="mt-7 divide-y divide-line rounded-2xl border border-line bg-white text-sm">
          {config.canOrder && shipping.courierEnabled && (
            <li className="flex items-start gap-3 p-4">
              <Truck className="mt-0.5 h-5 w-5 shrink-0 text-oil-700" />
              <span>
                <strong className="font-semibold text-ink-900">Αποστολή με courier · {shipping.deliveryEstimate}</strong>
                <span className="block text-ink-600">
                  {freeShipping ? 'Δωρεάν μεταφορικά για αυτή την ποσότητα.' : <>Μεταφορικά <span className="tabular">{formatPrice(courierRateCents(lineWeight, shipping))}</span> ({formatWeight(lineWeight)}).</>}
                  {shipping.freeOverCents > 0 && !freeShipping && <> Δωρεάν άνω των <span className="tabular">{formatPrice(shipping.freeOverCents)}</span>.</>}
                </span>
              </span>
            </li>
          )}
          {config.canOrder && shipping.pickupEnabled && (
            <li className="flex items-start gap-3 p-4">
              <Store className="mt-0.5 h-5 w-5 shrink-0 text-oil-700" />
              <span>
                <strong className="font-semibold text-ink-900">Παραλαβή από το κατάστημα — δωρεάν</strong>
                <span className="block text-ink-600">Παραγγείλετε online και παραλάβετε όποτε σας βολεύει.</span>
              </span>
            </li>
          )}
          {!config.canOrder && (
            <li className="flex items-start gap-3 p-4">
              <Store className="mt-0.5 h-5 w-5 shrink-0 text-oil-700" />
              <span>
                <strong className="font-semibold text-ink-900">Θα το βρείτε στο κατάστημά μας</strong>
                <span className="block text-ink-600">{config.address}. Καλέστε μας για διαθεσιμότητα πριν περάσετε.</span>
              </span>
            </li>
          )}
          <li className="flex items-start gap-3 p-4">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-oil-700" />
            <span>
              <strong className="font-semibold text-ink-900">Γνήσιο προϊόν</strong>
              <span className="block text-ink-600">Απευθείας από επίσημους αντιπροσώπους{config.canOrder ? ', με δικαίωμα επιστροφής 14 ημερών' : ''}.</span>
            </span>
          </li>
        </ul>

        <div className="mt-4 rounded-2xl bg-ink-900 text-white">
          <a href={telHref(config.phone)} className="flex items-center gap-3 rounded-t-2xl p-4 transition-colors hover:bg-ink-800">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-oil-500 text-ink-950">
              <Phone className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block font-semibold">Δεν είστε σίγουροι αν ταιριάζει στο όχημά σας;</span>
              <span className="text-sm text-ink-300">Καλέστε μας στο <span className="tabular font-semibold text-oil-300">{config.phone}</span> και θα σας πούμε με σιγουριά.</span>
            </span>
          </a>
          <Link href={`/find-my-oil?product=${product.slug}`} className="flex items-center justify-between gap-3 rounded-b-2xl border-t border-white/10 px-4 py-3 text-sm font-semibold text-oil-300 transition-colors hover:bg-ink-800">
            ή στείλτε μας τα στοιχεία του οχήματος και σας καλούμε εμείς
            <ArrowRight className="h-4 w-4 shrink-0" />
          </Link>
        </div>

        <p className="tabular mt-4 text-xs text-ink-500">Κωδικός: {variant.sku}</p>
      </div>
    </div>
  );
}
