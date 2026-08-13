import { formatMoney } from "./money";

export function total(amounts: number[]): string {
  return formatMoney(amounts.reduce((sum, amount) => sum + amount, 0));
}

export const LABEL = "Order total";
