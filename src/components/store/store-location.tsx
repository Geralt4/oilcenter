import { Clock, Mail, MapPin, Navigation, Phone } from 'lucide-react';
import { buttonClass } from '@/components/ui/button';
import { DAY_NAMES, formatDayHours, fullAddress, mapsDirectionsUrl, mapsEmbedUrl, mapsPlaceUrl, openStatus, type ShopSettings } from '@/lib/settings';
import { cn, telHref } from '@/lib/utils';

/** Map + address + phones + opening hours. The single source of "how do I reach the shop". */
export function StoreLocation({ shop, className }: { shop: ShopSettings['shop']; className?: string }) {
  const status = openStatus(shop.hours);
  const todayIso = ((new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Athens' })).getDay() + 6) % 7) + 1;

  return (
    <div className={cn('grid overflow-hidden rounded-3xl border border-line bg-white shadow-tile lg:grid-cols-[1.15fr_1fr]', className)}>
      <div className="relative min-h-[20rem] bg-ink-100 lg:min-h-[28rem]">
        <iframe
          title={`Χάρτης: ${fullAddress(shop)}`}
          src={mapsEmbedUrl(shop)}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          allowFullScreen
          className="absolute inset-0 h-full w-full border-0"
        />
      </div>

      <div className="flex flex-col gap-6 p-6 sm:p-8">
        <div>
          <p className={cn('inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold', status.open ? 'bg-emerald-50 text-emerald-700' : 'bg-ink-100 text-ink-600')}>
            <span className={cn('h-2 w-2 rounded-full', status.open ? 'bg-emerald-500' : 'bg-ink-400')} />
            {status.label}
          </p>
          <h2 className="display mt-3 text-3xl sm:text-4xl">Ελάτε στο κατάστημα</h2>
          <a href={mapsPlaceUrl(shop)} target="_blank" rel="noopener noreferrer" className="mt-3 flex items-start gap-2.5 text-lg text-ink-700 hover:text-ink-950">
            <MapPin className="mt-1 h-5 w-5 shrink-0 text-oil-600" />
            <span>
              {shop.street}
              <br />
              {shop.postalCode} {shop.city}
            </span>
          </a>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <a href={telHref(shop.phone)} className={buttonClass({ size: 'lg', className: 'tabular' })}>
            <Phone className="h-5 w-5" />
            {shop.phone}
          </a>
          <a href={mapsDirectionsUrl(shop)} target="_blank" rel="noopener noreferrer" className={buttonClass({ variant: 'dark', size: 'lg' })}>
            <Navigation className="h-5 w-5" />
            Οδηγίες
          </a>
          {shop.mobile && (
            <a href={telHref(shop.mobile)} className={buttonClass({ variant: 'outline', className: 'tabular' })}>
              <Phone className="h-4 w-4" />
              {shop.mobile}
            </a>
          )}
          <a href={`mailto:${shop.email}`} className={buttonClass({ variant: 'outline', className: 'min-w-0' })}>
            <Mail className="h-4 w-4 shrink-0" />
            <span className="truncate">E-mail</span>
          </a>
        </div>

        <div>
          <h3 className="eyebrow flex items-center gap-2 text-ink-500">
            <Clock className="h-3.5 w-3.5" />
            Ωράριο λειτουργίας
          </h3>
          <dl className="mt-3 divide-y divide-line text-[0.9375rem]">
            {[...shop.hours]
              .sort((a, b) => a.day - b.day)
              .map((d) => (
                <div key={d.day} className={cn('flex justify-between gap-4 py-2', d.day === todayIso && 'font-semibold text-ink-950')}>
                  <dt>{DAY_NAMES[d.day - 1]}</dt>
                  <dd className={cn('tabular text-right', d.closed && 'text-ink-400')}>{formatDayHours(d)}</dd>
                </div>
              ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
