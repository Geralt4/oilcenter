import { cn } from '@/lib/utils';

type Variant = 'primary' | 'dark' | 'outline' | 'ghost' | 'danger' | 'light';
type Size = 'sm' | 'md' | 'lg';

const base =
  'inline-flex items-center justify-center gap-2 rounded-xl font-semibold whitespace-nowrap select-none ' +
  'transition-[background-color,border-color,color,box-shadow,transform] duration-150 active:scale-[0.98] ' +
  'disabled:pointer-events-none disabled:opacity-50 cursor-pointer';

const variants: Record<Variant, string> = {
  // amber is reserved for the action we most want taken on a screen
  primary: 'bg-oil-500 text-ink-950 hover:bg-oil-400 shadow-[0_1px_0_rgb(255_255_255/0.35)_inset,0_6px_16px_-6px_rgb(242_163_11/0.7)]',
  dark: 'bg-ink-900 text-white hover:bg-ink-700',
  light: 'bg-white text-ink-900 hover:bg-ink-100',
  outline: 'border border-ink-200 bg-white text-ink-900 hover:border-ink-400 hover:bg-ink-50',
  ghost: 'text-ink-700 hover:bg-ink-100 hover:text-ink-900',
  danger: 'bg-red-600 text-white hover:bg-red-700',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3.5 text-sm',
  md: 'h-11 px-5 text-[0.9375rem]',
  lg: 'h-13 px-7 text-base',
};

/** Use on <Link> / <a> so navigation keeps link semantics but looks like a button. */
export function buttonClass(opts: { variant?: Variant; size?: Size; full?: boolean; className?: string } = {}) {
  const { variant = 'primary', size = 'md', full, className } = opts;
  return cn(base, variants[variant], sizes[size], full && 'w-full', className);
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  full?: boolean;
};

export function Button({ variant, size, full, className, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={buttonClass({ variant, size, full, className })} {...props} />;
}
