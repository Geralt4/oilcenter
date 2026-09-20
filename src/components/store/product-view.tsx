'use client';

import Image from 'next/image';
import { useState } from 'react';
import { Check, Heart, Phone, ShieldCheck, ShoppingCart, Store, Truck } from 'lucide-react';
import { QuantityStepper } from '@/components/store/quantity-stepper';
import { useStoreConfig } from '@/components/store/store-context';
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
  inStock: boolean;
  stockLeft: number | null;
  imageUrl: string | null;
  weightGrams: number;
};

type Props = {
  product: { id: number; slug: string; name: string; brandName: string | null; shortDescription: string | null };
  images: Array<{ url: string; alt: string | null }>;
  variants: ViewVariant[];
};

export function ProductView({ product, images, variants }: Props) {
  const config = useStoreConfig();
  const initial = variants.find((v) => v.inStock) ?? variants[0];
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

        <div className="mt-6 flex flex-wrap items-end gap-x-3 gap-y-1">
          <p className="tabular text-4xl font-bold text-ink-950">{formatPrice(variant.priceCents)}</p>
          {variant.compareAtCents && <p className="tabular pb-1 text-lg text-ink-400 line-through">{formatPrice(variant.compareAtCents)}</p>}
          <p className="pb-1.5 text-sm text-ink-500">
            με ΦΠΑ{perLitre && variant.volumeMl !== 1000 ? <> · <span className="tabular">{formatPrice(perLitre)}</span> / λίτρο</> : null}
          </p>
        </div>
        {config.demoMode && <p className="mt-1 text-sm font-medium text-petrol-500">Ενδεικτική τιμή — καλέστε μας για την τρέχουσα τιμή.</p>}

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
                  <span className={cn('tabular text-sm', v.id === variant.id ? 'text-oil-300' : 'text-ink-500')}>{v.inStock ? formatPrice(v.priceCents) : 'Εξαντλήθηκε'}</span>
                </button>
              ))}
            </div>
          </fieldset>
        )}

        <div className="mt-7 flex flex-wrap items-stretch gap-3">
          <QuantityStepper value={quantity} onChange={setQuantity} max={variant.stockLeft} />
          <button
            type="button"
            onClick={onAdd}
            disabled={!variant.inStock}
            className={cn(
              'flex h-12 min-w-52 flex-1 cursor-pointer items-center justify-center gap-2.5 rounded-xl px-6 text-base font-semibold transition-colors disabled:cursor-not-allowed disabled:bg-ink-100 disabled:text-ink-400',
              justAdded ? 'bg-emerald-600 text-white' : 'bg-oil-500 text-ink-950 shadow-[0_8px_20px_-8px_rgb(242_163_11/0.8)] hover:bg-oil-400',
            )}
          >
            {justAdded ? <Check className="h-5 w-5" /> : <ShoppingCart className="h-5 w-5" />}
            {!variant.inStock ? 'Μη διαθέσιμο' : justAdded ? 'Προστέθηκε στο καλάθι' : `Προσθήκη · ${formatPrice(lineTotal)}`}
          </button>
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

        <p className={cn('mt-3 flex items-center gap-2 text-sm font-medium', variant.inStock ? (lowStock ? 'text-amber-700' : 'text-emerald-700') : 'text-red-600')}>
          <span className={cn('h-2 w-2 rounded-full', variant.inStock ? (lowStock ? 'bg-amber-500' : 'bg-emerald-500') : 'bg-red-500')} />
          {!variant.inStock ? 'Προσωρινά μη διαθέσιμο — καλέστε μας για ενημέρωση' : lowStock ? `Τελευταία ${variant.stockLeft} τεμάχια` : 'Άμεσα διαθέσιμο'}
        </p>

        <ul className="mt-7 divide-y divide-line rounded-2xl border border-line bg-white text-sm">
          {shipping.courierEnabled && (
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
          {shipping.pickupEnabled && (
            <li className="flex items-start gap-3 p-4">
              <Store className="mt-0.5 h-5 w-5 shrink-0 text-oil-700" />
              <span>
                <strong className="font-semibold text-ink-900">Παραλαβή από το κατάστημα — δωρεάν</strong>
                <span className="block text-ink-600">Παραγγείλετε online και παραλάβετε όποτε σας βολεύει.</span>
              </span>
            </li>
          )}
          <li className="flex items-start gap-3 p-4">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-oil-700" />
            <span>
              <strong className="font-semibold text-ink-900">Γνήσιο προϊόν</strong>
              <span className="block text-ink-600">Απευθείας από επίσημους αντιπροσώπους, με δικαίωμα επιστροφής 14 ημερών.</span>
            </span>
          </li>
        </ul>

        <a href={telHref(config.phone)} className="mt-4 flex items-center gap-3 rounded-2xl bg-ink-900 p-4 text-white transition-colors hover:bg-ink-800">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-oil-500 text-ink-950">
            <Phone className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block font-semibold">Δεν είστε σίγουροι αν ταιριάζει στο όχημά σας;</span>
            <span className="text-sm text-ink-300">Καλέστε μας στο <span className="tabular font-semibold text-oil-300">{config.phone}</span> και θα σας πούμε με σιγουριά.</span>
          </span>
        </a>

        <p className="tabular mt-4 text-xs text-ink-400">Κωδικός: {variant.sku}</p>
      </div>
    </div>
  );
}
