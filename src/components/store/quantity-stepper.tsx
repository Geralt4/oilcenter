'use client';

import { Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

type Props = {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  /** null = unlimited */
  max?: number | null;
  size?: 'sm' | 'md';
  label?: string;
};

export function QuantityStepper({ value, onChange, min = 1, max = null, size = 'md', label = 'Ποσότητα' }: Props) {
  const cap = max ?? 999;
  const set = (n: number) => onChange(Math.max(min, Math.min(cap, Number.isFinite(n) ? Math.round(n) : min)));
  const box = size === 'sm' ? 'h-9' : 'h-12';
  const btn = size === 'sm' ? 'w-8' : 'w-11';

  return (
    <div role="group" aria-label={label} className={cn('inline-flex items-stretch overflow-hidden rounded-xl border border-ink-200 bg-white', box)}>
      <button type="button" onClick={() => set(value - 1)} disabled={value <= min} aria-label="Μείωση ποσότητας" className={cn('flex cursor-pointer items-center justify-center text-ink-700 hover:bg-ink-100 disabled:cursor-not-allowed disabled:opacity-35', btn)}>
        <Minus className="h-4 w-4" />
      </button>
      <input
        type="number"
        inputMode="numeric"
        value={value}
        min={min}
        max={cap}
        onChange={(e) => set(Number(e.target.value))}
        aria-label={label}
        className={cn('tabular border-x border-ink-200 bg-transparent text-center font-semibold text-ink-900 focus:outline-none', size === 'sm' ? 'w-10 text-sm' : 'w-14')}
      />
      <button type="button" onClick={() => set(value + 1)} disabled={value >= cap} aria-label="Αύξηση ποσότητας" className={cn('flex cursor-pointer items-center justify-center text-ink-700 hover:bg-ink-100 disabled:cursor-not-allowed disabled:opacity-35', btn)}>
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}
