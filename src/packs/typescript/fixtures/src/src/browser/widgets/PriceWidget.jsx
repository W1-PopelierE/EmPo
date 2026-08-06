import { formatMoney } from "../../shared/money";

export function PriceWidget({ order }) {
  return <span className="price">{formatMoney(order.total)}</span>;
}
