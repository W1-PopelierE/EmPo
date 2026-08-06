import { formatMoney } from "../shared/money";

/*
The old screen rendered the row itself:
import { PriceRow } from "../components/PriceRow";
*/
export function OldOrderScreen(): string {
  // const { OrderBadge } = await import("../components/OrderBadge");
  return formatMoney({ cents: 0, currency: "EUR" });
}
