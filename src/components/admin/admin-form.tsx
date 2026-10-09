'use client';

import { useEffect } from 'react';
import { LoaderCircle, Save } from 'lucide-react';
import { buttonClass } from '@/components/ui/button';
import { useKeptForm } from '@/components/ui/use-kept-form';
import { cn } from '@/lib/utils';

export type AdminFormState = { ok: boolean; message: string; fieldErrors?: Record<string, string> } | null;

type Props = {
  action: (prev: AdminFormState, formData: FormData) => Promise<AdminFormState>;
  children: React.ReactNode;
  submitLabel?: string;
  className?: string;
  /** clear the inputs after a successful submit ("add new …" forms) */
  resetOnSuccess?: boolean;
  /** pin the save bar to the bottom of the viewport (long forms) */
  stickyBar?: boolean;
  variant?: 'primary' | 'dark' | 'outline';
  size?: 'sm' | 'md';
};

/** Wraps server-rendered fields with pending / success / error feedback for a server action. */
export function AdminForm({ action, children, submitLabel = 'Αποθήκευση', className, resetOnSuccess, stickyBar, variant = 'primary', size = 'md' }: Props) {
  // the fields keep what the owner typed when a save is refused (useKeptForm); "add new …" forms empty themselves on success
  const { state, pending, formRef, formAction, onSubmit } = useKeptForm<AdminFormState>(action, null);
  useEffect(() => {
    if (state?.ok && resetOnSuccess) formRef.current?.reset();
  }, [state, resetOnSuccess, formRef]);

  return (
    <form ref={formRef} action={formAction} onSubmit={onSubmit} className={className}>
      {children}
      <div className={cn('flex flex-wrap items-center gap-3', stickyBar ? 'sticky bottom-0 z-10 -mx-4 mt-6 border-t border-line bg-white/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6' : 'mt-4')}>
        <button type="submit" disabled={pending} className={buttonClass({ variant, size })}>
          {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {submitLabel}
        </button>
        {state && <p role={state.ok ? 'status' : 'alert'} className={cn('text-sm font-medium', state.ok ? 'text-emerald-700' : 'text-red-700')}>{state.message}</p>}
      </div>
    </form>
  );
}

/** A submit button that asks first. For destructive plain-form actions. */
export function ConfirmButton({ message, children, className, name, value, title }: { message: string; children: React.ReactNode; className?: string; name?: string; value?: string; title?: string }) {
  return (
    <button
      type="submit"
      name={name}
      value={value}
      title={title}
      aria-label={title}
      className={className}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
