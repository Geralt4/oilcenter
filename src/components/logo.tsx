import Image from 'next/image';
import mark from './logo-artwork.jpg';
import { cn } from '@/lib/utils';

/** The Oilcenter.gr artwork, as a rounded square. */
export function LogoMark({ className }: { className?: string }) {
  return <Image src={mark} alt="" aria-hidden="true" sizes="40px" className={cn('rounded-[25%] object-cover', className)} />;
}

export function Logo({ className, tone = 'dark', since }: { className?: string; tone?: 'dark' | 'light'; since?: number }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark className="h-10 w-10 shrink-0" />
      <span className="flex flex-col leading-none">
        <span className={cn('font-display text-[1.625rem] font-extrabold tracking-tight uppercase', tone === 'dark' ? 'text-ink-900' : 'text-white')}>
          Oil<span className="text-oil-500">·</span>Center
        </span>
        <span className={cn('mt-0.5 whitespace-nowrap text-[0.625rem] font-semibold tracking-[0.26em] uppercase', tone === 'dark' ? 'text-ink-500' : 'text-ink-300')}>
          Τσακιρίδης{since ? <> <span className="text-oil-500">·</span> <span className="max-sm:hidden">από το </span>{since}</> : null}
        </span>
      </span>
    </span>
  );
}

export function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <path d="M17.5 6.5h.01" />
    </svg>
  );
}
