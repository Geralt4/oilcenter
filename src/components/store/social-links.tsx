import { Tag } from 'lucide-react';
import { FacebookIcon, InstagramIcon } from '@/components/logo';
import type { ShopSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';

type Shop = Pick<ShopSettings['shop'], 'facebookUrl' | 'instagramUrl' | 'skroutzUrl'>;

/** Only the profiles the owner has filled in under Admin → Ρυθμίσεις. Pure: safe to use from client components. */
export function socialProfiles(shop: Shop) {
  return [
    { key: 'instagram', name: 'Instagram', cta: 'Ακολουθήστε μας στο Instagram', href: shop.instagramUrl, Icon: InstagramIcon },
    { key: 'skroutz', name: 'Skroutz', cta: 'Βρείτε μας στο Skroutz', href: shop.skroutzUrl, Icon: Tag },
    { key: 'facebook', name: 'Facebook', cta: 'Ακολουθήστε μας στο Facebook', href: shop.facebookUrl, Icon: FacebookIcon },
  ].filter((p) => p.href);
}

type Props = {
  shop: Shop;
  /** `dark` sits on the steel footer, `light` on white cards, `bar` is the slim header strip */
  tone?: 'dark' | 'light' | 'bar';
  className?: string;
};

export function SocialLinks({ shop, tone = 'light', className }: Props) {
  const profiles = socialProfiles(shop);
  if (!profiles.length) return null;

  if (tone === 'bar') {
    return (
      <ul className={cn('flex items-center gap-3', className)}>
        {profiles.map(({ key, name, cta, href, Icon }) => (
          <li key={key}>
            <a href={href} target="_blank" rel="noopener noreferrer" title={cta} className="flex items-center gap-1.5 hover:text-white">
              <Icon className="h-3.5 w-3.5 text-oil-400" />
              {name}
            </a>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul className={cn('flex flex-wrap gap-2', className)}>
      {profiles.map(({ key, name, cta, href, Icon }) => (
        <li key={key}>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={cta}
            className={cn(
              'inline-flex h-11 items-center gap-2 rounded-xl px-4 text-sm font-semibold transition-colors',
              tone === 'dark' ? 'bg-white/10 text-white hover:bg-white/20' : 'border border-line bg-white text-ink-900 hover:border-ink-300 hover:bg-ink-50',
            )}
          >
            <Icon className={cn('h-4 w-4', tone === 'dark' ? 'text-oil-400' : 'text-oil-600')} />
            {name}
          </a>
        </li>
      ))}
    </ul>
  );
}
