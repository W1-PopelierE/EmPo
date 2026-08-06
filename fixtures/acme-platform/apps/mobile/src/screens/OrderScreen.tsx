import { createOrder, fetchOrder } from "../api/client";
import { PriceRow } from "../components/PriceRow";

export async function OrderScreen(): Promise<string> {
  const total = { cents: 1250, currency: "EUR" };

  await createOrder();
  await fetchOrder("42");

  return PriceRow({ total });
}
