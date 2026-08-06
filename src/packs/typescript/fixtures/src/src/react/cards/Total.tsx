import { formatMoney } from "../../shared/money";
import type { Total as TotalValue } from "../types/Total";

export function Total({ amount }: { amount: TotalValue }) {
  return <strong className="total">{formatMoney(amount)}</strong>;
}
