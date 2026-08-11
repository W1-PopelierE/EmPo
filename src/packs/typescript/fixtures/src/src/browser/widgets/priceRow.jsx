// The `@acme/widgets` package's own price row, spelled the way half the React world spells a
// component file. `src/components/PriceRow.tsx` carries the exact name and this one carries only the
// fold, which is the shape the redirect below is about: a file importing `PriceRow` from
// `@acme/widgets` means this file, and every question the index can ask answers the other one.
export function PriceRow({ order }) {
  return <span className="widget-price-row">{order.total}</span>;
}
