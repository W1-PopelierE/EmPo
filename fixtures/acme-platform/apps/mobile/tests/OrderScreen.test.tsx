import { OrderScreen } from "../src/screens/OrderScreen";

describe("OrderScreen", () => {
  it("renders the total", async () => {
    expect(await OrderScreen()).toBe("Total 12.50 EUR");
  });
});
