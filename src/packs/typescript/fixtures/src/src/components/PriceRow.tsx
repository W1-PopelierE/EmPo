import {
  formatMoney,
  type Money,
} from "../shared/money";

export function PriceRow(props: { total: Money }): string {
  return "Total " + formatMoney(props.total);
}
