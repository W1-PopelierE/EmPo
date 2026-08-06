import type { OrderRow } from "../types/OrderRow";
import { CardHeader } from "./CardHeader";

/*
The list used to render a card itself, before the page composed the two:
  <OrderCard />
*/
export function OrderList({ children }: { children: unknown }) {
  return (
    <section className="order-list">
      <CardHeader<OrderRow> label="rows" />
      {children}
    </section>
  );
}
