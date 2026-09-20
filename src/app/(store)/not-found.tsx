import Link from 'next/link';
import { buttonClass } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="container-page flex min-h-[55vh] flex-col items-center justify-center py-16 text-center">
      <p className="display text-8xl text-oil-500">404</p>
      <h1 className="display mt-2 text-3xl sm:text-4xl">Η σελίδα δεν βρέθηκε</h1>
      <p className="mt-3 max-w-md text-ink-600">Ίσως το προϊόν άλλαξε όνομα ή δεν είναι πια διαθέσιμο. Δοκιμάστε την αναζήτηση ή δείτε όλο τον κατάλογο.</p>
      <div className="mt-7 flex flex-wrap justify-center gap-3">
        <Link href="/products" className={buttonClass({})}>Όλα τα προϊόντα</Link>
        <Link href="/contact" className={buttonClass({ variant: 'outline' })}>Επικοινωνία</Link>
      </div>
    </div>
  );
}
