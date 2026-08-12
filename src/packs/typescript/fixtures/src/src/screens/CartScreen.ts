// A side-effect import: no clause, no `from`, and the handlers it registers are what the rest of
// this screen leans on. Double quotes here, single quotes in instrument.mjs, so both spellings are
// in the corpus.
import "../shared/register-handlers";
import CartPanel from "../components/CartPanel.vue";
import { fetchOrder } from "../api/orders";

export async function CartScreen(): Promise<unknown> {
  await fetchOrder("42");

  return CartPanel;
}
