/*
 * Deployment-level commerce switch, read on every call (never cached at import time).
 *
 *   COMMERCE_ENABLED=false   →  website only: no orders, no accounts, no payments, no matter what
 *                              Admin → Ρυθμίσεις says and no matter who is logged in.
 *   unset / anything else    →  commerce behaves exactly as the settings table dictates.
 *
 * The storefront's `ordersEnabled` toggle is a business setting the owner flips from the admin panel;
 * this flag is a deployment restriction for the catalogue-only launch, so a stray toggle (or a leaked
 * admin session) cannot turn the website into a shop. Deliberately dependency-free so that lib code,
 * route handlers and tests can import it without opening the database.
 */
export function commerceEnabled(): boolean {
  return process.env.COMMERCE_ENABLED !== 'false';
}

/**
 * Is the shop really taking online orders from the public? That needs the owner's «δέχεται online παραγγελίες» box
 * (`storefront.ordersEnabled`) AND the deployment switch above. Everything a visitor or a search engine can read that
 * depends on ordering being open — the sitemap, structured-data offers, the delivery sentences, the terms — asks this,
 * never the box alone: with COMMERCE_ENABLED=false the box does nothing.
 * Not for admin screens that edit or show the box itself, which need the stored value.
 */
export function ordersOpen(storefront: { ordersEnabled: boolean }): boolean {
  return storefront.ordersEnabled && commerceEnabled();
}
