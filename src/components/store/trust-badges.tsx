import { Star } from 'lucide-react';
import type { ShopSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';

/*
 * What others say about the shop, and how long it has been around. Every figure is typed in by the owner exactly as
 * Google / Skroutz show it (Admin → Ρυθμίσεις → Κριτικές & ιστορία); whatever is empty is simply not rendered, and
 * each badge links to the platform's own page so the visitor can check it.
 *
 * Deliberately NOT repeated as aggregateRating in the JSON-LD: the reviews are not ours to republish, and Google
 * treats a business marking up ratings about itself as self-serving.
 */
type Props = { shop: ShopSettings['shop']; reviews: ShopSettings['reviews']; tone?: 'light' | 'dark'; className?: string };

const fmt = (n: number) => n.toLocaleString('el-GR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function trustItems(shop: ShopSettings['shop'], reviews: ShopSettings['reviews']) {
  const items: Array<{ key: string; rating?: number; text: string; href?: string }> = [];
  const count = (n: number) => (n > 0 ? ` · ${n.toLocaleString('el-GR')} ${n === 1 ? 'κριτική' : 'κριτικές'}` : '');
  if (reviews.googleRating > 0) items.push({ key: 'google', rating: reviews.googleRating, text: `στο Google${count(reviews.googleCount)}`, href: reviews.googleUrl || undefined });
  if (reviews.skroutzRating > 0) items.push({ key: 'skroutz', rating: reviews.skroutzRating, text: `στο Skroutz${count(reviews.skroutzCount)}`, href: shop.skroutzUrl || undefined });
  if (shop.foundedYear > 0) items.push({ key: 'since', text: `Από το ${shop.foundedYear}` });
  return items;
}

export function TrustBadges({ shop, reviews, tone = 'light', className }: Props) {
  const items = trustItems(shop, reviews);
  if (items.length === 0) return null;
  const chip = cn('inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium', tone === 'dark' ? 'border-white/15 bg-white/5 text-ink-200' : 'border-line bg-white text-ink-700');
  const strong = tone === 'dark' ? 'text-white' : 'text-ink-950';

  return (
    <ul className={cn('flex flex-wrap gap-2', className)}>
      {items.map((item) => {
        const body = (
          <>
            {item.rating !== undefined && (
              <>
                <Star className="h-4 w-4 fill-oil-500 text-oil-500" aria-hidden="true" />
                <span className={cn('tabular font-bold', strong)}>{fmt(item.rating)}</span>
              </>
            )}
            <span>{item.text}</span>
          </>
        );
        return (
          <li key={item.key}>
            {item.href ? (
              <a href={item.href} target="_blank" rel="noopener noreferrer" className={cn(chip, tone === 'dark' ? 'hover:border-oil-400 hover:text-white' : 'hover:border-ink-400')}>{body}</a>
            ) : (
              <span className={chip}>{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
