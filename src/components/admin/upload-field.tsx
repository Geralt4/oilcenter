'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { beginUpload, endUpload } from '@/components/admin/upload-pending';

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
  // A new selection may begin before an older request resolves (the picker is disabled, but a
  // programmatic change, a dropped disabled attribute or a future UI change can still do it).
  // Only the newest selection may write tokens or messages; the counter keeps "busy" accurate
  // until every outstanding request has finished.
  const sequence = useRef(0);
  const active = useRef(0);

  // AdminForm calls form.reset() after a successful import; React state is not part of that reset,
  // so clear the pending tokens here. Without this the next import would submit an already-consumed
  // token first (and single-file fields would keep an old file). The "Καθαρισμός" button calls the same
  // thing: leaving the error text or a customValidity behind would keep an otherwise valid form blocked.
  const clear = useCallback(() => {
    setTokens([]);
    setProblem('');
    inputRef.current?.setCustomValidity('');
  }, []);

  useEffect(() => {
    const form = inputRef.current?.closest('form');
    if (!form) return;
    form.addEventListener('reset', clear);
    return () => form.removeEventListener('reset', clear);
  }, [clear]);

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
    const requestId = ++sequence.current;
    active.current += 1;
    setBusy(true);
    // Counted per FORM, not per field: photo and SDS uploads can overlap.
    if (form) beginUpload(form);
    try {
      const added: string[] = [];
      for (const file of files) {
        const res = await fetch(`/api/admin/upload?kind=${encodeURIComponent(kind)}`, {
          method: 'POST',
          // The filename is UTF-8 metadata: encode it so Greek names survive HTTP header rules.
          headers: { 'x-filename': encodeURIComponent(file.name.slice(0, 160)) },
          body: file,
        });
        const body = (await res.json().catch(() => null)) as { token?: string; error?: string } | null;
        if (!res.ok || !body?.token) throw new Error(body?.error ?? `upload_${res.status}`);
        added.push(body.token);
      }
      // A single-file field replaces the previous selection; a multi-file field adds to it.
      if (requestId === sequence.current) {
        setTokens((current) => (multiple ? [...current, ...added] : added));
        input.value = '';
      }
    } catch {
      if (requestId === sequence.current) {
        input.setCustomValidity('Το ανέβασμα απέτυχε. Δοκιμάστε ξανά.');
        setProblem('Το ανέβασμα απέτυχε. Ελέγξτε τη σύνδεση και δοκιμάστε ξανά — δεν αποθηκεύτηκε τίποτα.');
        // Clear the picker so choosing the same file again fires another change event.
        input.value = '';
      }
    } finally {
      active.current = Math.max(0, active.current - 1);
      if (active.current === 0) setBusy(false);
      if (form) endUpload(form);
    }
  }

  return (
    <div>
      <input ref={inputRef} type="file" accept={accept} multiple={multiple} disabled={busy} aria-busy={busy} onChange={upload} aria-invalid={Boolean(problem)} className={className} />
      {tokens.map((token) => (
        <input key={token} type="hidden" name={name} value={token} />
      ))}
      {busy && <p role="status" className="mt-2 text-sm font-medium text-ink-600">Ανεβαίνει… παρακαλώ περιμένετε.</p>}
      {problem && <p role="alert" className="mt-2 text-sm font-medium text-red-700">{problem}</p>}
      {!busy && tokens.length > 0 && (
        <p className="mt-2 text-xs text-ink-500">
          {tokens.length} {what} έτοιμα για αποθήκευση.{' '}
          <button type="button" className="font-semibold text-petrol-500 underline underline-offset-2" onClick={clear}>
            Καθαρισμός
          </button>
        </p>
      )}
    </div>
  );
}
