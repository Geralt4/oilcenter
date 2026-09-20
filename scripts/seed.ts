import './env';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { count, eq } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { adminUsers, brands, categories, coupons, productImages, products, variants, type BaseType } from '../src/lib/db/schema';
import { hashPassword } from '../src/lib/auth/password';
import { loadSkroutzPrices } from './skroutz-prices';

/*
 * Loads catalog/catalog.json into an empty database and creates the first admin user.
 *   npm run db:seed            refuses to run if products already exist
 *   npm run db:seed -- --force wipes the CATALOGUE tables first (orders and customers are never touched)
 */

type CatalogFile = {
  brands: Array<{ name: string; slug: string; country: string; featured?: boolean; sort: number; description: string }>;
  categories: Array<{ slug: string; name: string; parent?: string; icon: string; description: string }>;
  products: Array<{
    slug: string; name: string; brand: string; category: string; viscosity: string | null; baseType: string | null; specs: string[];
    shortDescription: string; description: string; featured: boolean; internalNotes: string | null; searchText: string; images: string[];
    variants: Array<{ sku: string; label: string; volumeMl: number | null; priceCents: number; weightGrams: number; image: string }>;
  }>;
};

async function main() {
  const force = process.argv.includes('--force');
  const catalog = JSON.parse(readFileSync(path.resolve('catalog/catalog.json'), 'utf8')) as CatalogFile;

  const [{ n: existing }] = await db.select({ n: count() }).from(products);
  if (existing > 0 && !force) {
    console.log(`Database already has ${existing} products — skipping catalogue seed (use --force to replace it).`);
  } else {
    if (existing > 0) {
      console.log('Replacing catalogue…');
      await db.delete(variants);
      await db.delete(productImages);
      await db.delete(products);
      await db.delete(categories);
      await db.delete(brands);
    }

    const brandId = new Map<string, number>();
    for (const b of catalog.brands) {
      const [row] = await db
        .insert(brands)
        .values({ slug: b.slug, name: b.name, country: b.country || null, description: b.description || null, isFeatured: Boolean(b.featured), sort: b.sort })
        .returning({ id: brands.id });
      brandId.set(b.slug, row.id);
    }

    // parents are listed before their children in catalog.json
    const categoryId = new Map<string, number>();
    for (const [i, c] of catalog.categories.entries()) {
      const [row] = await db
        .insert(categories)
        .values({ slug: c.slug, name: c.name, parentId: c.parent ? (categoryId.get(c.parent) ?? null) : null, icon: c.icon, description: c.description, sort: i })
        .returning({ id: categories.id });
      categoryId.set(c.slug, row.id);
    }

    // Real prices for the SKUs the shop also lists on Skroutz; everything else keeps its placeholder and stays unverified.
    const skroutz = loadSkroutzPrices();
    let variantCount = 0;
    for (const p of catalog.products) {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(products)
          .values({
            slug: p.slug,
            name: p.name,
            brandId: brandId.get(p.brand) ?? null,
            categoryId: categoryId.get(p.category) ?? null,
            shortDescription: p.shortDescription,
            description: p.description,
            viscosity: p.viscosity,
            baseType: (p.baseType as BaseType | null) ?? null,
            specs: p.specs,
            searchText: p.searchText,
            isFeatured: p.featured,
            internalNotes: p.internalNotes,
          })
          .returning({ id: products.id });

        await tx.insert(productImages).values(p.images.map((url, sort) => ({ productId: row.id, url, alt: p.name, sort })));
        await tx.insert(variants).values(
          p.variants.map((v, sort) => ({
            productId: row.id,
            sku: v.sku,
            label: v.label,
            volumeMl: v.volumeMl,
            priceCents: skroutz.get(v.sku)?.priceCents ?? v.priceCents,
            weightGrams: v.weightGrams,
            imageUrl: v.image,
            // The shop has no stock counts in the system yet: sell freely until the owner opts a variant into tracking.
            trackStock: false,
            stock: 0,
            priceVerified: skroutz.get(v.sku)?.confidence === 'exact',
            sort,
          })),
        );
        variantCount += p.variants.length;
      });
    }
    console.log(`Seeded ${catalog.brands.length} brands, ${catalog.categories.length} categories, ${catalog.products.length} products, ${variantCount} variants.`);

    // An example coupon so the feature can be demonstrated. Inactive on purpose: enable it from /admin/coupons.
    await db
      .insert(coupons)
      .values({ code: 'WELCOME5', type: 'percent', value: 5, minSubtotalCents: 3000, isActive: false })
      .onConflictDoNothing();
  }

  // First admin
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) {
    console.log('ADMIN_EMAIL / ADMIN_PASSWORD not set — no admin user created. Run `npm run admin:create` later.');
  } else {
    const [found] = await db.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, email));
    if (found) console.log(`Admin ${email} already exists.`);
    else {
      await db.insert(adminUsers).values({ email, passwordHash: await hashPassword(password), name: 'Διαχειριστής' });
      console.log(`Admin user created: ${email} (password = the ADMIN_PASSWORD environment variable)`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
