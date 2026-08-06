import { OrderRow } from "@acme/ui";
import { CardHeader } from "./CardHeader";

// Three refusals and one match in eight lines. `<OrderRow />` is a package's component, so its
// import resolves to no node and leaves no competing edge, while `src/react/types/OrderRow.ts`
// shares its basename: without `targetKinds` the tag would couple this file to a type module nobody
// rendered, and that invented edge would be the only thing the graph said about the pair.
// `<Total />` is the other order of the same two questions: two files carry that name, one a
// component and one a type module, and a `targetKinds` filter applied *before* the uniqueness test
// would leave a single candidate and resolve, which is a confident answer to a name this strategy
// cannot read. It resolves to nothing. `<CardHeader/>` is the self-closing form with no space
// before the slash, which is common and which a rule tightened to require the space would drop.
export function OrderRowList({ rows }: { rows: string[] }) {
  return (
    <ul>
      <CardHeader/>
      <Total amount={{ cents: 0, currency: "EUR" }} />
      {rows.map((row) => (
        <OrderRow key={row} label={row} />
      ))}
    </ul>
  );
}
