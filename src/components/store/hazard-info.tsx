import Link from 'next/link';
import { FileText, TriangleAlert } from 'lucide-react';
import { GHS_PICTOGRAMS, SIGNAL_WORDS, parseStatement, publicHazard, type HazardInfo as Hazard } from '@/lib/ghs';

/*
 * The pack's hazard labelling, repeated where the customer decides to buy (lib/ghs.ts explains why and the rules).
 * Only data the owner has checked against the pack is ever shown; without it the page just says that the safety
 * data sheet is available on request.
 */
function Statements({ title, lines }: { title: string; lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div>
      <h3 className="eyebrow text-ink-500">{title}</h3>
      <ul className="mt-2 space-y-1.5 text-[0.9375rem] leading-relaxed text-ink-800">
        {lines.map((line) => {
          const s = parseStatement(line);
          return (
            <li key={line}>
              {s.text ?? s.code}
              {s.code && s.text && <span className="tabular ml-1.5 text-xs text-ink-400">({s.code})</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SdsLink({ url }: { url: string }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 font-semibold text-petrol-500 underline underline-offset-2 hover:text-petrol-700">
      <FileText className="h-4 w-4 shrink-0" />
      Δελτίο δεδομένων ασφαλείας (SDS)
    </a>
  );
}

export function HazardInfo({ hazard }: { hazard: Hazard | null | undefined }) {
  const h = publicHazard(hazard);

  if (!h || h.none) {
    return (
      <p className="mt-10 text-sm text-ink-500">
        {h?.sdsUrl ? <SdsLink url={h.sdsUrl} /> : <>Δελτίο δεδομένων ασφαλείας (SDS): διαθέσιμο κατόπιν αιτήματος — <Link href="/contact" className="font-medium text-petrol-500 underline underline-offset-2 hover:text-petrol-700">επικοινωνήστε μαζί μας</Link>.</>}
      </p>
    );
  }

  return (
    <section aria-labelledby="hazard" className="mt-14 rounded-3xl border border-line bg-white p-6 shadow-tile sm:p-8">
      <h2 id="hazard" className="display flex items-center gap-2.5 text-2xl sm:text-3xl">
        <TriangleAlert className="h-6 w-6 shrink-0 text-red-600" />
        Σήμανση κινδύνου
      </h2>
      <p className="mt-2 text-sm text-ink-500">Όπως αναγράφεται στην ετικέτα της συσκευασίας. Διαβάστε την πριν από τη χρήση.</p>

      {(h.pictograms?.length || h.signalWord) && (
        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
          {h.pictograms && h.pictograms.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {h.pictograms.map((code) => (
                <li key={code}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- fixed-size static symbol, nothing for the image optimiser to do */}
                  <img src={`/ghs/${code}.svg`} alt={`${GHS_PICTOGRAMS[code].symbol} (${GHS_PICTOGRAMS[code].meaning})`} title={GHS_PICTOGRAMS[code].meaning} width={72} height={72} className="h-[4.5rem] w-[4.5rem]" />
                </li>
              ))}
            </ul>
          )}
          {h.signalWord && <p className="text-2xl font-bold tracking-tight text-ink-950">{SIGNAL_WORDS[h.signalWord]}</p>}
        </div>
      )}

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <Statements title="Δηλώσεις επικινδυνότητας" lines={h.statements ?? []} />
        <Statements title="Δηλώσεις προφύλαξης" lines={h.precautions ?? []} />
      </div>

      {h.sdsUrl && <p className="mt-6 text-sm"><SdsLink url={h.sdsUrl} /></p>}
    </section>
  );
}
