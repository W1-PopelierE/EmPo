import { PriceRow } from "../components/PriceRow";

// A .tsx that really renders, sitting under a role directory. Its kind is `screen` and not
// `component`, which is what says the React rule is ordered behind the role globs rather than
// ahead of them: move that rule to the top of kindRules and this file changes kind.
export function OrderScreenView() {
  return <PriceRow total={{ cents: 0, currency: "EUR" }} />;
}
