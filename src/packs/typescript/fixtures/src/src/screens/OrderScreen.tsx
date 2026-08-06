import React from "react";
import { PriceRow } from "../components";
import { createOrder, fetchOrder } from "../api/orders";

export async function OrderScreen(): Promise<string> {
  const { OrderBadge } = await import("../components/OrderBadge");
  const total = { cents: 1250, currency: "EUR" };

  await createOrder(total);
  await fetchOrder("42");

  return PriceRow({ total }) + " / " + OrderBadge({ total });
}
