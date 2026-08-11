// Both names below are imported from `@acme/widgets`, the workspace package whose manifest sits at
// `src/browser/widgets/package.json`, and the two go opposite ways on purpose.
//
// `PriceRow` is carried by a node outside that package, `src/components/PriceRow.tsx`, spelled
// exactly, and by `src/browser/widgets/priceRow.jsx` only once case is set aside. The index alone
// answers the first, confidently and wrongly. The specifier says which package the name came from,
// that package's directory is known, and exactly one node under it carries the name, so the edge is
// redirected there. This is cal.com's `<Button />` from `@coss/ui`, in miniature.
//
// `OrderBadge` is the fall-through, and it is why the rule searches the named package rather than
// requiring the target to live in it. Nothing under `src/browser/widgets` carries that name, which
// is what a re-export barrel looks like from here: marmelab/react-admin's `packages/react-admin`
// re-exports `ra-ui-materialui` and `ra-core` and holds no component of its own. The search finds
// nothing, the question falls through untouched, and the edge lands on `src/components/OrderBadge.tsx`
// exactly as it did before this rule existed. Requiring containment would delete it instead.
import { OrderBadge, PriceRow } from "@acme/widgets";

export function WidgetShelf({ order }) {
  return (
    <div className="widget-shelf">
      <PriceRow order={order} />
      <OrderBadge total={order.total} />
    </div>
  );
}
