import { notFound } from 'next/navigation';
import { asc, eq } from 'drizzle-orm';
import { ProductEditor } from '@/components/admin/product-editor';
import { db } from '@/lib/db';
import { productImages, products, variants } from '@/lib/db/schema';

export const metadata = { title: 'Επεξεργασία προϊόντος' };

export default async function AdminProductPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const [{ id: raw }, sp] = await Promise.all([params, searchParams]);
  if (raw === 'new') return <ProductEditor />;

  const id = Number(raw);
  if (!Number.isInteger(id)) notFound();
  const product = await db.query.products.findFirst({
    where: eq(products.id, id),
    with: { images: { orderBy: [asc(productImages.sort), asc(productImages.id)] }, variants: { orderBy: [asc(variants.sort), asc(variants.id)] } },
  });
  if (!product) notFound();
  return <ProductEditor product={product} created={sp.created === '1'} />;
}
