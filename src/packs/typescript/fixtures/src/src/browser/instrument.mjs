import { reportTotal } from "./analytics.js";

export function instrument(order) {
  return reportTotal(order);
}
