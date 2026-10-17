'use client';

import { useRef, useState } from 'react';

type Props = {
  /** hidden-field name the server action reads (one value per uploaded file) */
  name: string;
  kind: 'photo' | 'sds' | 'price-csv' | 'code-csv';
  accept: string;
  multiple?: boolean;
  maxFiles?: number;
  maxTotalMb: number;
  what?: string;
  className?: string;
};

/**
 * File picker that uploads immediately to /api/admin/upload and then contributes the returned
 * single-use tokens as hidden fields. The save/import action never receives the bytes themselves.
 *
 * While an upload is running the form's submit buttons are disabled; a failed upload blocks the
 * request with a visible message instead of silently saving without the file.
 */
export function UploadField({ name, kind, accept, multiple, maxFiles, maxTotalMb, what = 'αρχεία', className }: Props) {
  const [tokens, setTokens] = useState<string[]>([]);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];
    if (files.length === 0) return;

    const mb = files.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);
    const message =
      maxFiles && files.length > maxFiles
        ? `Έως ${maxFiles} ${what} τη φορά (επιλέξατε ${files.length}).`
        : mb > maxTotalMb
          ? `${files.length === 1 ? 'Το αρχείο είναι' : `Τα ${files.length} αρχεία μαζί είναι`} ${Math.ceil(mb)} MB· το όριο είναι ${maxTotalMb} MB.`
          : '';
    if (message) {
      input.setCustomValidity(message);
      setProblem(message);
      return;
    }
    input.setCustomValidity('');
    setProblem('');

    const form = input.closest('form');
    const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
    setBusy(true);
    if (submit) submit.disabled = true;
    try {
      const added: string[] = [];
      for (const file of files) {
        const res = await fetch(`/api/admin/upload?kind=${encodeURIComponent(kind)}`, {
          method: 'POST',
          headers: { 'x-filename': file.name },
          body: file,
        });
        const body = (await res.json().catch(() => null)) as { token?: string; error?: string } | null;
        if (!res.ok || !body?.token) throw new Error(body?.error ?? `upload_${res.status}`);
        added.push(body.token);
      }
      setTokens((current) => [...current, ...added]);
      input.value = '';
    } catch {
      input.setCustomValidity('Το ανέβασμα απέτυχε. Δοκιμάστε ξανά.');
      setProblem('Το ανέβασμα απέτυχε. Ελέγξτε τη σύνδεση και δοκιμάστε ξανά — δεν αποθηκεύτηκε τίποτα.');
    } finally {
      setBusy(false);
      if (submit) submit.disabled = false;
    }
  }

  return (
    <div>
      <input ref={inputRef} type="file" accept={accept} multiple={multiple} onChange={upload} aria-invalid={Boolean(problem)} className={className} />
      {tokens.map((token) => (
        <input key={token} type="hidden" name={name} value={token} />
      ))}
      {busy && <p role="status" className="mt-2 text-sm font-medium text-ink-600">Ανεβαίνει… παρακαλώ περιμένετε.</p>}
      {problem && <p role="alert" className="mt-2 text-sm font-medium text-red-700">{problem}</p>}
      {!busy && tokens.length > 0 && (
        <p className="mt-2 text-xs text-ink-500">
          {tokens.length} {what} έτοιμα για αποθήκευση.{' '}
          <button type="button" className="font-semibold text-petrol-500 underline underline-offset-2" onClick={() => setTokens([])}>
            Καθαρισμός
          </button>
        </p>
      )}
    </div>
  );
}
