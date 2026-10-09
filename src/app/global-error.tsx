'use client';

import { useEffect } from 'react';

/*
 * Last resort: the root layout itself failed, so nothing of the site (styles, fonts, header) can be assumed.
 * Plain markup, in Greek, with the one thing a visitor can still do — call the shop.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="el">
      <body style={{ margin: 0, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem', fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', background: '#f7f6f2', color: '#11141a', textAlign: 'center' }}>
        <title>Προσωρινό πρόβλημα — Oil Center</title>
        <main style={{ maxWidth: '28rem' }}>
          <h1 style={{ fontSize: '1.75rem', margin: 0 }}>Κάτι πήγε στραβά</h1>
          <p style={{ marginTop: '0.75rem', lineHeight: 1.6, color: '#4b5563' }}>Η σελίδα δεν μπόρεσε να φορτώσει. Δοκιμάστε ξανά σε λίγο, ή καλέστε μας στο <a href="tel:+302310850778" style={{ color: '#11141a', fontWeight: 600 }}>2310 850778</a>.</p>
          <button type="button" onClick={reset} style={{ marginTop: '1.5rem', height: '3rem', padding: '0 1.5rem', border: 0, borderRadius: '0.75rem', background: '#11141a', color: '#fff', fontSize: '1rem', fontWeight: 600, cursor: 'pointer' }}>Δοκιμή ξανά</button>
          {error.digest && <p style={{ marginTop: '1rem', fontSize: '0.75rem', color: '#6b7280' }}>Κωδικός σφάλματος: {error.digest}</p>}
        </main>
      </body>
    </html>
  );
}
