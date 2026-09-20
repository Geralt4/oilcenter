'use client';

import { useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { buttonClass } from '@/components/ui/button';

/** A read-only value with a "copy" button — for addresses the owner has to paste somewhere else. */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // no clipboard permission (plain http, old browser): leave the text selected so Ctrl+C works
      input.current?.select();
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-wrap gap-2">
      <input ref={input} readOnly value={value} aria-label={label} onFocus={(e) => e.target.select()} className="field tabular h-11 min-w-0 flex-1 basis-64 bg-ink-50 text-sm" />
      <button type="button" onClick={copy} className={buttonClass({ variant: 'outline', size: 'md' })}>
        {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
        {copied ? 'Αντιγράφηκε' : 'Αντιγραφή'}
      </button>
    </div>
  );
}
