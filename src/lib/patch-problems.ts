import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { settings } from '@/lib/db/schema';

/*
 * Data patches that failed at start-up, and the patches that wait for them (scripts/patches.ts). A failing patch no longer stops
 * the boot, so without this the only trace would be a log line: it is kept in the settings table for the dashboard checklist, the
 * way payment mails that were given up are, and removed again as soon as a start-up finds nothing failing or waiting.
 */

export const PATCH_PROBLEMS_KEY = 'dataPatchProblems';

export type PatchProblems = {
  failed: Array<{ id: string; error: string }>;
  waiting: Array<{ id: string; for: string[] }>;
  at: string;
};

/** Writes the current problems, or removes the record when there are none. */
export async function savePatchProblems(problems: { failed: PatchProblems['failed']; waiting: PatchProblems['waiting'] }): Promise<void> {
  if (problems.failed.length === 0 && problems.waiting.length === 0) {
    await db.delete(settings).where(eq(settings.key, PATCH_PROBLEMS_KEY));
    return;
  }
  const value: PatchProblems = { ...problems, at: new Date().toISOString() };
  await db.insert(settings).values({ key: PATCH_PROBLEMS_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export async function readPatchProblems(): Promise<PatchProblems | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, PATCH_PROBLEMS_KEY));
  const v = row?.value as Partial<PatchProblems> | undefined;
  if (!v || !Array.isArray(v.failed) || !Array.isArray(v.waiting)) return null;
  return { failed: v.failed, waiting: v.waiting, at: typeof v.at === 'string' ? v.at : '' };
}

/** The dashboard line: what failed, what waits for it, and what to do. */
export function describePatchProblems(problems: PatchProblems | null): { done: boolean; detail: string } {
  if (!problems) return { done: true, detail: 'Όλες οι ενημερώσεις δεδομένων που περίμεναν έχουν εφαρμοστεί.' };
  const failed = problems.failed.map((f) => `«${f.id}» (${f.error.slice(0, 160)})`).join(', ');
  const waiting = problems.waiting.map((w) => `«${w.id}»`).join(', ');
  return {
    done: false,
    detail: `${problems.failed.length ? `Η ενημέρωση δεδομένων ${failed} απέτυχε κατά την εκκίνηση. ` : ''}${waiting ? `Περιμένουν να εφαρμοστούν πρώτα οι προηγούμενες: ${waiting}. ` : ''}Θα ξαναγίνει προσπάθεια στην επόμενη εκκίνηση. Ενημερώστε τον προγραμματιστή.`,
  };
}
