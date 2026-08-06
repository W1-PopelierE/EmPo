import { OrderScreenView } from "../../../screens/OrderScreenView";
import { Badge } from "../../cards/Badge";
import { OrderCard } from "../../cards/OrderCard";
import { OrderList } from "../../cards/OrderList";
import type { OrderRow } from "../../types/OrderRow";

export default function Index({ rows }: { rows: OrderRow[] }) {
  return (
    <OrderList>
      {rows.map((row) => (
        <OrderCard
          key={row.id}
          order={row}
        />
      ))}
      <Badge />
      <OrderScreenView />
    </OrderList>
  );
}
