import { Spinner } from "@acme/ui";
import { PriceWidget } from "../../browser/widgets/PriceWidget";
import { formatMoney } from "../../shared/money";
import type { OrderRow } from "../types/OrderRow";
import { CardHeader } from "./CardHeader";

// Array<OrderRow> is a type argument and not a rendered tag, and OrderRow is a node of this graph.
// A rule that read every <Name> would give this file a template edge to a file it renders nothing
// of, so both tag rules require a closing tag or a self-closing one, and this line is what says so
// in data rather than in prose.
const rows: Array<OrderRow> = [];

export function OrderCard({ order }: { order: OrderRow }) {
  return (
    <article className="order-card" data-rows={rows.length}>
      <CardHeader.Title>Order {order.id}</CardHeader.Title>
      <PriceWidget order={order} onSelect={() => rows.push(order)} />
      {/* The fourth verdict, and the only one the rest of this corpus never reached: `Spinner` is
          carried by no node at all, so the tag is refused before ambiguity or `targetKinds` is
          consulted. It is the ordinary cost of reading a language whose vendor components are
          spelled exactly like local ones, it must stay separate from the ambiguous count in the
          name tally, and a corpus that never produced one left that separation ungated. */}
      <Spinner />
      <p>{formatMoney(order.total)}</p>
    </article>
  );
}
