import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

type Reader = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const PRODUCT_HAS_HISTORY = 'Το προϊόν έχει ιστορικό παραγγελιών ή τιμών και δεν διαγράφεται. Απενεργοποιήστε το για να μην εμφανίζεται στο κατάστημα.';

/**
 * True when deleting the product would take history with it: a past order line that points at the product or at any of its sizes,
 * or a logged price change of any of its sizes. Archived sizes count too (they exist only because they have history).
 * order_items has no foreign keys, so both of its columns are checked; price_changes would be removed with the sizes (cascade).
 */
export async function productHasHistory(productId: number, reader: Reader = db): Promise<boolean> {
  const rows = await reader.all<{ n: number }>(sql`
    SELECT 1 AS n FROM order_items WHERE product_id = ${productId}
    UNION ALL SELECT 1 FROM order_items WHERE variant_id IN (SELECT id FROM variants WHERE product_id = ${productId})
    UNION ALL SELECT 1 FROM price_changes WHERE variant_id IN (SELECT id FROM variants WHERE product_id = ${productId})
    LIMIT 1`);
  return rows.length > 0;
}
