import { formatMoney, type Money } from "../shared/money";

export function OrderBadge(props: { total: Money }): string {
  return "Paid " + formatMoney(props.total);
}
