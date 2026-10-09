'use client';

import { useState } from 'react';

type Props = {
  name: string;
  accept: string;
  multiple?: boolean;
  /** how many files one save takes (omit for a single-file field) */
  maxFiles?: number;
  /** the most the selection may weigh, all files together */
  maxTotalMb: number;
  /** «φωτογραφίες», for the message */
  what?: string;
  className?: string;
};

/**
 * A file picker that says so BEFORE the upload when the selection is more than one request can carry. Past the
 * server's body limit (next.config.ts) the request is cut short and the save ends on the error page with everything
 * typed lost — and the server cannot produce a friendly message for a body it never received, so the check has to
 * happen here, in the browser. The server still checks every file it does receive (admin/actions.ts).
 */
export function FileInput({ name, accept, multiple, maxFiles, maxTotalMb, what = 'αρχεία', className }: Props) {
  const [problem, setProblem] = useState('');
  return (
    <>
      <input
        type="file"
        name={name}
        accept={accept}
        multiple={multiple}
        className={className}
        aria-invalid={Boolean(problem)}
        onChange={(event) => {
          const input = event.currentTarget;
          const files = [...(input.files ?? [])];
          const mb = files.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);
          const message =
            maxFiles && files.length > maxFiles
              ? `Έως ${maxFiles} ${what} τη φορά (επιλέξατε ${files.length}).`
              : mb > maxTotalMb
                ? `${files.length === 1 ? 'Το αρχείο είναι' : `Τα ${files.length} αρχεία μαζί είναι`} ${Math.ceil(mb)} MB· το όριο είναι ${maxTotalMb} MB τη φορά.${files.length > 1 ? ' Ανεβάστε τα σε δύο ή τρεις αποθηκεύσεις.' : ''}`
                : '';
          // the browser refuses to submit a form with an invalid field, and shows this text next to it
          input.setCustomValidity(message);
          setProblem(message);
        }}
      />
      {problem && <p role="alert" className="mt-2 text-sm font-medium text-red-700">{problem}</p>}
    </>
  );
}
