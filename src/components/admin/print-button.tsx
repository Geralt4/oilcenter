'use client';

import { Printer } from 'lucide-react';

export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-ink-200 bg-white px-3.5 text-sm font-semibold text-ink-900 hover:bg-ink-50 print:hidden">
      <Printer className="h-4 w-4" />
      Εκτύπωση
    </button>
  );
}
