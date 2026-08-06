// The browser-side behaviour layer: plain JavaScript, no build step, loaded by a script tag.
// A tree like this one was invisible while match.extensions named only .ts, .tsx and .vue.
import { formatMoney } from "../shared/money";
import { trackOrder } from "./tracker.js";

export function reportTotal(order) {
  trackOrder(order.id);

  return formatMoney(order.total);
}
