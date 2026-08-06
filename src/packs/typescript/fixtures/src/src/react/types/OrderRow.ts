import type { Money } from "../../shared/money";

export interface OrderRow {
  id: string;
  total: Money;
}
