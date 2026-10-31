import { refundShares } from "./shared-refund";

describe("refunds of accepted allocations (SE-009)", () => {
  it("returns the last stored cent after repeated partial refunds", () => {
    const source = [
      { participantId: "a", originalAmount: "0.03", groupAmount: "0.01" },
    ];
    const request = [{ participantId: "a", amount: "0.01" }];
    const first = refundShares(source, [], request, 2);
    const second = refundShares(source, first.shares, request, 2);
    const third = refundShares(
      source,
      [...first.shares, ...second.shares],
      request,
      2,
    );
    expect([first.amount, second.amount, third.amount]).toEqual([
      "0.0000",
      "0.0100",
      "0.0000",
    ]);
    expect(() =>
      refundShares(
        source,
        [...first.shares, ...second.shares, ...third.shares],
        request,
        2,
      ),
    ).toThrow();
  });

  it("reverses a source's allocated base share rather than independently converting cents", () => {
    expect(
      refundShares(
        [
          { participantId: "a", originalAmount: "0.01", groupAmount: "0.01" },
          { participantId: "b", originalAmount: "0.01", groupAmount: "0.00" },
        ],
        [],
        [{ participantId: "a", amount: "0.01" }],
        2,
      ),
    ).toMatchObject({ amount: "0.0100" });
  });

  it("refuses a foreign participant or a source reduced below its earlier refund", () => {
    const source = [
      { participantId: "a", originalAmount: "10", groupAmount: "43" },
    ];
    expect(() =>
      refundShares(source, [], [{ participantId: "b", amount: "1" }], 2),
    ).toThrow();
    expect(() =>
      refundShares(
        source,
        [{ participantId: "a", originalAmount: "11", groupAmount: "44" }],
        [{ participantId: "a", amount: "0" }],
        2,
      ),
    ).toThrow();
  });
});
