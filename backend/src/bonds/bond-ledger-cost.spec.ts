import { acquisitionCostText } from "./bond-ledger";

const row = (action: string, total_amount: string | null) => ({
  action,
  total_amount,
});

describe("acquisitionCostText", () => {
  it("is the total amount of a purchase as exact text", () => {
    expect(acquisitionCostText(row("BUY", "9783.3700"))).toBe("9783.3700");
    expect(acquisitionCostText(row("REINVEST", "50.5"))).toBe("50.5000");
  });

  it("is unknown for a row with no price of its own or no usable amount", () => {
    expect(acquisitionCostText(row("ADD_SHARES", "100.0000"))).toBeNull();
    expect(acquisitionCostText(row("TRANSFER_IN", "100.0000"))).toBeNull();
    expect(acquisitionCostText(row("BUY", null))).toBeNull();
    expect(acquisitionCostText(row("BUY", "0.0000"))).toBeNull();
    expect(acquisitionCostText(row("BUY", "abc"))).toBeNull();
  });
});
