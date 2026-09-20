import { cn } from '@/lib/utils';

/** Oil drop with a specular highlight. Pure SVG so it stays crisp from favicon to hero. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="oc-drop" x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="#ffd566" />
          <stop offset="0.55" stopColor="#f2a30b" />
          <stop offset="1" stopColor="#c97605" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="10" fill="#11141a" />
      <path d="M20 6.5c4.9 6.3 9.6 11.1 9.6 16.7A9.6 9.6 0 0 1 20 32.8a9.6 9.6 0 0 1-9.6-9.6C10.4 17.6 15.1 12.8 20 6.5z" fill="url(#oc-drop)" />
      <path d="M15.2 23.6c0 2.7 1.9 4.9 4.4 5.4" fill="none" stroke="#fff" strokeOpacity="0.75" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ className, tone = 'dark' }: { className?: string; tone?: 'dark' | 'light' }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark className="h-10 w-10 shrink-0" />
      <span className="flex flex-col leading-none">
        <span className={cn('font-display text-[1.625rem] font-extrabold tracking-tight uppercase', tone === 'dark' ? 'text-ink-900' : 'text-white')}>
          Oil<span className="text-oil-500">·</span>Center
        </span>
        <span className={cn('mt-0.5 text-[0.625rem] font-semibold tracking-[0.26em] uppercase', tone === 'dark' ? 'text-ink-500' : 'text-ink-300')}>
          Τσακιρίδης
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

export function FacebookIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M13.5 21v-7.5h2.6l.4-3h-3V8.6c0-.9.3-1.5 1.6-1.5h1.6V4.4c-.3 0-1.2-.1-2.3-.1-2.3 0-3.9 1.4-3.9 4v2.2H8v3h2.5V21h3z" />
    </svg>
  );
}
