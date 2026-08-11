import { CardHeader } from "@acme/ui";
import { PriceWidget } from "@acme/widgets";

// Both tags name a node of this graph and only one of them means it. `CardHeader` is imported from
// `@acme/ui`, which the corpus package.json declares a dependency on, so the local
// cards/CardHeader.tsx that shares its basename is a collision: the tag renders a package's
// component and this file is coupled to nothing here. Measured on marmelab/react-admin, where
// `@mui/material`'s Button sits beside a local Button.tsx, that shape was 189 of 2715 template
// edges, and no question about the name could see it — one node carries it, of the right kind, in
// one place.
//
// `PriceWidget` is the other half and the reason the manifests are read twice. `@acme/widgets` is a
// bare specifier that resolves to no file either, and it is this repository: browser/widgets declares
// that name. A rule that refused every bare specifier would take the workspace barrel with the
// vendor package and delete the edges this family exists for.
export function VendorCard() {
  return (
    <article>
      <CardHeader label="vendor" />
      <PriceWidget order={{ id: "1", total: { cents: 0, currency: "EUR" } }} onSelect={() => {}} />
    </article>
  );
}
