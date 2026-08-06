import { PriceWidget } from "../../browser/widgets/PriceWidget";

export function Badge({ order }) {
  return (
    <strong className="badge">
      <PriceWidget order={order} />
    </strong>
  );
}
