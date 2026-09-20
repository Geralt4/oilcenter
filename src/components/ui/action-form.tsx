'use client';

import { useActionState } from 'react';
import { CircleCheck, LoaderCircle } from 'lucide-react';
import { buttonClass } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type ActionFormState = { ok: boolean; message: string; fieldErrors?: Record<string, string> } | null;

export type FieldSpec = {
  name: string;
  label: string;
  type?: string;
  autoComplete?: string;
  inputMode?: 'text' | 'email' | 'tel' | 'numeric' | 'decimal';
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  /** tailwind col-span for the 2-column grid */
  wide?: boolean;
};

type Props = {
  action: (prev: ActionFormState, formData: FormData) => Promise<ActionFormState>;
  fields: FieldSpec[];
  submitLabel: string;
  hidden?: Record<string, string>;
  variant?: 'primary' | 'dark';
  /** keep the form visible after a successful save (profile) instead of replacing it with the message */
  stayOnSuccess?: boolean;
  children?: React.ReactNode;
};

/** Small declarative form bound to a server action. Used for auth and profile screens. */
export function ActionForm({ action, fields, submitLabel, hidden, variant = 'primary', stayOnSuccess, children }: Props) {
  const [state, formAction, pending] = useActionState<ActionFormState, FormData>(action, null);

  if (state?.ok && !stayOnSuccess) {
    return (
      <div role="status" className="rounded-2xl bg-emerald-50 p-6 text-center">
        <CircleCheck className="mx-auto h-9 w-9 text-emerald-600" />
        <p className="mt-3 font-medium text-emerald-950">{state.message}</p>
      </div>
    );
  }

  return (
    <form action={formAction} noValidate className="grid gap-4 sm:grid-cols-2">
      {state && <p role={state.ok ? 'status' : 'alert'} className={cn('rounded-2xl border p-3 text-sm font-medium sm:col-span-2', state.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800')}>{state.message}</p>}
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {fields.map((f) => {
        const error = state?.fieldErrors?.[f.name];
        return (
          <div key={f.name} className={cn(f.wide !== false && 'sm:col-span-2')}>
            <label htmlFor={`af-${f.name}`} className="label">{f.label}</label>
            <input id={`af-${f.name}`} name={f.name} type={f.type ?? 'text'} inputMode={f.inputMode} autoComplete={f.autoComplete} defaultValue={f.defaultValue} required={f.required} placeholder={f.placeholder} aria-invalid={Boolean(error)} className="field" />
            {f.hint && !error && <p className="mt-1.5 text-xs text-ink-500">{f.hint}</p>}
            {error && <p className="mt-1.5 text-sm font-medium text-red-600">{error}</p>}
          </div>
        );
      })}
      {children && <div className="sm:col-span-2">{children}</div>}
      <div className="sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonClass({ variant, size: 'lg', full: true })}>
          {pending && <LoaderCircle className="h-5 w-5 animate-spin" />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
