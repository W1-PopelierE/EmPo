import { OrderScreen } from "./OrderScreen";

describe("OrderScreen", () => {
  it("renders the total next to the badge", async () => {
    expect(await OrderScreen()).toBe("Total 12.50 EUR / Paid 12.50 EUR");
  });
});
