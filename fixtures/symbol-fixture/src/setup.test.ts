import { total } from "./total";

if (total([100, 250]) !== "3.50") {
  throw new Error("total does not add up");
}
