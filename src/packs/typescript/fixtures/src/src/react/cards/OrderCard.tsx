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
      <p>{formatMoney(order.total)}</p>
    </article>
  );
}
