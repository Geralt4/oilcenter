'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { Banknote, CreditCard, Landmark, LoaderCircle, Lock, ShoppingCart, Store, Tag, Truck, X } from 'lucide-react';
import { checkCoupon, placeOrder } from '@/app/(store)/checkout/actions';
import { AvailabilityTag } from '@/components/store/availability';
import { syncCartWithServer } from '@/components/store/cart-drawer';
import { useStoreConfig } from '@/components/store/store-context';
import { buttonClass } from '@/components/ui/button';
import { cartSubtotalCents, cartWeightGrams, useCart, useHydrated } from '@/lib/cart-store';
import type { DocType, PaymentMethod, ShippingMethod } from '@/lib/db/schema';
import { availablePaymentMethods, computeTotals, PAYMENT_LABELS, type AppliedCoupon } from '@/lib/pricing';
import { cn, formatPrice } from '@/lib/utils';

export type CheckoutPrefill = Partial<Record<'email' | 'phone' | 'firstName' | 'lastName' | 'street' | 'city' | 'postalCode' | 'region', string>>;

const PAYMENT_META: Record<PaymentMethod, { icon: typeof Banknote; hint: string }> = {
  cod: { icon: Banknote, hint: 'Πληρώνετε στον courier κατά την παράδοση.' },
  pay_in_store: { icon: Store, hint: 'Πληρώνετε με μετρητά ή κάρτα όταν παραλάβετε.' },
  card: { icon: CreditCard, hint: 'Ασφαλής πληρωμή σε περιβάλλον τράπεζας. Δεν αποθηκεύουμε στοιχεία κάρτας.' },
  bank_transfer: { icon: Landmark, hint: 'Θα λάβετε τα στοιχεία του λογαριασμού με e-mail. Αποστολή μετά την επιβεβαίωση της κατάθεσης.' },
};

function Field({ label, name, error, className, optional, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; name: string; error?: string; optional?: boolean }) {
  return (
    <div className={className}>
      <label htmlFor={name} className="label">
        {label} {optional && <span className="font-normal text-ink-400">(προαιρετικό)</span>}
      </label>
      <input id={name} name={name} aria-invalid={Boolean(error)} aria-describedby={error ? `${name}-err` : undefined} className="field" {...props} />
      {error && <p id={`${name}-err`} className="mt-1.5 text-sm font-medium text-red-600">{error}</p>}
    </div>
  );
}

function Section({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-3xl border border-line bg-white p-5 shadow-tile sm:p-7">
      <h2 className="flex items-center gap-3 text-lg font-bold text-ink-950">
        <span className="tabular flex h-8 w-8 items-center justify-center rounded-full bg-ink-900 font-display text-base text-oil-400">{step}</span>
        {title}
      </h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function ChoiceCard({ checked, onSelect, icon: Icon, title, hint, aside, name, value }: { checked: boolean; onSelect: () => void; icon: typeof Banknote; title: string; hint: string; aside?: React.ReactNode; name: string; value: string }) {
  return (
    <label className={cn('flex cursor-pointer items-start gap-3.5 rounded-2xl border-2 p-4 transition-colors', checked ? 'border-ink-900 bg-ink-50' : 'border-ink-200 bg-white hover:border-ink-400')}>
      <input type="radio" name={name} value={value} checked={checked} onChange={onSelect} className="mt-1 h-[1.125rem] w-[1.125rem] shrink-0 cursor-pointer accent-ink-900" />
      <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', checked ? 'text-oil-700' : 'text-ink-400')} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="font-semibold text-ink-950">{title}</span>
          {aside && <span className="tabular shrink-0 text-sm font-semibold text-ink-900">{aside}</span>}
        </span>
        <span className="mt-0.5 block text-sm text-ink-600">{hint}</span>
      </span>
    </label>
  );
}

export function CheckoutForm({ prefill, pickupAddress }: { prefill: CheckoutPrefill; pickupAddress: string }) {
  const router = useRouter();
  const config = useStoreConfig();
  const hydrated = useHydrated();
  const { lines, setCoupon, clear } = useCart();
  const [pending, startTransition] = useTransition();

  const [form, setForm] = useState({
    email: prefill.email ?? '', phone: prefill.phone ?? '', firstName: prefill.firstName ?? '', lastName: prefill.lastName ?? '',
    street: prefill.street ?? '', city: prefill.city ?? '', postalCode: prefill.postalCode ?? '', region: prefill.region ?? '',
    notes: '', companyName: '', vatNumber: '', taxOffice: '', companyActivity: '', companyAddress: '',
  });
  const [shippingMethod, setShippingMethod] = useState<ShippingMethod>(config.shipping.courierEnabled ? 'courier' : 'pickup');
  const [chosenPayment, setPaymentMethod] = useState<PaymentMethod | null>(null);
  const [docType, setDocType] = useState<DocType>('receipt');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [coupon, setAppliedCoupon] = useState<AppliedCoupon | null>(null);
  const [couponInput, setCouponInput] = useState('');
  const [couponError, setCouponError] = useState<string | null>(null);
  const [couponBusy, setCouponBusy] = useState(false);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: '' }));
  };

  const paymentOptions = useMemo(() => availablePaymentMethods(shippingMethod, config.payments, config.cardProviderConfigured), [shippingMethod, config]);
  // Derived, not synced: switching courier ↔ pickup can invalidate the choice, so fall back to the first valid one.
  const paymentMethod = chosenPayment && paymentOptions.includes(chosenPayment) ? chosenPayment : (paymentOptions[0] ?? null);

  // Fresh prices / stock when the page opens, and re-validate a coupon remembered from the cart page.
  useEffect(() => {
    if (!hydrated) return;
    void syncCartWithServer(useCart.getState().lines);
    const remembered = useCart.getState().couponCode;
    if (remembered) void applyCoupon(remembered);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  const payload = () => lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity }));

  async function applyCoupon(code: string) {
    setCouponBusy(true);
    setCouponError(null);
    const result = await checkCoupon(code, useCart.getState().lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })));
    setCouponBusy(false);
    if (result.coupon) {
      setAppliedCoupon(result.coupon);
      setCoupon(result.coupon.code);
      setCouponInput('');
    } else {
      setAppliedCoupon(null);
      setCoupon(null);
      setCouponError(result.error);
    }
  }

  const subtotal = cartSubtotalCents(lines);
  const weight = cartWeightGrams(lines);
  const totals = computeTotals({ subtotalCents: subtotal, weightGrams: weight, shippingMethod, paymentMethod, coupon, shipping: config.shipping, vatRate: config.vatRate });
  const courierTotals = computeTotals({ subtotalCents: subtotal, weightGrams: weight, shippingMethod: 'courier', paymentMethod: null, coupon, shipping: config.shipping, vatRate: config.vatRate });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!paymentMethod) return;
    setFormError(null);
    startTransition(async () => {
      const result = await placeOrder({ ...form, lines: payload(), couponCode: coupon?.code, shippingMethod, paymentMethod, docType, acceptTerms });
      if (result.ok) {
        clear();
        if (result.external) window.location.assign(result.redirectUrl);
        else router.push(result.redirectUrl);
        return;
      }
      setErrors(result.fieldErrors ?? {});
      setFormError(result.message);
      if (result.cartChanged) await syncCartWithServer(useCart.getState().lines);
      const firstBad = Object.keys(result.fieldErrors ?? {})[0];
      (firstBad ? document.getElementById(firstBad) : document.getElementById('checkout-error'))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  if (!hydrated) return <div className="flex min-h-[40vh] items-center justify-center"><LoaderCircle className="h-7 w-7 animate-spin text-ink-300" /></div>;

  if (lines.length === 0) {
    return (
      <div className="mx-auto max-w-md rounded-3xl border border-dashed border-ink-200 bg-white px-6 py-16 text-center">
        <ShoppingCart className="mx-auto h-10 w-10 text-ink-300" />
        <h2 className="display mt-4 text-2xl">Το καλάθι σας είναι άδειο</h2>
        <p className="mt-2 text-ink-600">Προσθέστε προϊόντα για να ολοκληρώσετε μια παραγγελία.</p>
        <Link href="/products" className={buttonClass({ variant: 'dark', className: 'mt-6' })}>Δείτε τα προϊόντα</Link>
      </div>
    );
  }

  const submitLabel = paymentMethod === 'card' ? 'Συνέχεια στην πληρωμή' : 'Ολοκλήρωση παραγγελίας';

  return (
    <form onSubmit={submit} noValidate className="grid gap-6 lg:grid-cols-[1fr_24rem] lg:items-start lg:gap-8">
      <div className="space-y-5">
        {formError && (
          <div id="checkout-error" role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">{formError}</div>
        )}

        <Section step={1} title="Στοιχεία επικοινωνίας">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Όνομα" name="firstName" value={form.firstName} onChange={set('firstName')} error={errors.firstName} autoComplete="given-name" required />
            <Field label="Επώνυμο" name="lastName" value={form.lastName} onChange={set('lastName')} error={errors.lastName} autoComplete="family-name" required />
            <Field label="E-mail" name="email" type="email" inputMode="email" value={form.email} onChange={set('email')} error={errors.email} autoComplete="email" required />
            <Field label="Κινητό τηλέφωνο" name="phone" type="tel" inputMode="tel" value={form.phone} onChange={set('phone')} error={errors.phone} autoComplete="tel" placeholder="69…" required />
          </div>
        </Section>

        <Section step={2} title="Τρόπος παραλαβής">
          <div className="grid gap-3">
            {config.shipping.courierEnabled && (
              <ChoiceCard name="shippingMethod" value="courier" checked={shippingMethod === 'courier'} onSelect={() => setShippingMethod('courier')} icon={Truck} title={`Αποστολή με ${config.shipping.carrierName}`} hint={`Παράδοση στον χώρο σας σε ${config.shipping.deliveryEstimate}.`} aside={courierTotals.freeShipping ? 'Δωρεάν' : formatPrice(courierTotals.shippingCents)} />
            )}
            {config.shipping.pickupEnabled && (
              <ChoiceCard name="shippingMethod" value="pickup" checked={shippingMethod === 'pickup'} onSelect={() => setShippingMethod('pickup')} icon={Store} title="Παραλαβή από το κατάστημα" hint={`${pickupAddress}. Θα σας ειδοποιήσουμε μόλις είναι έτοιμη.`} aside="Δωρεάν" />
            )}
          </div>

          {shippingMethod === 'courier' && (
            <div className="mt-5 grid gap-4 sm:grid-cols-6">
              <Field className="sm:col-span-6" label="Οδός & αριθμός" name="street" value={form.street} onChange={set('street')} error={errors.street} autoComplete="street-address" required />
              <Field className="sm:col-span-3" label="Πόλη / περιοχή" name="city" value={form.city} onChange={set('city')} error={errors.city} autoComplete="address-level2" required />
              <Field className="sm:col-span-1" label="Τ.Κ." name="postalCode" inputMode="numeric" value={form.postalCode} onChange={set('postalCode')} error={errors.postalCode} autoComplete="postal-code" maxLength={6} required />
              <Field className="sm:col-span-2" label="Νομός" name="region" value={form.region} onChange={set('region')} autoComplete="address-level1" optional />
            </div>
          )}
        </Section>

        <Section step={3} title="Τρόπος πληρωμής">
          {paymentOptions.length === 0 ? (
            <p className="text-sm text-red-700">Δεν υπάρχει διαθέσιμος τρόπος πληρωμής για αυτή την επιλογή. Καλέστε μας στο {config.phone}.</p>
          ) : (
            <div className="grid gap-3">
              {paymentOptions.map((m) => (
                <ChoiceCard key={m} name="paymentMethod" value={m} checked={paymentMethod === m} onSelect={() => setPaymentMethod(m)} icon={PAYMENT_META[m].icon} title={PAYMENT_LABELS[m]} hint={PAYMENT_META[m].hint} aside={m === 'cod' && config.shipping.codFeeCents > 0 ? `+${formatPrice(config.shipping.codFeeCents)}` : undefined} />
              ))}
            </div>
          )}
        </Section>

        <Section step={4} title="Παραστατικό & σχόλια">
          <div className="grid grid-cols-2 gap-2 rounded-2xl bg-ink-100 p-1">
            {(['receipt', 'invoice'] as const).map((d) => (
              <button key={d} type="button" onClick={() => setDocType(d)} aria-pressed={docType === d} className={cn('h-11 cursor-pointer rounded-xl text-sm font-semibold transition-colors', docType === d ? 'bg-white text-ink-950 shadow-sm' : 'text-ink-600 hover:text-ink-900')}>
                {d === 'receipt' ? 'Απόδειξη' : 'Τιμολόγιο'}
              </button>
            ))}
          </div>

          {docType === 'invoice' && (
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Field className="sm:col-span-2" label="Επωνυμία" name="companyName" value={form.companyName} onChange={set('companyName')} error={errors.companyName} autoComplete="organization" required />
              <Field label="ΑΦΜ" name="vatNumber" inputMode="numeric" maxLength={9} value={form.vatNumber} onChange={set('vatNumber')} error={errors.vatNumber} required />
              <Field label="ΔΟΥ" name="taxOffice" value={form.taxOffice} onChange={set('taxOffice')} error={errors.taxOffice} required />
              <Field label="Δραστηριότητα" name="companyActivity" value={form.companyActivity} onChange={set('companyActivity')} error={errors.companyActivity} required />
              <Field label="Έδρα" name="companyAddress" value={form.companyAddress} onChange={set('companyAddress')} optional />
            </div>
          )}

          <div className="mt-5">
            <label htmlFor="notes" className="label">Σχόλια παραγγελίας <span className="font-normal text-ink-400">(προαιρετικό)</span></label>
            <textarea id="notes" name="notes" rows={3} value={form.notes} onChange={set('notes')} maxLength={1000} placeholder="π.χ. μοντέλο & έτος οχήματος, ώρες παράδοσης…" className="field resize-y" />
          </div>
        </Section>
      </div>

      {/* ── Summary ── */}
      <aside className="lg:sticky lg:top-44" aria-label="Σύνοψη παραγγελίας">
        <div className="rounded-3xl border border-line bg-white p-5 shadow-tile sm:p-6">
          <h2 className="display text-2xl">Η παραγγελία σας</h2>
          <ul className="mt-4 max-h-72 divide-y divide-line overflow-y-auto">
            {lines.map((l) => (
              <li key={l.variantId} className="flex gap-3 py-3">
                <span className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-line bg-white">
                  {l.snapshot.imageUrl && <Image src={l.snapshot.imageUrl} alt="" fill sizes="56px" className="object-contain p-1" />}
                  <span className="tabular absolute -top-0 -right-0 flex h-5 min-w-5 items-center justify-center rounded-bl-lg bg-ink-900 px-1 text-[0.6875rem] font-bold text-white">{l.quantity}</span>
                </span>
                <span className="min-w-0 flex-1 text-sm">
                  <span className="line-clamp-2 font-semibold text-ink-900">{[l.snapshot.brandName, l.snapshot.name].filter(Boolean).join(' ')}</span>
                  <span className="text-ink-500">{l.snapshot.variantLabel}</span>
                  <AvailabilityTag availability={l.snapshot.availability} className="ml-2" />
                </span>
                <span className="tabular shrink-0 text-sm font-semibold text-ink-900">{formatPrice(l.quantity * l.snapshot.unitPriceCents)}</span>
              </li>
            ))}
          </ul>
          {lines.some((l) => l.snapshot.availability && l.snapshot.availability !== 'in_stock') && (
            <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-950">Κάποια προϊόντα δεν είναι άμεσα διαθέσιμα, οπότε η παραγγελία θα χρειαστεί περισσότερο χρόνο. Θα επικοινωνήσουμε μαζί σας για την ημερομηνία.</p>
          )}
          <Link href="/cart" className="mt-1 inline-block text-sm font-semibold text-petrol-500 hover:text-petrol-700">Αλλαγή καλαθιού</Link>

          <div className="mt-5 border-t border-line pt-5">
            {coupon ? (
              <p className="flex items-center justify-between gap-2 rounded-xl bg-emerald-50 px-3 py-2.5 text-sm font-semibold text-emerald-800">
                <span className="flex items-center gap-2"><Tag className="h-4 w-4" />{coupon.code}</span>
                <button type="button" onClick={() => { setAppliedCoupon(null); setCoupon(null); }} aria-label="Αφαίρεση κουπονιού" className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg hover:bg-emerald-100"><X className="h-4 w-4" /></button>
              </p>
            ) : (
              <>
                <div className="flex gap-2">
                  <input value={couponInput} onChange={(e) => setCouponInput(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (couponInput.trim()) void applyCoupon(couponInput); } }} placeholder="Κουπόνι έκπτωσης" aria-label="Κουπόνι έκπτωσης" className="field h-11 min-w-0 uppercase placeholder:normal-case" />
                  <button type="button" disabled={couponBusy || !couponInput.trim()} onClick={() => void applyCoupon(couponInput)} className={buttonClass({ variant: 'outline', className: 'shrink-0' })}>{couponBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : 'Εφαρμογή'}</button>
                </div>
                {couponError && <p className="mt-1.5 text-sm font-medium text-red-600">{couponError}</p>}
              </>
            )}
          </div>

          <dl className="mt-5 space-y-2 border-t border-line pt-5 text-[0.9375rem]">
            <div className="flex justify-between"><dt className="text-ink-600">Υποσύνολο</dt><dd className="tabular font-medium">{formatPrice(totals.subtotalCents)}</dd></div>
            {totals.discountCents > 0 && <div className="flex justify-between text-emerald-700"><dt>Έκπτωση</dt><dd className="tabular font-medium">−{formatPrice(totals.discountCents)}</dd></div>}
            <div className="flex justify-between"><dt className="text-ink-600">Μεταφορικά</dt><dd className="tabular font-medium">{shippingMethod === 'pickup' ? 'Παραλαβή' : totals.freeShipping ? 'Δωρεάν' : formatPrice(totals.shippingCents)}</dd></div>
            {totals.codFeeCents > 0 && <div className="flex justify-between"><dt className="text-ink-600">Αντικαταβολή</dt><dd className="tabular font-medium">{formatPrice(totals.codFeeCents)}</dd></div>}
            <div className="flex items-baseline justify-between border-t border-line pt-3"><dt className="font-bold text-ink-950">Σύνολο</dt><dd className="tabular text-2xl font-bold text-ink-950">{formatPrice(totals.totalCents)}</dd></div>
            <div className="flex justify-between text-xs text-ink-500"><dt>Περιλαμβάνεται ΦΠΑ {config.vatRate}%</dt><dd className="tabular">{formatPrice(totals.vatCents)}</dd></div>
          </dl>

          <label className="mt-5 flex cursor-pointer items-start gap-2.5 text-sm text-ink-700">
            <input id="acceptTerms" type="checkbox" checked={acceptTerms} onChange={(e) => setAcceptTerms(e.target.checked)} aria-invalid={Boolean(errors.acceptTerms)} className="mt-0.5 h-[1.125rem] w-[1.125rem] shrink-0 cursor-pointer accent-ink-900" />
            <span>Αποδέχομαι τους <Link href="/terms" target="_blank" className="font-semibold text-petrol-500 underline underline-offset-2">όρους χρήσης</Link> και την <Link href="/privacy" target="_blank" className="font-semibold text-petrol-500 underline underline-offset-2">πολιτική απορρήτου</Link>.</span>
          </label>
          {errors.acceptTerms && <p className="mt-1.5 text-sm font-medium text-red-600">{errors.acceptTerms}</p>}

          <button type="submit" disabled={pending || !paymentMethod} className={buttonClass({ size: 'lg', full: true, className: 'mt-5' })}>
            {pending ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <Lock className="h-4 w-4" />}
            {pending ? 'Καταχώρηση…' : submitLabel}
          </button>
          {config.demoMode && <p className="mt-3 text-center text-xs font-medium text-petrol-500">Δοκιμαστική λειτουργία: η παραγγελία θα καταχωρηθεί ως δοκιμαστική.</p>}
        </div>
      </aside>
    </form>
  );
}
