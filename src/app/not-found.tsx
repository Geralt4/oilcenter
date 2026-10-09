import StoreLayout from './(store)/layout';
import StoreNotFound from './(store)/not-found';

/*
 * An address that matches no route at all is answered here, outside every route group — which would mean the
 * framework's bare 404 with no header, search or footer. Wrapping the shop's own «Η σελίδα δεν βρέθηκε» in the
 * store layout gives a lost visitor the same page a missing product does.
 */
export default function NotFound() {
  return (
    <StoreLayout>
      <StoreNotFound />
    </StoreLayout>
  );
}
