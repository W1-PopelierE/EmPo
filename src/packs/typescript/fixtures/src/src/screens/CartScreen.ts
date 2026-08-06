import CartPanel from "../components/CartPanel.vue";
import { fetchOrder } from "../api/orders";

export async function CartScreen(): Promise<unknown> {
  await fetchOrder("42");

  return CartPanel;
}
