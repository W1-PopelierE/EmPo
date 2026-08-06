// A .tsx holding both shapes the tag rules have to tell apart, in one file, because the pathGlob
// cannot help here: this file is exactly the kind of file those rules are supposed to read.
//
// `<OrderCard />` below is rendered and must stay an edge. The two component names inside the
// `examples` strings are prose about components — a docs constant, an error message, a codegen
// template — and must not become edges to files this module neither imports nor renders. The tag
// rules declare `maskStrings`, so the string contents are blanked before they run.
//
// OrderList is the sharper of the two: registry.ts already pins that a .ts file cannot reach it,
// and this file is the .tsx that could. Drop `maskStrings` from the pack's template rules and this
// file couples to OrderList.tsx and to OrderScreenView.tsx, and coverage travels along every
// non-bridge edge, so a test touching this module would start reaching both.
import { OrderCard } from "./OrderCard";

export const examples = {
  list: "<OrderList>rows</OrderList>",
  screen: "<OrderScreenView />",
};

export function CardDocs() {
  return <OrderCard />;
}
