import { OrderList } from "../../cards/OrderList";

// The .jsx half of the producer's extension alternation. A React-Inertia repository mid-migration
// holds both dialects under one Pages/ directory, and dropping `jsx` from the pattern would leave
// this page producing nothing while the .tsx beside it still produced its key.
export default function Print() {
  return <OrderList>print</OrderList>;
}
